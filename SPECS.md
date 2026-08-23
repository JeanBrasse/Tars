# TARS: Specs v1.5.0

## Vision

A desktop app that runs a team of AI coding-agent CLIs on your own machine, in parallel, on your own repositories. Each agent is a real terminal process (`claude`, `codex`, `gemini`, `grok`, `opencode`, `pi`, or the `claude` binary re-pointed at another vendor) running in its own git worktree, with its own model, its own permission mode and its own PTY. Tars owns the process lifecycle, the orchestration path between agents, one shared memory, and the cost accounting.

Nothing runs in the cloud. No account, no server, no telemetry. The state lives in `~/.dorothy`, the agents read and write your working tree, and the only network calls the app itself makes are the model catalogue, the ACP registry, the update feed, and whatever integration you switch on.

---

## Architecture Overview

### Data Flow

```
Electron main process (electron/, ~23k LOC)
├── BrowserWindow  → Next.js 16.3 static export (src/, ~40k LOC)
│                     contextIsolation, nodeIntegration off, app:// protocol
│                     ↕ 162 IPC channels via contextBridge (electron/preload.ts)
│
├── PTY layer (node-pty)          agent PTYs · quick PTYs · skill PTYs · plugin PTYs
│     └─ one shell per agent, cwd = worktreePath ?? projectPath
│
├── Local HTTP API  127.0.0.1:31415  (electron/services/api-server.ts)
│     ├── Bearer ~/.dorothy/api-token  (exempt: /api/health, /api/hooks/*,
│     │                                 /api/local-file, /api/kanban/complete)
│     ├── Origin allowlist: app://-  |  http://localhost:3000
│     │
│     ├─◄ Claude Code hooks (hooks/*.sh)      status, output, notifications
│     ├─◄ bundled MCP servers (stdio, node)   orchestration + memory tools
│     └─◄ Hermes gateway webhook              external scheduler → dispatch
│
├── ACP layer (electron/services/acp/)
│     └─ spawn agent CLI in ACP mode → JSON-RPC over stdio → turn returns
│        { stopReason, usage, text, toolCalls }
│
└── Outbound: models.dev · ACP registry · GitHub releases · Hermes gateway
             · Telegram · Slack · gbrain / Honcho MCP
```

The orchestration loop, in full:

```
orchestrator agent's CLI
  └─ MCP tool  delegate_task(id, prompt)
       └─ POST 127.0.0.1:31415/api/agents/:id/run-task      ← preferred
       │     └─ AcpSession: spawn CLI, initialize, session/new,
       │        session/set_mode, session/prompt  → TurnResult
       │        → recordUsage()  → response carries text + cost
       │
       └─ fallback when the provider has no ACP mode, or the run failed:
             POST /api/agents/:id/dispatch     → PTY write or fresh spawn
             GET  /api/agents/:id/wait         → long-poll on status change
             GET  /api/agents/:id              → lastCleanOutput (3 retries)
```

### Key Design Decisions

- **Two transports, not one.** ACP returns a receipt; the PTY does not. `delegate_task` tries ACP first and degrades to terminal dispatch. Everything the user watches is still a real terminal.
- **The server decides message-vs-spawn.** `POST /api/agents/:id/dispatch` makes that call under the main process's single-threaded event loop. The earlier GET-status-then-POST pattern raced and could type into a dead PTY.
- **Session ownership is explicit.** A dispatch tombstones the old session id; only the session registered by `SessionStart` may drive status. Hooks of a killed PTY survive the kill by seconds and would otherwise flip the new task's status.
- **Providers are a strategy interface, not conditionals.** 19 methods on `CLIProvider`; 15 implementations. Adding a vendor is a file in `electron/providers/` plus one line in the registry.
- **Ten of the fifteen providers are the `claude` binary re-pointed.** `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` in the PTY environment, either at the vendor's Anthropic-compatible endpoint or through OpenRouter. They inherit Claude Code's hooks, skills and MCP config for free.
- **Model list and prices come from models.dev, not from the source.** A model released today is selectable after the next 6-hour refresh, with no release.
- **Memory is federated and provider-agnostic.** Five sources behind one hub, delivered two ways: a bundled MCP server every provider registers, and prompt injection for the CLIs with no session hook.
- **Tars has no scheduler.** Cron jobs, the task board and long-running automation live in the user's Hermes gateway; Tars is a client and exposes an inbound webhook.
- **Nothing is ever pushed upstream.** The fork lives at `JeanBrasse/Dorothy`; `GITHUB_REPO` in `electron/constants/index.ts` points there so an upstream build can never be offered as an update to a fork install.

---

## §1 Process model

### Main process

`electron/main.ts` (661 lines) is wiring only. On `app.whenReady()`, in order:

| # | Step | Notes |
|---|---|---|
| 1 | `ensureDataDir()` | creates `~/.dorothy` |
| 2 | `ensureTarsClaudeMd()` | writes `~/.dorothy/CLAUDE.md`, mounted into every agent via `--add-dir` |
| 3 | statusline install/remove | `~/.dorothy/statusline.sh` + `statusLine` key in `~/.claude/settings.json` |
| 4 | `migrateFromClaudeManager()` | moves `~/.claude-manager` → `~/.dorothy`, then deletes the old dir |
| 5 | `loadAgents()` + `startAgentAutosave()` | 30 s dirty-flush timer, `unref`'d |
| 6 | `setupProtocolHandler()` → `createWindow()` | `app://` and `local-file://` |
| 7 | `initTray()` | menu-bar popover rendering `/tray-panel` |
| 8 | IPC registration | 162 channels across 12 files: the 11 handler modules plus `mcp-orchestrator.ts` |
| 9 | `initVaultDb()` | better-sqlite3, WAL, foreign keys on |
| 10 | Telegram + Slack + `startApiServer()` | |
| 11 | `loadCatalog()` (not awaited) | stale disk copy answers immediately |
| 12 | `setupMcpOrchestrator()` (not awaited) | registering spawns CLIs; it used to hold the first paint |
| 13 | `configureStatusHooks()` (awaited) | |
| 14 | update check after 5 s | `electron-updater`, `autoCheckUpdates !== false` |

`process.stdout` / `process.stderr` get an `EPIPE`-swallowing error handler at module load: a closed pipe from the launching shell would otherwise crash the app on the next `console.log`.

### PTY layer

Four maps in `electron/core/pty-manager.ts`: `ptyProcesses` (agents), `quickPtyProcesses` (the shell panel), `skillPtyProcesses`, `pluginPtyProcesses`. `killAllPty()` drains all four on `before-quit`.

`writeProgrammaticInput(pty, data, bracketPaste)` is the only sanctioned way to inject text into a running agent:

- `bracketPaste: false` means plain `data + '\r'`, for the initial shell command.
- `bracketPaste: true` is for a live Claude Code TUI. Input over 200 chars or containing a newline is wrapped in `\x1b[200~ … \x1b[201~`. **The carriage return is always a separate write delayed 300 ms**, because the TUI treats a rapid `text\r` burst as one paste event: the text lands in the box as `[Pasted text]` and is never submitted.

