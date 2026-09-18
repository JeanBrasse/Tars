# Security notes

What Tars defends against, what it does not, and which of the two a given
change is. Measured, dated, and written down when the measurement says a
defence is not one: a lid that reads like a boundary is worse than an open door
nobody mistook for closed.

Everything here was measured on Noah's machine, macOS 26.6.1 (Darwin 25.6.0),
on `main` at `b17db0f`, between the 17th and the 18th of September 2026.

---

## 1. The threat this app actually has

One user account. One person. Every agent Tars starts runs as that person, with
that person's shell, that person's keychain and that person's files. Nothing in
the API, in a file mode or in a `--add-dir` flag changes that, because none of
them is enforced against a process that simply opens the file.

So there are two different questions, and they are answered in two different
places:

- **Which agent is this, and may it do that?** A question about mistakes and
  about crossing wires: an orchestrator picking the wrong id out of a global
  listing, an MCP client that started without a token, a browser tab reaching
  `127.0.0.1`. This is answerable, and the local API answers it.
- **Can agent A obtain what agent B holds?** A question about isolation. On one
  user account, with no sandbox, the answer is yes, always, whatever the API
  does. It is not answerable by a check in a route.

Confusing the two is how a defence becomes theatre. The rest of this file keeps
them apart.

---

## 2. What the local API decides (and what it cannot)

Since the identity work of 1.7.x an agent is named by the token Tars minted for
its process, never by a header. Since 1.7.6 the routes that **drive** an agent
(start, dispatch, run-task, stop, message, delete, and create) refuse a caller
that is nobody:

| Credential | Who it is | What it opens |
|---|---|---|
| An agent's token (`CLAUDE_MGR_API_TOKEN`, minted in memory per terminal and per ACP run) | that agent | its own project's agents; another project's only with `allowCrossProject` |
| Tars's own pass (minted in memory, written nowhere) | the main process | everything: it is Noah's super chat, which drives every project by design |
| `~/.dorothy/hermes-webhook-secret` | nobody | `POST /api/webhooks/hermes`, and nothing else |
| `~/.dorothy/api-token`, the shared token | nobody | reads, and the exempt routes. It drives no agent |

Measured before the change, on `b17db0f`: a call presenting the shared token
with **no** `x-tars-client` header stopped, started, dispatched to and DELETEd
an agent of any project and got a `200`. The guard refused only a caller that
*volunteered* `x-tars-client: mcp`, which is a header the caller writes about
itself. Every agent can read that token file, so the fleet was open to any of
them; it could not simply be refused, because the super chat authenticated the
same way. It no longer does.

**What this is.** A guard against mistakes, and against a *casual* reader of the
token file. It is not isolation: see §3.

**What it leaves open, deliberately.** The read routes (`GET /api/agents`, and
per-agent status, output, health, wait, bootstrap) still accept the shared
token, because `hooks/session-start.sh` fetches an agent's bootstrap with it at
the start of every session. So a process holding that file can still enumerate
the fleet and read any agent's terminal output. Closing that means giving the
hooks an identity of their own, which is a change to every CLI's hook config,
not to a route.

---

## 3. An agent's token is not secret from the other agents

`CLAUDE_MGR_API_TOKEN` travels to the CLI, and from the CLI to every MCP server
it starts, in the environment. The environment of a process is readable by any
other process of the same user.

Measured on 2026-09-18: six live `mcp-orchestrator` node processes on this
machine, every one of them exposing `CLAUDE_MGR_API_TOKEN` and
`CLAUDE_AGENT_ID` to `ps -Eww`. A canary in a `node` process is readable; the
same canary in `/bin/sleep` is not, because Apple's platform binaries hide
theirs and neither `claude` nor `node` is one.

Four parades were considered, and **none was written**:

| Parade | What it would do | Measured verdict |
|---|---|---|
| A `0600` file instead of the environment | | Moves it. Every agent runs as the same user, so `cat` reads it. `~/.dorothy/api-token` is already `0600` and is exactly the secret this replaced |
| An inherited file descriptor | Pass the token on an fd rather than in the environment | Not implementable. Tars starts the CLI through `node-pty`, whose `spawn` inherits the tty and nothing else, and the token has to reach the MCP servers, which the **CLI** starts, from its own environment. There is no fd route that does not go through Claude Code |
| A one-shot token exchanged at startup | Redeem the environment token once for a session token held in memory | Breaks the fleet. The same variable is what a respawned MCP server and the shell hooks present later; spending it on first use logs them out. And a sibling can read it before it is spent: a race, not a boundary |
| A unix socket per agent | Address the API through a per-agent socket | Moves it. The socket path is in the same environment, and filesystem permissions are per user, so any agent of that user connects. macOS has no abstract socket namespace |

And the sandbox, which is the one that sounds like it would work:

**It does not.** Measured under the strictest `sandbox-exec` profile in §4, a
five-line Python calling `sysctl KERN_PROCARGS2` still read another process's
environment. `(deny sysctl-read (sysctl-name "kern.procargs2"))` does not stop
it. `(deny process-info*)` does not stop it either, and kills the reader's own
interpreter, `git` and `npm` with it; `(deny process-info* (target others))`
leaves the toolchain alive and still does not stop it. What every profile does
stop is `/bin/ps`, which is setuid root and therefore cannot be executed under
any sandbox at all: the convenient route is closed, the syscall behind it is
not.

