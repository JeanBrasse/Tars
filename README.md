# Tars

![Tars](screenshots/background-2.png)

A desktop app for running a team of AI coding agents the way you'd run a team of
engineers. Every agent gets a real terminal, its own git worktree and its own
model; you watch all of them at once, delegate between them, and see what each
one actually changed.

macOS. Free and open source. No account, no cloud in the middle — the CLIs run
on your machine and Tars is the room they work in.

![The dashboard: every running agent in one grid, each pane a live terminal](screenshots/dashboard.png)

---

## Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Install](#install)
- [How a task actually travels](#how-a-task-actually-travels)
- [Providers](#providers)
- [Memory](#memory)
- [Hermes](#hermes)
- [The surfaces](#the-surfaces)
- [Where your data lives](#where-your-data-lives)
- [Development](#development)
- [Further reading](#further-reading)

---

## Why this exists

One coding agent in one terminal is a solved problem. Six of them is not: you
lose track of which is running, they overwrite each other's work, you cannot
tell what any of them changed, and the bill arrives at the end of the month
with no breakdown.

Tars is the answer to the second problem. It does not replace your CLI — it
runs the one you already have, in a real PTY, and adds the parts that only
matter once there is more than one.

---

## What it does

**Every agent on one screen.** Real terminals in a grid, grouped by project.
Watch six at once, jump into any of them, broadcast one instruction to all.

**Delegation that reports back.** An orchestrator hands work to another agent
over the [Agent Client Protocol](https://agentclientprotocol.com) — not by
typing into its terminal and hoping. The call returns the agent's answer, why
the turn ended, which tools it used and what it cost. Where a CLI has no ACP
mode, Tars falls back to the terminal path rather than pretending.

**A whole team in one click.** An orchestrator, frontend, backend, QA, audit and
database engineer on a project, each on its own git worktree, model and brief.

**Any CLI, any model.** Fifteen providers, plus local models. Model lists and prices come from a
live catalogue, so a model released this morning is selectable this morning —
and its real price is used, not one baked into the last release.

![The agent list, with provider, model and worktree branch on every card](screenshots/agents.png)

**One memory, five sources.** Project files, the session ledger, your Hermes
gateway, gbrain and Honcho behind a single interface — reachable by every CLI,
not only the ones with a session hook.

**See what they actually did.** A diff review of every branch against the one it
was cut from, one search across the whole fleet's output, and per-provider spend
against a budget you set.

![Usage: what each provider actually cost, against the budget you set](screenshots/usage.png)

---

## Install

Download the latest release for macOS:

**[github.com/JeanBrasse/Tars/releases/latest](https://github.com/JeanBrasse/Tars/releases/latest)**

Then point Tars at a folder. It finds the CLIs already installed on your machine
— you do not configure paths unless something lives somewhere unusual.

Building from source is in [OPERATIONS.md](OPERATIONS.md#development). Node 22
is required; Node 18 fails at startup.

---

## How a task actually travels

```
  you ──▶ Orchestrator agent
              │
              │  delegate_task(agent, task)         ← MCP tool, from its own terminal
              ▼
        Tars main process
              │
              ├──▶ ACP  session/prompt ─────────▶ target agent's CLI
              │        ◀── stopReason, usage, tool calls
              │
              └──▶ PTY  (providers with no ACP mode)
                       ◀── output only

  Every turn is recorded in the usage ledger with its transport and cost.
```

The distinction matters. Over ACP the orchestrator learns whether the task
finished, what it cost, and can have a tool call denied by the protocol rather
than by a flag one CLI happens to support. Over the PTY it learns that bytes
were written. Tars tells you which one you got.

---

## Providers

Six CLIs — Claude Code, Codex, Gemini, Grok, opencode and Pi — and nine reached
by API key: DeepSeek, Kimi (Moonshot), MiniMax, Mimo, NVIDIA, Nous Portal,
OpenRouter, Qwen and Zhipu. Local models run through Tasmania.

They are equal citizens. A feature that works only for Claude is a bug here —
that principle is written down in [ETHOS.md](ETHOS.md) because it kept being
violated.

![Providers: every CLI and API Tars can run, on equal footing](screenshots/providers.png)

---

## Memory

| Source | What it is | How agents reach it |
|---|---|---|
| Project memory | `~/.claude/projects/*/memory/*.md` | digest at session start, `memory_read` |
| Session observations | per-project ledger under the Tars data directory | digest at session start |
| Hermes memory | the gateway's own `MEMORY.md` and `USER.md`, plus full-text search over every past session | `memory_search` |
| gbrain | shared semantic memory over MCP | `memory_search` |
| Honcho | Plastic Labs' memory layer over MCP | `memory_search` |

Two delivery routes, because CLIs differ: a bundled MCP server registered with
**every** provider, and — for the CLIs with no session-start hook — the digest
injected into the prompt, so those agents do not begin knowing nothing.

The Brain page says a source is reachable only when something actually answered.

---

## Hermes

Tars does not own a scheduler or a task board. If you run a
[Hermes](https://github.com/gbrain-ai/hermes) gateway, its cron jobs dispatch
work to your agents and its kanban board is a screen in the app. Without one,
the local board and the rest of Tars work fine.

![The board. Hermes runs the work; the local board is for projects without a gateway](screenshots/kanban.png)

---

## The surfaces

| Screen | What it is for |
|---|---|
| **Dashboard** | The terminal grid. Every agent, live, grouped by project |
| **Agents** | Create, configure, start and stop. Templates and whole teams |
| **Kanban** | The task board, from Hermes or local |
| **Schedules** | Your Hermes cron jobs: run now, pause, resume, delete |
| **Review** | What each agent changed, as a diff against its base branch |
| **Logs** | One search across every agent's output, regex included |
| **Vault** | Documents your agents can read and write |
| **Projects** | The folders Tars knows about, and their agents |
| **Extensions** | Skills and plugins, per provider |
| **Usage** | Spend per provider and per model, against your budgets |
| **Brain** | The five memory sources, and whether each one answers |

![The vault: documents your agents can read and write](screenshots/vault.png)

---

## Where your data lives

Everything is a file in your home directory. Nothing is uploaded.

| File | What it holds |
|---|---|
| `agents.json` | Your agents. Written atomically, with a backup |
| `app-settings.json` | Preferences and provider API keys. `0600` |
| `api-token` | Bearer token for the local API. `0600` |
| `hermes-connection.json` | Gateway address and session token. `0600` |
| `projects.json` | The folders you added by hand |
| `kanban-tasks.json` | The local board |
| `vault.db` | Vault documents |
| `observations/` | The per-project session ledger |
| `model-catalog.json` | Cached model and price catalogue |

A local HTTP server on **31415**, bearer-token authenticated, is how the CLIs'
hooks and the bundled MCP servers call back into the app. It listens on
`127.0.0.1` only.

Seven MCP servers ship with Tars — orchestration, memory, kanban, vault,
Telegram, X and SocialData — and are registered with each provider in that
provider's own config format.

---

## Development

```bash
nvm use 22          # Node 18 fails at startup
npm install
npm run electron:dev
```

Before you call anything done:

```bash
npx tsc --noEmit                       # renderer
npx tsc -p electron/tsconfig.json --noEmit
npx vitest run                         # unit
npx eslint .
bash scripts/design-lint.sh            # the design rules that can be linted
npx playwright test                    # boots the real app and walks every surface
```

The E2E suite launches Electron against a sandboxed `HOME` seeded with fixture
agents, walks every screen and overlay in `e2e/surfaces.mjs`, photographs each
one and asserts zero uncaught page errors. The screenshots in this README come
from it.

---

## Further reading

| | |
|---|---|
| [SPECS.md](SPECS.md) | What the system is, subsystem by subsystem — including a candid list of its limitations |
| [DESIGN.md](DESIGN.md) | Tokens, type scale, components, and the rules the design lints |
| [OPERATIONS.md](OPERATIONS.md) | Runbook: build, release, storage, troubleshooting |
| [ETHOS.md](ETHOS.md) | How decisions get made here |
| [CLAUDE.md](CLAUDE.md) | Instructions for AI agents working in this repo |

---

## Contributing

This is a fork of [Charlie85270/Dorothy](https://github.com/Charlie85270/Dorothy),
substantially rewritten. Issues and pull requests go to
[JeanBrasse/Tars](https://github.com/JeanBrasse/Tars); nothing is pushed
upstream.

## License

MIT.