It must never be used for keystroke passthrough from an xterm.js terminal.

### Renderer

Next.js 16.3 App Router, static-exported (`ELECTRON_BUILD=1 next build` with `src/app/api` temporarily moved aside). React 19, Tailwind 4, Zustand, xterm 5.3, framer-motion. Served from `app://-/index.html` in production, `http://localhost:3000` in dev.

---

## §2 Providers

### The contract

`electron/providers/cli-provider.ts` defines `CLIProvider`. Four readonly fields and 19 methods:

| Group | Members |
|---|---|
| Identity | `id`, `displayName`, `binaryName`, `configDir` |
| Models | `getModels(): ProviderModel[]`, `resolveBinaryPath(appSettings)` |
| Command building | `buildInteractiveCommand`, `buildScheduledCommand`, `buildOneShotCommand`, `buildScheduledScript` |
| Environment | `getPtyEnvVars(agentId, projectPath, skills, appSettings?)`, `getEnvVarsToDelete()` |
| Hooks | `getHookConfig(): { supportsNativeHooks, configDir, settingsFile }`, `configureHooks(hooksDir)` |
| MCP | `getMcpConfigStrategy(): 'flag' \| 'config-file'`, `registerMcpServer`, `removeMcpServer`, `isMcpServerRegistered` |
| Skills | `getSkillDirectories()`, `getInstalledSkills()`, `supportsSkills()` |
| Paths | `getMemoryBasePath()`, `getAddDirFlag()` |

`getProvider(id)` falls back to Claude for anything unknown, including `'local'` (Tasmania), which is a Claude sub-mode rather than a provider of its own. `isValidProvider` accepts `'local'` plus the 15 registry keys.

`safeEffort()` is exported from the same module and validates reasoning effort against `{low, medium, high, xhigh, max}` before it lands unquoted in a shell string. The value arrives over IPC, so it is validated at the point of use, not trusted from the caller.

### The registry (15 providers)

| id | Display name | Binary | Config dir | Reaches the model via |
|---|---|---|---|---|
| `claude` | Claude Code | `claude` | `~/.claude` | native |
| `codex` | Codex CLI | `codex` | `~/.codex` | native |
| `gemini` | Gemini CLI | `gemini` | `~/.gemini` | native |
| `grok` | Grok CLI | `grok` | `~/.grok` | native |
| `opencode` | OpenCode | `opencode` | `~/.opencode` | native |
| `pi` | Pi Terminal | `pi` | `~/.pi` | native |
| `openrouter` | OpenRouter | `claude` | `~/.claude` | `https://openrouter.ai/api` |
| `deepseek` | DeepSeek | `claude` | `~/.claude` | `https://api.deepseek.com/anthropic`, else OpenRouter |
| `moonshot` | MoonshotAI (Kimi) | `claude` | `~/.claude` | `https://api.moonshot.ai/anthropic`, else OpenRouter |
| `zhipu` | ZhipuAI (GLM) | `claude` | `~/.claude` | `https://open.bigmodel.cn/api/anthropic`, else OpenRouter |
| `minimax` | MiniMax | `claude` | `~/.claude` | `https://api.minimax.io/anthropic`, else OpenRouter |
| `qwen` | Qwen (Alibaba) | `claude` | `~/.claude` | OpenRouter only |
| `mimo` | MiMo (Xiaomi) | `claude` | `~/.claude` | OpenRouter only |
| `nvidia` | NVIDIA NIM | `claude` | `~/.claude` | OpenRouter only |
| `nous-portal` | Nous Portal | `claude` | `~/.claude` | OpenRouter only |

Plus `local`: the `claude` binary pointed at a running Tasmania server (`ANTHROPIC_BASE_URL` = the endpoint with any `/v1` suffix stripped, since the Claude Code SDK appends `/v1/messages` itself).

### Per-provider capabilities

| Capability | Value per provider |
|---|---|
| Native hooks | `true` for `claude` and all ten claude-binary providers (they share `~/.claude/settings.json`) and `gemini`; `false` for `codex`, `grok`, `opencode`, `pi` |
| MCP strategy | `flag` (`--mcp-config`) for the claude-binary family; `config-file` for `codex`, `gemini`, `grok`, `opencode`, `pi` |
| Skills | `true` everywhere except `pi`, which has packages rather than skills |
| Skill directories | claude family: `~/.claude/skills` + `~/.agents/skills`; `gemini`: `~/.gemini/skills`; `grok`: `~/.grok/skills` + `~/.agents/skills`; `codex`, `opencode`: `~/.agents/skills`; `pi`: `~/.pi/packages` |
| Memory base path | `<configDir>/projects` for the claude-binary family; `codex`, `gemini`, `grok`, `opencode` and `pi` return `configDir` itself, a placeholder; they have no Claude-like memory tree |
| Prompt-injected memory | every provider whose `configDir` is not `~/.claude` (see §5) |
| ACP mode | `claude`, `codex`, `gemini`, `grok`, `opencode`, `pi` (see §4) |
| Orchestrator tool block | Claude only enforces it as a CLI flag (`--disallowed-tools`); on every other provider it is enforced by ACP permission arbitration |

### Alt-provider safety gate

`spawnAgentSession` refuses to start a claude-binary alt provider that produced no `ANTHROPIC_BASE_URL`, which means no API key is configured, and the session would silently bill the user's Anthropic account:

```
No API key configured for provider "<id>". Add it (or an OpenRouter key) in Settings > AI Providers.   → HTTP 400
```

The `local` provider gets the same treatment: Tasmania not running → HTTP 409, never a silent fall-through to the cloud.

### Environment injected into every agent PTY

```
PATH        = buildFullPath(configured CLI dirs)   TERM = xterm-256color
CLAUDE_SKILLS, CLAUDE_AGENT_ID, CLAUDE_PROJECT_PATH, CLAUDE_PROVIDER
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = 1
+ provider env (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / Tasmania vars)
− everything in getEnvVarsToDelete()  (CLAUDECODE, so nested sessions don't inherit it)
```

`CLAUDE_AGENT_ID` and `CLAUDE_PROJECT_PATH` are re-asserted explicitly after the provider spread: MCP project scoping and every hook depend on them.

---

## §3 Model and price catalogue

`electron/services/model-catalog.ts`.