**The honest statement.** Per-agent tokens ended impersonation *by naming*: an
agent can no longer become a colleague by writing a header. They do not, and
cannot, end impersonation by a process that reads the process table. Closing
that needs agents in separate user accounts, or separate VMs. It is not a
line of TypeScript, and nothing in this repo pretends otherwise.

---

## 4. A sandbox for a Tars agent: what it would really buy

Noah decides this; nothing here is implemented, and no agent is confined by
anything Tars ships today. This is the measurement, so the decision has numbers
under it.

`claude` runs unconfined: its Bash reads everything Noah reads. `--add-dir` sets
**tool permissions**, not an access boundary, and on this machine 37 of the 42
agents in the fleet run with `--dangerously-skip-permissions`, where the flag
decides nothing at all.

### What was measured

A real `claude` (2.1.273), under `sandbox-exec`, on a disposable project, with a
disposable HOME and the login keychain reached by symlink. Its own report, in
full:

```
1. hello.txt - written successfully, contains `confined`.
2. git status --short - succeeded: `?? f.txt` and `?? hello.txt`
3. ls /Users/noah/Documents - failed: ls: /Users/noah/Documents: Operation not permitted
4. ps -Eww -p 39401 - failed: (eval):1: operation not permitted: ps
```

So: it did its work, and it could not read Noah's home. Separately measured
under the same profile: `~/.dorothy/api-token` denied, `/Users/noah/tars`
denied, the loopback API reachable, `api.anthropic.com` reachable, `git`,
`node` and `npm` working.

### The profile that does it

A deny-by-default profile, about forty lines. What it took to get there, none of
it obvious:

- `(deny default)` plus a list of allowed subpaths **is not enough for `/bin/sh`
  to run**: it also reads the root directory, so `(literal "/")` is required.
  Without it every command dies at exec with no message.
- The toolchain has to be named, because on this machine it lives under `$HOME`:
  `~/.nvm` (node and npm), `~/.local/bin` and `~/.local/share/claude` (the CLI
  itself). A profile allowing only `/usr` and `/opt` starts nothing.
- `git` reads `~/.gitconfig` and `~/.config/git/ignore`. Denied, it fails
  outright on the first and warns on the second.
- **The credential store has to be allowed.** Without
  `~/Library/Keychains`, the CLI answers `Not logged in - Please run /login`.
  A profile that walls off the user's `Library` walls off the agent's account
  with it.
- The network can be allowed or denied, and not much in between:
  `network-outbound` filters take an `ip "host:port"`, not a DNS name, so
  "only api.anthropic.com" is not expressible. Loopback-only was measured:
  the model becomes unreachable (`curl` to Anthropic returns nothing at all).
- A `(deny …)` rule is an `EPERM` by default and a kill with
  `(with send-signal SIGKILL)`. The kill matters when the caller swallows the
  error; `log show` does not report these refusals, so it is no use as a
  detector.

### What Noah gains

- An agent cannot read `~/Documents`, `~/.ssh`, another project's source, or
  `~/.dorothy` (the fleet's settings, every provider API key, the shared token,
  the vault). Measured, not assumed.
- An agent cannot write outside its project and the paths it is given. That is
  the failure mode with teeth: a confused agent `rm -rf`ing the wrong tree.
- It is per agent and per profile, so a read-only reviewer agent is expressible.

### What Noah loses

- **`ps` stops working entirely**, in every profile, confined or not, because it
  is setuid root. An agent debugging a stuck process loses its tool.
- Every path an agent legitimately needs must be named in advance: a second
  project, a worktree elsewhere, a scratch directory, a global npm cache. A
  missing path is a refusal, and often a silent one.
- `sandbox-exec` is deprecated by Apple. It works on macOS 26.6.1 and has worked
  for a decade; it carries no promise about the next release.
- Nothing may wrap the E2E suite in it: Chromium installs its own sandbox and a
  process already confined fails to start.
- **It does not close §3.** An agent under this profile still reads a
  colleague's token out of the process table. The sandbox is a filesystem
  boundary, not a process boundary.

### The shape it would take in Tars, if Noah wants it

`initAgentPty` is the one line every PTY starts on. A confined spawn would be
`sandbox-exec -f <profile> <the command it already builds>`, with the profile
written per agent next to its worktree from a template: the project path, the
worktree, the agent's own scratch, plus the fixed system and toolchain block
above. Opt-in per agent, defaulting to off, or every existing agent breaks on
the first path nobody thought to list.

---

## 5. What is where on disk

| Path | Holds | Reachable by an agent |
|---|---|---|
| `~/.dorothy/` | the fleet, settings, the shared token, the vault, the bus journal | Yes, deliberately: it is in every agent's `--add-dir` |
| `~/.tars-private/` | Noah's conversation with the super chat | Not handed to any agent, and never passed to a CLI. `0600`, in a `0700` directory |

`~/.tars-private/overseer.json` used to be `~/.dorothy/overseer.json`: 148,654
bytes, 344 messages, mode `0644`, in the directory every agent is pointed at.
Reading it took no API call and no token.

Moving it is worth exactly what it is worth, and no more: it leaves the
directory an agent is handed and the listing it gets for free, and the `0600`
closes it to the other accounts on the machine. An agent that goes looking for
`~/.tars-private` still reads it, because §1. Closing that is §4, or nothing.