Model lists and per-token prices used to be hardcoded, so a new model or a price change needed a release. [models.dev](https://models.dev) publishes both for 193 providers in USD per million tokens, re-syncs hourly, is MIT licensed, and supports conditional GET: the usual refresh costs one 304 and no body.

### Three tiers, in order

1. **Fresh fetch.** `https://models.dev/api.json`, then the mirror `https://raw.githubusercontent.com/anomalyco/models.dev/dev/models.json`. 20 s timeout, `If-None-Match` from `~/.dorothy/model-catalog.meta.json`. The payload is rejected unless it is an object with an `anthropic` key.
2. **Last-good copy on disk.** `~/.dorothy/model-catalog.json`, served whatever its age. Stale beats nothing: an old catalogue still prices yesterday's models.
3. **Compiled-in floor.** Four families in `FLOOR` (`fable`, `opus`, `sonnet`, `haiku`), matched by substring. Kept deliberately small: the catalogue is the source.

TTL 6 h, single in-flight promise, memoized. `loadCatalog()` never throws. `catalogSync()` is the synchronous view for hot paths.

### How a model released today becomes available

models.dev adds it → next `loadCatalog()` past the 6-hour TTL (or `models:refresh` from Settings) rewrites `model-catalog.json` → `modelsForProvider(id)` maps the Tars provider id through `PROVIDER_KEYS` and returns every model sorted by `release_date` descending → the picker shows it. No app release.

`PROVIDER_KEYS` maps 14 Tars ids to models.dev keys (`claude→anthropic`, `codex→openai`, `gemini→google`, `grok→xai`, `qwen→alibaba`, `zhipu→zai`, `mimo→xiaomi`, `moonshot→moonshotai`, plus identity mappings). A provider absent from the map has no catalogue entry and its picker falls back to the static `getModels()` list.

### Pricing lookup

`priceFor(modelId, providerId?)`:

1. Exact id in the provider's own catalogue section.
2. Longest-prefix match in either direction: transcripts carry dated ids like `claude-haiku-4-5-20251001` that the catalogue lists undated.
3. The same two steps across every catalogue key.
4. The `FLOOR` family substring.

`catalogStatus()` reports `{ loaded, fetchedAt, providers, models }` so the Usage page can say whether a figure is priced from the live catalogue or a fallback.

---

## §4 Orchestration

### The two transports

| | ACP (`/run-task`) | PTY (`/dispatch`) |
|---|---|---|
| Providers | 6 with an ACP mode | all 15 |
| Returns | agent's text, `stopReason`, tool calls, token usage, cost | `{ success, mode, previousStatus, agent }` |
| Delivery guarantee | the turn resolved or the call errored | bytes were written to a pty |
| Deny-list enforcement | protocol-level, every provider | `--disallowed-tools`, Claude only |
| Usage captured | yes, every provider | Claude only, after the fact from transcripts |
| Session lifetime | one task, torn down after | persists at the CLI prompt |
| Visible in the UI terminal | no | yes |

### The ACP layer: `electron/services/acp/`

**`client.ts`: `AcpSession`.** JSON-RPC 2.0 over the child process's stdin/stdout, newline-delimited. `start()` sends `initialize` (protocolVersion 1, client capabilities `fs.readTextFile`/`fs.writeTextFile`, `terminal: false`), then `session/new` with cwd and MCP server specs, then `selectMode()`.

`selectMode()` matters more than it looks. The default on some agents is "deny anything not pre-approved", which silently blocks the very MCP tools Tars injects. Mode preference:

| Situation | Preference order |
|---|---|
| `denyTools` non-empty, or `permissionMode: 'normal'` | `default` → `auto` → `acceptEdits` |
| `permissionMode: 'bypass'` | `bypassPermissions` → `acceptEdits` → `default` |
| otherwise | `acceptEdits` → `default` → `auto` |

Choosing `default` puts arbitration back on the client: every risky call arrives as `session/request_permission` and Tars answers it. That is how the orchestrator deny-list ends up enforced identically on every agent instead of only on the one CLI with the right flag.

`answerPermission()` lowercases `"<toolCall.title> <toolCall.kind>"` and denies if any `denyTools` fragment is a substring, picking `reject_once`/`reject_always`; otherwise `allow_once` (normal) or `allow_always`/`allow_once`. Anything else the agent asks of the client gets an empty acknowledgement rather than silence, which would hang its turn.

Session updates handled: `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update` (including `cost.amount`), `plan`. Timeouts: `initialize` and `session/new` 90 s, `session/set_mode` 15 s, a turn 30 min by default.

**`registry.ts`.** Launch commands are fetched from the public ACP registry (`agentclientprotocol/registry`, one `agent.json` per agent) rather than hardcoded, and cached in `~/.dorothy/acp-registry.json` with a 24 h TTL. `PROVIDER_TO_ACP` maps six providers: `claude→claude-acp`, `codex→codex-acp`, `gemini`, `grok`, `opencode`, `pi`. `FALLBACK` covers five of the six: **`pi` has no fallback entry, so `pi` only has an ACP mode when the registry fetch has succeeded at least once.** Fetch failures are per-agent and never throw.

**`delegate.ts`: `delegateOverAcp()`.** Resolves the launch entry, checks the cwd (`worktreePath ?? projectPath`) exists, builds the session with provider env vars plus `CLAUDE_AGENT_ID`/`CLAUDE_PROJECT_PATH`, and attaches two MCP servers (`tars-memory` and `claude-mgr-orchestrator`) if their bundles exist. Orchestrators get `ORCHESTRATOR_DENY = ['write', 'edit', 'create file', 'multiedit', 'notebook']`. On completion it calls `recordUsage()` and returns `{ ok: stopReason === 'end_turn', transport: 'acp', stopReason, text, toolCalls, usage, costUSD }`. The session is stopped in `finally`: a delegated task is a unit of work, not a conversation.

### The MCP orchestrator: `mcp-orchestrator/`

An stdio MCP server (`@modelcontextprotocol/sdk`) bundled into `extraResources` and registered with every provider under the name `claude-mgr-orchestrator`. It is a thin client of `127.0.0.1:31415`.

| Tool | Does |
|---|---|
| `whoami` | Identity handshake: reads `CLAUDE_AGENT_ID` / `CLAUDE_PROJECT_PATH` from its own environment, resolves the agent, returns the project roster |
| `list_agents` | Scoped to the caller's project by default; `all: true` for the global view |
| `get_agent` / `get_agent_output` | Detail and `lastCleanOutput` |
| `create_agent` | Defaults to the caller's project |
| `start_agent` / `send_message` | Both route to `POST /dispatch`; `send_message` accepts `message` or `prompt` so the LLM doesn't trip on naming |
| `stop_agent` / `remove_agent` | |
| `wait_for_agent` | Single long-poll against `/wait`, no polling loop |
| `delegate_task` | The composite. ACP first, terminal dispatch as fallback |
| `send_telegram` / `send_slack` | Reply to whichever channel the request came from |

Auth: `Authorization: Bearer <~/.dorothy/api-token>`, plus `X-Tars-Client: mcp` and caller identity headers. Timeouts: 30 s normally, 600 s on `/wait`, or an explicit override: a caller passing `timeoutSeconds` sends `(timeout + 30) * 1000` so the client never gives up before the server-side long-poll resolves.

`delegate_task` in full:

1. `POST /api/agents/:id/run-task` with `(timeoutSeconds + 60) * 1000` client timeout. If the response is not `retryWithDispatch` and has `ok` or `text`, return the agent's answer with a metadata line: `ended: <stopReason> | tools: … | <n> tokens | $<cost>`.
2. Otherwise `POST /dispatch` → `GET /wait`.
3. If the agent lands in `waiting` with `waitingReason: 'permission'`, stop. A blocking permission dialog expects arrow keys and Enter; a typed message cannot answer it and the delayed `\r` could *accept* the pending permission.
4. Any other `waiting`: auto-reply *"Yes, continue. Do not ask for confirmation…"* once, then wait again with `max(timeout - 30, 60)`.
5. On completion, fetch `lastCleanOutput` with 3 attempts 700 ms apart: the Stop hook posts output and status over separate HTTP calls, so the status event that resolves `/wait` can beat the output write.

### Atomic dispatch: `performDispatch()`

```
killStalePty(agent)                       // BUG 4: worktreePath changed after spawn
if live PTY && waiting on permission  → 409, refuse
if live PTY && (running || waiting)   → writeProgrammaticInput, clear lastCleanOutput,
                                         status = running, mode 'message'
else                                  → spawnAgentSession(), mode 'start'
```

`spawnAgentSession()` is shared by `/start`, the `/message` reconnect path and `/dispatch`, so every entry point gets identical behaviour: the identity header, the skills prefix, the MCP config for flag-strategy providers, orchestrator instructions (`electron/resources/super-agent-instructions.md`) via `--append-system-prompt-file`, the tool block, trust pre-acceptance, stale-PTY kill, the `ptyCwd` invariant and the session-ownership reset.

Every prompt is prefixed with an identity header, because agents that don't know who they are ask the orchestrator:

```
[Tars: you are agent "<name>" (id <id>), <role> of project <path>,
 working in worktree <path> (branch <branch>), stay inside this directory.
 Work autonomously without asking for confirmation and end with a clear report
 of your results: an orchestrator reads your final message.]
```

### Session ownership

The contract is documented at the head of `electron/services/api-routes/hooks-routes.ts` and enforced in three places:

- A dispatch kills the old PTY, copies `currentSessionId` into `lastKilledSessionId` (the tombstone), and clears `currentSessionId`.
- Only `session-start.sh` sends a `source` field. A post carrying `source` **registers** the session and never touches status: its startup `"idle"` would otherwise resolve the orchestrator's long-poll before the task began.
- Any post whose `session_id` equals `lastKilledSessionId` is dropped; any post whose `session_id` differs from the registered `currentSessionId` is dropped as stale. `currentSessionId` is *not* cleared on idle: the one-shot process is still alive at its prompt and its later hooks must keep matching.
- Fallback: if `SessionStart` never arrived (API briefly down at boot), the first non-tombstoned session that reports in is adopted.
- `loadAgents()` clears `currentSessionId`, `lastKilledSessionId`, `ptyId`, `ptyCwd` and `waitingReason`: session ownership is runtime state, and a persisted session would make the guard reject the next real session's hooks.

### Cross-project scoping

`assertSameProject()` guards `/start`, `/dispatch`, `/run-task`, `/stop`, `/message` and `DELETE`. It reads the caller's project from a request header:

- No header **and** `X-Tars-Client: mcp` → 403. An agent's MCP always announces itself; if it does so with no identity its calls cannot be scoped, and defaulting to "allow" would let it drive every project's agents.
- Header matches the agent's `projectPath` → allow.
- Mismatch → 403 with the agent's project named, unless `allowCrossProject: true` is in the body (or the query string, for DELETE, which has no parsed body).
- No header at all (the renderer, `curl`) → unrestricted.

`GET /api/agents` uses the same header to filter the listing and reports `scopedToProject`. An orchestrator that only ever *sees* its own team cannot pick another project's agent id by mistake.

### What guarantees delivery, and what does not

**Guaranteed.**
- `/run-task`: the ACP turn either resolved (with `stopReason` and usage) or the call returned an error. This is the only path with a receipt.
- The dispatch decision is atomic: message-vs-spawn is made server-side under the event loop, so a stale client-held status can no longer route a prompt to a dead PTY. `ptyProcesses.delete(ptyId)` happens *immediately* in `onExit`, before the 1.5 s status delay, because `node-pty` `write()` on a dead PTY is a silent no-op.
- Stale hook posts cannot corrupt a live task's status or output.
- The orchestrator deny-list is enforced by the protocol on every ACP provider.

**Not guaranteed: be explicit about this.**
- `/dispatch` on the PTY path returns as soon as the bytes are written. There is no acknowledgement that the agent read the message, and none that it understood it as a task rather than as terminal noise. `mode: 'message'` means "typed into a live session", nothing more.
- **Status is hook-driven, and only the `~/.claude` family fires hooks.** `codex`, `grok`, `opencode` and `pi` declare `supportsNativeHooks: false`; `gemini` declares `true` but has its own hook shape. For those CLIs the only status transition is the PTY-exit handler, 1.5 s after the process dies. `wait_for_agent` against them effectively waits for process exit or times out, and `lastCleanOutput` is never populated.
- `/run-task` emits `agentStatusEmitter.emit('status', {…})`, while `/wait` listens on `` `status:${agentId}` ``. **An ACP run does not resolve a concurrent long-poll on the same agent.** In the normal `delegate_task` flow this is invisible, because ACP and the wait path are mutually exclusive; it bites anything that dispatches over ACP and waits separately.
- The MCP source now sends `X-Tars-Caller-Project` / `X-Tars-Caller-Id`, while the server reads `x-dorothy-caller-project`. The *shipped* bundles (`mcp-*/dist/bundle.js`, which is what `extraResources` packages) still send `X-Dorothy-Caller-Project`, so scoping works today. **But rebuilding the MCP servers from source silently disables project scoping and trips the no-identity 403 on every guarded route.** One of the two names has to move.
- The auto-continue in `delegate_task` fires once against any non-permission `waiting` state. If the agent was genuinely asking a question, it gets answered "yes, continue" without a human.
- `/wait` long-poll and `apiRequest`'s 600 s ceiling are independent of the ACP 30-minute turn timeout. A task can outlive its watcher.

---

## §5 Memory

`electron/services/memory-hub.ts`. One memory for every agent, whatever CLI it runs. Before this, only the first two sources existed in practice and only claude-binary CLIs ever saw them.

### The five federated sources

| id | Label | Backed by | Search |
|---|---|---|---|
| `project` | Project memory | `~/.claude/projects/<encoded>/memory/*.md`, `MEMORY.md` first | paragraph substring |
| `observations` | Session observations | `~/.dorothy/observations/<encoded>.jsonl` | line substring over the last 500 |
| `hermes` | Hermes memory | gateway `MEMORY.md` / `USER.md` + searchable session history | gateway-side |
| `gbrain` | gbrain | remote HTTP MCP endpoint | tool discovery, see below |
| `honcho` | Honcho | remote HTTP MCP endpoint | tool discovery, see below |

Project directory names are resolved by trying three encodings of the project path (`[^a-zA-Z0-9]→-`, `[/.]→-`, `/→-`): Claude Code's path-as-folder-name scheme has drifted.

Remote backends are probed rather than assumed. `pickSearchTool()` scans the endpoint's tool list for `memory_search`, `search_memory`, `honcho_search`, `search`, `recall`, `query`, `retrieve` (exact or `_`-suffixed), then anything matching `/search|recall|query|retriev/i`. The query parameter name is read off the tool's own input schema (`query`, `q`, `search`, `text`, `question`, default `query`).

`memoryStatus()` returns `{ configured, reachable, detail, tools }` per source, with `reachable` meaning *we spoke to it*, so an agent can tell "nothing recorded" apart from "a backend is down".

### Delivery mechanism 1: the bundled MCP server

`mcp-memory/` registers as `tars-memory` with **every** provider, not just Claude. Four tools:

| Tool | Purpose |
|---|---|
| `memory_search` | Federated search. Optional `sources[]` and `limit`. Reports which sources could not answer |
| `memory_read` | The full digest for the project |
| `memory_write` | Append a durable fact. `file` defaults to `MEMORY.md`; topic files for detail |
| `memory_sources` | Per-backend reachability, so an empty search is diagnosable |

It calls `/api/memory/search`, `/api/memory/context`, `/api/memory/write` and `/api/memory/status` on the local API, resolving the project from `CLAUDE_PROJECT_PATH` when not given explicitly.

The two remote backends are *additionally* registered as HTTP MCP servers directly in `~/.claude.json` by `setupMemoryBackends()`, so every claude-binary agent gets the same tools the user's Hermes instance and claude.ai connectors use. That function writes the file the `claude mcp add -s user` command maintains, directly: no dependency on the `claude` binary being on the packaged app's PATH, and no CLI boot blocking the main process. It refuses to touch anything if the file won't parse, and on removal only deletes entries whose URL matches Tars's own settings.

### Delivery mechanism 2: prompt injection

```ts
needsPromptInjection(providerConfigDir) === (resolve(configDir) !== resolve(~/.claude))
```

Providers whose config dir is `~/.claude` inherit Claude Code's `SessionStart` hook, so the digest already reaches them. `codex`, `gemini`, `grok`, `opencode` and `pi` have no such hook; for them `spawnAgentSession` calls `assembleDigest({ budgetMs: 3000 })` and prepends the result, wrapped:

```
<project-memory>
What this project already knows. Treat it as established fact, and search
the memory tools before re-investigating anything mentioned here.
…
</project-memory>
```

Memory is context, not a precondition. Any failure (a slow gateway, an unreadable file) is swallowed and the agent starts anyway.

### The hook path

`hooks/session-start.sh` runs on every fresh Claude session and does three things in order:

1. Registers the session id (`POST /api/hooks/status` with `source`), retrying once after 1 s: a lost registration would make the stale-session guard ignore every later post from that session.
2. `GET /api/agents/:id/bootstrap`: identity, worktree, saved role prompt, the project's team roster with each teammate's status/branch/skills, and orchestration or working rules. This is what makes the "who am I / who is my team" handshake automatic instead of a ritual at the start of every session.
3. `GET /api/memory/context?project_path=…` for the digest.

Both are concatenated and returned as `hookSpecificOutput.additionalContext`. The API token is read from `~/.dorothy/api-token` and passed via `-H @<(printf …)` so it never appears in the process list.

`hooks/post-tool-use.sh` feeds `POST /api/memory/remember`, appending to the observation ledger (capped at 1000 lines, trimmed to 500). Content is truncated to 500 chars, type to 40.

### Digest budget

`MAX_SECTION_CHARS` 4000 per file, `MAX_OBSERVATIONS` 15, Hermes fetch raced against a 4 s (3 s at spawn time) timeout. A gateway that is down must not delay the agent.

---

## §6 Usage accounting

Two independent ledgers, because no single source covers everything.

### Source A: transcript parsing (Claude only)

`electron/services/transcript-usage.ts`. Claude Code only writes `~/.claude/stats-cache.json` for some account types; without it the Usage page had no tokens and therefore no cost at all. Every assistant message in `~/.claude/projects/**/*.jsonl` carries its own `usage` block, so the numbers are read from there.

- Walks `~/.claude/projects` to depth 4, collecting `*.jsonl`.
- Cheap pre-filter: skip any line not containing `"usage"`.
- Keeps only `type === 'assistant'` entries with a `message.usage`.
- **De-duplication.** Resuming a session copies earlier assistant messages into the new transcript: on a real history that is over half the lines, so counting them twice would roughly double every cost on the page. Key: `` `${message.id}:${entry.requestId}` ``, skipped if already seen (the degenerate `":"` key is exempt).
- `modelUsage` is an `Object.create(null)` map. A transcript's model id is attacker-influenceable and `modelUsage[model] ||= …` on a plain object would let `"__proto__"` write onto `Object.prototype` inside the main process; `__proto__`, `constructor`, `prototype` and `<synthetic>` are rejected outright.
- 60 s memo.

**Cache-write pricing.** `usage.cache_creation` splits into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`; when the split is absent, the whole `cache_creation_input_tokens` figure is treated as 5-minute. models.dev publishes `input`, `output`, `cache_read` and the 5-minute `cache_write`. The 1-hour write is **derived**, not guessed: Anthropic prices the 5-minute write at 1.25× base and the 1-hour write at 2× base, so `cache1h = input * 2`. Missing `cache_read` falls back to `input * 0.1`.

```
cost = input/1e6·p.input + output/1e6·p.output
     + cacheRead/1e6·p.cacheRead
     + write5m/1e6·p.cache5m + write1h/1e6·p.cache1h
```

`web_search_requests` from `usage.server_tool_use` is counted but not priced. Daily buckets key on `timestamp.slice(0,10)`.

`getClaudeStats()` merges: `stats-cache.json` → `statsig_user_metadata.json` → local-file computation; if none of them produced a non-empty `modelUsage`, transcript usage is spliced in.

### Source B: the usage ledger (every provider)

`electron/services/usage-ledger.ts`, `~/.dorothy/usage-ledger.jsonl`.

No CLI other than Claude Code writes transcripts, which is why "Usage by Provider" showed nothing: it read a file only the statusline wrote, and the statusline is off by default. Every ACP turn reports its tokens, so `recordUsage()` writes them as they happen: the only source that covers Codex, Gemini, Grok and the rest.

```ts
interface UsageEntry {
  ts; agentId; provider; model?;
  inputTokens; outputTokens; cachedReadTokens?; cachedWriteTokens?;
  costUSD?; transport: 'acp' | 'pty';
}
```

When the agent did not report a cost, `recordUsage` prices the turn itself from `priceFor(model, provider)`, using the same `cache_read ?? input*0.1` / `cache_write ?? input*1.25` fallbacks. `ProviderTotals.measured` is meant to record whether at least one entry carried a cost from the agent rather than from the catalogue, but `providerTotals()` initialises it to `false` and nothing ever sets it.

Bounded: appended per turn, trimmed to the last 12 000 lines once it passes 20 000. `providerTotals(sinceDays)` and `dailyCost(sinceDays = 30)` back the `usage:by-provider` IPC channel.

### The statusline

`electron/utils/statusline.ts` writes `~/.dorothy/statusline.sh` and points `statusLine` in `~/.claude/settings.json` at it. It renders context %, branch, session duration, lines changed and token throughput inside the Claude TUI, and caches quota data in `~/.dorothy/rate-limits.json`. Disabling it removes the script, the settings key and the cached quota so the Usage page stops showing a stale figure.

---

## §7 Persistence

Everything the app owns lives under `~/.dorothy` (`DATA_DIR`). `~/.claude-manager` is migrated in on first run and then deleted.

| Path | Shape | Written by | Durability |
|---|---|---|---|
| `agents.json` | `{ version: 2, savedAt, agents: AgentStatus[] }` | `saveAgents()` | **Atomic**: temp file + `rename`. Backup taken only from content that just parsed successfully, so a corrupt file cannot overwrite the last good copy |
| `agents.backup.json` | same | `saveAgents()` | restored automatically when `agents.json` is unparseable or empty |
| `agents.json.corrupt` | verbatim copy | `loadAgents()` | kept for inspection instead of silently replaced |
| `app-settings.json` | `AppSettings` | `saveAppSettingsToFile()` | plain `writeFileSync`, non-atomic |
| `api-token` | 64 hex chars | `initApiToken()` | mode `0600`, regenerated if shorter than 32 chars |
| `hermes-webhook-secret` | opaque string | Hermes handlers | the one credential published over the tailnet |
| `hermes-connection.json` | `HermesConnection` | `writeHermesConnection()` | non-atomic |
| `projects.json` | `string[]` | `writeCustomProjects()` | also the allowlist for `local-file://` |
| `templates.json` / `templates.backup.json` | `{ user: AgentTemplate[], overrides }` | template handlers | backup pair |
| `team-templates.json` | `{ user: TeamTemplate[] }` | team-template handlers | builtins are code, not data |
| `kanban-tasks.json` | `KanbanTask[]` | kanban handlers | local board only; the Hermes board is remote |
| `vault.db` + `vault/` | SQLite (WAL, FK on) + `vault/attachments/` | better-sqlite3 | transactional |
| `usage-ledger.jsonl` | one `UsageEntry` per line | `recordUsage()` | append-only, self-trimming at 20 000 → 12 000 |
| `observations/<encoded>.jsonl` | one `Observation` per line | `/api/memory/remember` | append-only, 1000 → 500 |
| `model-catalog.json` + `.meta.json` | models.dev payload + `{ etag, fetchedAt }` | `writeCache()` | "a cache we cannot write is a slower app, not a broken one" |
| `acp-registry.json` | `{ fetchedAt, agents }` | `writeCache()` | same |
| `rate-limits.json` | quota snapshot | `statusline.sh` | deleted when the statusline is disabled |
| `cli-paths.json` | per-binary overrides | CLI-paths handlers | |
| `telegram-downloads/` | media from Telegram | Telegram bot | |
| `CLAUDE.md` | Tars's own agent instructions | `ensureTarsClaudeMd()` | mounted read-write into every agent via `--add-dir` |
| `statusline.sh` | generated bash | `enableStatusLine()` | mode `0755` |

Files Tars writes **outside** its own directory:

| Path | Why |
|---|---|
| `~/.claude.json` → `projects[path].hasTrustDialogAccepted` | `--dangerously-skip-permissions` skips *runtime* prompts; Claude Code's workspace-trust dialog is a separate gate keyed on this flag. Pre-writing it is the only way a bypass-mode agent never sees it |
| `~/.claude.json` → `mcpServers.{gbrain,honcho}` | remote memory backends |
| `~/.claude/settings.json` → `hooks`, `statusLine` | eight hook types, merged rather than replaced |
| `~/.claude/mcp.json` | fallback when `claude mcp add` fails |
| per-provider MCP config files | `codex`, `gemini`, `grok`, `opencode`, `pi` |
| `<project>/.worktrees/<branch>` | git worktrees |

### `AgentStatus`: what survives a restart

`persistable()` strips `ptyId` and `pathMissing`, truncates `output` to the last 100 chunks, and demotes `running` to `idle`. `loadAgents()` additionally clears `ptyCwd`, `currentSessionId`, `lastKilledSessionId` and `waitingReason`, marks `pathMissing` for vanished directories, and runs two migrations: `skipPermissions: boolean → permissionMode`, and name-substring orchestrator detection → the persistent `role` field. `orchestratorMode` stays an independent tool-restriction toggle and must **not** promote an agent into the Telegram/Slack super-agent pool.

Live output is bounded at 600 chunks, spliced back to 400 (`OUTPUT_CHUNK_CAP` / `OUTPUT_RETAIN`): five PTY handlers pushed into `agent.output` and none of them capped it, so a chatty CLI grew that array for the life of the app, once per agent. Fields mutated on every PTY chunk (`output`, `statusLine`, `lastActivity`) set a dirty flag flushed every 30 s, bounding what a crash loses.

---

## §8 Bundled MCP servers

Seven servers ship in `extraResources` as `<name>/dist/bundle.js` and are registered with every provider on boot by `setupMcpOrchestrator()`:

| Directory | Registered as | Provides |
|---|---|---|
| `mcp-orchestrator` | `claude-mgr-orchestrator` | agent lifecycle + delegation + messaging |
| `mcp-memory` | `tars-memory` | the four memory tools of §5 |
| `mcp-telegram` | `claude-mgr-telegram` | Telegram send (text/photo/video/document) |
| `mcp-kanban` | `claude-mgr-kanban` | task board |
| `mcp-vault` | `claude-mgr-vault` | documents, folders, search, attachments |
| `mcp-socialdata` | `dorothy-socialdata` | X/Twitter read |
| `mcp-x` | `dorothy-x` | X/Twitter post |

Plus `tasmania` when `tasmaniaEnabled` and the configured path exists. `DOROTHY_MANAGED_MCPS` holds eight names: the six above plus `tasmania` and `google-workspace`; they are hidden from the Custom MCP settings UI. `tars-memory` is not in the set.

Registration is idempotent: `isMcpServerRegistered(name, expectedServerPath)` compares the last argv element. The Claude implementation checks both `~/.claude.json` (where `claude mcp add -s user` actually writes) and `~/.claude/mcp.json`; checking only the latter meant the answer was always `false` and every server was re-registered by spawning the CLI, once per claude-family provider, on every boot. The registration loop yields with `setImmediate` between servers: it runs on the main thread, the one that paints the window and pumps every PTY.

---

## §9 The Hermes gateway

Tars deliberately has no scheduler and no server-side task harness. Both live in the user's Hermes instance, and Tars is a client.

`electron/types/hermes.ts` models four connection modes:

| Mode | Base URL |
|---|---|
| `local` | `http://127.0.0.1:<localPort ?? 9119>` |
| `ssh` | `http://127.0.0.1:<ssh.localPort ?? ssh.remotePort ?? 9119>` (tunnel) |
| `remote` / `cloud` | the configured absolute URL |

Two auth flavours, advertised on the public `GET /api/status`: a static `X-Hermes-Session-Token` header, or a real cookie sign-in via `POST /auth/password-login`. The cookie jar is a `Map` in the main process and never reaches the renderer; an empty `Set-Cookie` value deletes the entry rather than storing a blank.

Consumed surfaces: `/api/memory` (files, state, session search, source `hermes` in §5), `/api/plugins/kanban` (the board behind `/kanban`), and the cron endpoints behind `/crons`.

### Inbound webhook

`POST /api/webhooks/hermes` lets a Hermes cron job or automation blueprint drive a Tars agent.

- Auth: `~/.dorothy/hermes-webhook-secret` if present, with the master API token still accepted so an existing setup keeps running. This route is the one thing published over the tailnet, so it carries its own secret.
- Body: `agent_id` **or** `agent_name` (case-insensitive exact match, narrowed by `project_path`; ambiguity → 409 listing the matches), `message`, optional `model` / `permission_mode` / `dry_run`.
- `dry_run: true` proves auth and agent resolution without dispatching.
- Otherwise it calls the same `performDispatch()` as `/api/agents/:id/dispatch`, so semantics are identical.
- Reachability from a VPS is the operator's job: `tailscale serve 31415` or an equivalent tunnel, since the API binds to `127.0.0.1`.

---

## §10 Surfaces

14 route files under `src/app/`. Cross-referenced with `design/UI-INVENTORY.md` (note that inventory's header says "Pages (13)" while its table lists 14 rows).

| Route | Name | What it is | Frame |
|---|---|---|---|
| `/` | Dashboard | The terminal grid. Every running agent as a live xterm pane, project tab bar, layout presets, add-agent dropdown | `Dashboard · dark` / `· light` |
| `/agents` | Agents | Roster with per-project filter tabs, sort by created/status/activity/name, management card per agent | `Agents · dark` |
| `/projects` | Projects | Project registry (backed by `~/.dorothy/projects.json`), file browser, per-project agent view. 1153 lines | `Projects · dark` |
| `/kanban` | Kanban | Two sources: the Hermes board (default, Hermes owns the task harness) and the local `kanban-tasks.json` board. Choice persisted in `localStorage` | `Kanban · dark` |
| `/crons` | Schedules | Hermes cron jobs: list, pause, resume, trigger, delete. Tars owns none of this | `Schedules · dark` |
| `/review` | Review | What the agents actually changed. Per-worktree column, changed-file list with add/delete counts, real patches. Replaced a 20-line `git diff --stat` | `Review · dark` |
| `/logs` | Logs | One search box for the whole fleet, over the retained output buffers. Plain substring, or `/regex/` when delimited | `Logs · dark` |
| `/usage` | Usage | Cost and tokens: transcript-derived Claude figures merged with the cross-provider ledger, daily chart, per-model and per-provider tables, catalogue freshness. 1277 lines, the largest page | `Usage · dark` / `· light` |
| `/memory` | Brain | The five sources of §5, in three tabs: Projects (native `~/.claude/projects/*/memory/` files, editable), Agents, Backends (probed status) | `Brain · Projects` / `· Agents` / `· Backends` |
| `/vault` | Vault | Agent reports and working documents in SQLite. Long-term memory lives in Brain, not here | `Vault · dark` |
| `/skills` | Extensions | Two tabs: Skills and Plugins, with marketplace fetch and an install terminal | `Extensions · Skills` / `· Plugins` |
| `/settings` | Settings | 6 groups, 17 sections (see below) | 17 frames |
| `/whats-new` | What's new | `src/data/changelog.ts`; marks itself seen in `localStorage` and fires a `whats-new-seen` event the sidebar listens for | `What's new · dark` |
| `/tray-panel` | Tray panel | Rendered inside the menu-bar popover window, fed by the `agents:tick` broadcast. Overrides xterm's viewport scrollbar so it overlays instead of stealing columns | `Tray panel` |

Settings groups: **General** (Preferences, Terminal, Notifications, System) · **AI & Providers** (Providers, CLI Paths, Permissions) · **Hermes** (Connection) · **Integrations** (Telegram, Slack, X, Google Workspace) · **Extensions** (Skills & Plugins, Custom MCP, Tasmania) · **Workspace** (Git, Memory Backends).

14 overlays are inventoried separately: New agent (4 steps), Deploy team, the four template dialogs, three kanban dialogs, Start prompt, Agent terminal, Plugin install, Install terminal.

Every data surface must show five states: loading (nothing under 400 ms, then a skeleton in the real shape of the content, then a named slow operation), empty, error, needs-sign-in, permission-denied.

### The tick

`scheduleTick()` coalesces to one `agents:tick` broadcast per 500 ms carrying the whole roster: id, name, character, raw status, `displayStatus`, status line, current task, project name, last activity, provider. `displayStatus` derives `working | waiting | done | error` from status, and splits `idle` into `ready` (a PTY exists) or `stopped`. The tray badge lights when any agent is `waiting`.

---

## §11 Security model

### Electron hardening

`electron/core/window-manager.ts`:

```ts
webPreferences: { preload, contextIsolation: true, nodeIntegration: false, webviewTag: false }
```

`hardenWindow()` applies three guards. The renderer holds the whole `electronAPI` bridge; a link in a vault note, a redirect from injected content or a `window.open` would otherwise land remote content in a renderer that can spawn PTYs and read the filesystem:

- `will-navigate`: anything not `app://`, `http://localhost:` or `http://127.0.0.1:` is prevented and handed to `shell.openExternal`.
- `setWindowOpenHandler`: always `{ action: 'deny' }`; `http(s)` URLs go to the system browser.
- `will-attach-webview`: prevented.

`certificate-error` is only overridden for `https://localhost`.

### The `local-file://` protocol

Registered as standard + secure + fetch-capable. Confined by `isUnderAllowedRoot()` to `~/.dorothy`, `~/.claude`, and the project roots read fresh from `~/.dorothy/projects.json` on every request (so a newly added project works at once). Containment is checked on `path.resolve`d paths with an explicit separator boundary. Unrestricted, this protocol served `~/.ssh/id_rsa` and `~/.aws/credentials` to anything that could put a URL in the renderer.

### The IPC boundary

`electron/preload.ts` (664 lines) exposes exactly one object, `window.electronAPI`, over `contextBridge`. It is a hand-written façade: no `ipcRenderer` passthrough, no dynamic channel names. 162 `ipcMain.handle` channels sit behind it, grouped `pty:`, `agent:`, `app:`, `settings:`, `fs:`, `project:`, `shell:`, `template:`, `teamTemplate:`, `kanban:`, `vault:`, `memory:`, `obsidian:`, `models:`, `usage:`, `review:`, `logs:`, `mcp:`, `skill:`, `plugin:`, `hermes:`, `gws:`, `tasmania:`, `telegram:`, `slack:`, `jira:`, `xapi:`, `socialdata:`, `orchestrator:`, `dialog:`, `cliPaths:`, `tray:`, `api:`. Every event subscription returns its own unsubscribe closure.

### What is validated where

| Value | Where | Rule |
|---|---|---|
| Model name | `agent:create` IPC **and** `POST /api/agents` **and** each provider's `buildInteractiveCommand` | `/^[a-zA-Z0-9._\-\/:@]+$/` (IPC) and `/^[a-zA-Z0-9._:\/\[\]-]+$/` (provider, allowing `[1m]`); throws otherwise |
| Effort | `agent:create` IPC and `POST /api/agents` and `safeEffort()` | allowlist of five values, checked again at the point of use |
| Provider id | `POST /api/agents` | `isValidProvider()` |
| Branch name | `resolveWorktreePath()` | `/^[A-Za-z0-9][A-Za-z0-9._/-]*$/`, no `..`, no `//`, no trailing `/` `.` `.lock`, no `@{`, ≤200 chars, **plus** a resolved-path containment check against `<project>/.worktrees`. The old regex admitted `.` and `/` and therefore `../../..`; `path.join` resolved outside the project, the "worktree already exists, reusing it" branch never invoked git, and the agent was spawned with its cwd there. `../../../etc` was enough |
| Memory file name | `writeProjectMemory()` | `/^[A-Za-z0-9._-]+\.md$/` |
| Memory sources | `parseSources()` | allowlist of the five ids |
| Vault attachment path | `GET /api/local-file` | must resolve under `<VAULT_DIR>/attachments` |
| Transcript model id | `computeTranscriptUsage()` | null-prototype map; `__proto__` / `constructor` / `prototype` rejected |
| Request body | `api-server.ts` | 4 MB cap enforced *while streaming* (it reads before routing, and on auth-exempt hook paths, so an unbounded stream was a way to exhaust main-process memory with no credential at all); `__proto__` and `constructor` deleted from the parsed object |
| Git arguments | `git-review.ts` | `execFile` with an argv array: no shell, so a branch or path containing a quote or a semicolon is data, not syntax |

### The local API

| Control | Value |
|---|---|
| Bind | `127.0.0.1:31415` (`DOROTHY_API_PORT` overrides, for a sandboxed E2E instance) |
| Auth | `Authorization: Bearer <~/.dorothy/api-token>`, 32 random bytes, file mode `0600` |
| Auth-exempt | `/api/health`, `/api/hooks/*`, `/api/local-file`, `/api/kanban/complete`, all called by shell hooks that send no `Origin` |
| Origin guard | any request with an `Origin` other than `app://-` or `http://localhost:3000` is 403'd **before** auth. A browser tab on any site can reach `127.0.0.1`; CORS hides the response but not the side effect |
| Body | 4 MB, prototype-pollution keys stripped |
| Route matching | first match wins; regex routes map their first capture group to `params.id` |

43 routes are registered across nine modules: health (1), hooks (5), agents (13), telegram (4), slack (1), kanban (2), vault (10 + `local-file`), memory (5), webhooks (1).

### Residual risk

- Any process running as the user can read `~/.dorothy/api-token` and drive every agent. This is the intended trust model for a single-user desktop app, but it is a flat one: the token is not scoped per agent.
- `permissionMode: 'auto'` is the default for agents created over the API and maps to `--permission-mode auto` (only `bypass` emits `--dangerously-skip-permissions`), and `ensureProjectTrusted()` pre-accepts the workspace-trust dialog. An agent has the user's full filesystem authority inside its cwd and beyond.
- API keys for the ten alt providers are stored in plaintext in `app-settings.json` and passed to the CLI as `ANTHROPIC_API_KEY` in the PTY environment.

---

## §12 Build and packaging

| | |
|---|---|
| App id | `xyz.cooperlabs.tars` · product name `Tars` |
| Entry | `electron/dist/main.js` (TypeScript compiled by `tsc -p electron/tsconfig.json`) |
| Renderer | `ELECTRON_BUILD=1 next build` with `src/app/api` and `src/app/icon.tsx` moved aside behind an `EXIT` trap, output to `out/` |
| MCP servers | each `mcp-*` built with its own esbuild bundle, shipped as `extraResources` filtered to `package.json` + `dist/bundle.js` |
| asarUnpack | `out/`, `hooks/`, `electron/resources/`, `better-sqlite3`, `node-pty` |
| Target | macOS dmg + zip, hardened runtime, `build/entitlements.mac.plist`, notarized via `@electron/notarize` |
| Updates | `electron-updater` against `JeanBrasse/Tars` releases |
| Node | ≥20, `.nvmrc` pinned |

Tests: `vitest run` over `__tests__/**/*.test.ts` (node environment, `@` aliased to `src/`), with coverage scoped to `electron/{constants,utils,services,handlers,providers}` and the MCP server sources. Suites exist for the ACP client, the model catalogue, transcript usage, the memory hub, agent persistence, the PTY manager, four providers, delegation plumbing, and two dedicated security files.

E2E: Playwright, `testDir: ./e2e`, one worker, serial: one Electron instance drives every surface. Screenshots at `e2e/__screenshots__/`. `npm run e2e:guard` checks a hardcoded list of ten routes (`/`, `/agents`, `/kanban`, `/vault`, `/projects`, `/skills`, `/usage`, `/memory`, `/settings`, `/whats-new`) against the E2E manifest; `/crons`, `/review`, `/logs` and `/tray-panel` are not checked, and `design/UI-INVENTORY.md` is read only to count overlay entries.

---

## §13 Known limitations

- **Delivery over the PTY is fire-and-forget.** `/dispatch` returns when bytes are written. Only `/run-task` returns a receipt.
- **Status lifecycle depends on hooks, which four providers do not have.** `codex`, `grok`, `opencode` and `pi` only ever transition on PTY exit. `wait_for_agent` and `lastCleanOutput` are effectively unavailable for them on the terminal path.
- **The `/run-task` status event name does not match what `/wait` listens on.** `emit('status', …)` vs `` `status:${agentId}` ``.
- **The caller-identity header name has drifted between the MCP source and the server.** Shipped bundles still send the old name and work; rebuilding the MCP servers disables project scoping and 403s every guarded route until one side is renamed.
- **`pi` has no ACP fallback entry.** If the ACP registry has never been reachable, `pi` has no ACP mode at all.
- **`app-settings.json`, `hermes-connection.json` and `projects.json` are written non-atomically.** Only `agents.json` is written atomically (temp file plus `renameSync`); `templates.json` gets a backup copy but is then overwritten in place.
- **`agent.output` retains 600 chunks live and 100 on disk.** `/logs` searches only what is retained; there is no persistent log store.
- **The API token is a single flat credential.** No per-agent scoping, no rotation UI.
- **The webhook is the only surface designed to leave the machine**, and it needs an operator-provided tunnel; nothing in the app opens one.
- **`installBundledSkills()` currently ships nothing.** Its only remaining job is deleting stale `world-builder` copies left by older versions, and only when the file content is recognizably ours.
- **macOS only.** `electron-builder` targets `--mac`; `window-all-closed` quits on other platforms but nothing else is tested there.
