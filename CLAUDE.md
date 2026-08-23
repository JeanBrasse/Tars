## Project Context

- **App**: Tars — an Electron desktop app that runs many AI coding-agent CLIs in parallel, each in its own PTY terminal, and orchestrates them
- **Goal**: one window where a fleet of agents (Claude Code, Codex, Gemini, Grok, OpenCode, Pi, and nine API-key providers) work on your projects at once, are delegated to, report back, and are billed
- **Repo**: https://github.com/JeanBrasse/Tars — a fork of `Charlie85270/Dorothy`, renamed to Tars. Nothing is ever pushed upstream; `git remote get-url --push upstream` returns `DISABLED-no-push`
- **Bundle**: `xyz.cooperlabs.tars`, product name `Tars`, macOS only (`electron-builder --mac`, dmg + zip). Updates are published to and fetched from the fork — `GITHUB_REPO` in `electron/constants/index.ts` and `build.publish` in `package.json` both say `JeanBrasse/Tars`
- **Docs**: `DESIGN.md` (tokens + components) is the only one written so far. Read it before touching a pixel. `SPECS.md` (what it is), `OPERATIONS.md` (runbook) and `ETHOS.md` (how decisions get made) are still to be written — do not cite them as if they existed

## Stack

- **Shell**: Electron 43, main process in `electron/` (~23k lines TypeScript, compiled to `electron/dist/` by `tsc -p electron/tsconfig.json`, CommonJS, ES2022)
- **Renderer**: Next.js 16.3 App Router, React 19, TypeScript, Tailwind CSS 4, `~39.5k` lines in `src/`. Packaged as a static export (`output: 'export'` when `ELECTRON_BUILD=1`) and served over a custom `app://` protocol
- **Terminals**: `node-pty` + `xterm` 5 / `xterm-addon-fit`
- **State**: React hooks over IPC (`src/hooks/`), plus a small `zustand` store (`src/store/`) for sidebar/vault UI state
- **Local API**: a plain `node:http` server on **31415**, bearer-token authenticated, so the CLIs' hooks and the bundled MCP servers can call back into the app
- **MCP**: seven servers in `mcp-*/`, each bundled to `dist/bundle.js` and shipped in `extraResources`: orchestrator, memory, telegram, kanban, vault, socialdata, x
- **Delegation**: two transports — keystrokes written into the PTY (`/dispatch`), and the Agent Client Protocol (`electron/services/acp/`), which actually returns a result
- **Storage**: JSON + SQLite under `~/.dorothy/` (`better-sqlite3` for the vault). No server, no cloud, no database migrations
- **Tests**: `vitest` (unit, `__tests__/`), `@playwright/test` driving the real Electron app (`e2e/`)
- **Node**: 22, pinned in `.nvmrc`. Run `nvm use` first. `package.json` `engines` still declares a `>=20` floor and CI runs 20 — develop on 22

## Key Files

| Path | What lives there |
|---|---|
| `electron/main.ts` | Entry point. Wires window, agent state, IPC, Telegram/Slack bots, the HTTP API, the tray, the MCP orchestrator, and the model catalogue |
| `electron/preload.ts` | The only bridge to the renderer — `contextBridge.exposeInMainWorld('electronAPI', …)`. Every new IPC channel is declared here first |
| `electron/constants/index.ts` | `DATA_DIR` = `~/.dorothy`, `API_PORT` = 31415, the file paths for agents/settings/kanban/vault/token, `GITHUB_REPO`, the MIME map used by the `app://` handler |
| `electron/types/index.ts` | `AgentStatus`, `AppSettings`, `CLIPaths`, `AgentProvider`, `AgentPermissionMode`, `AgentEffort`. A new setting or provider starts here |
| `electron/core/agent-manager.ts` | The agent `Map`, persistence to `agents.json`, `initAgentPty`, `ensureProjectTrusted` (pre-writes `hasTrustDialogAccepted` in `~/.claude.json`), `killStalePty` |
| `electron/core/pty-manager.ts` | Four PTY maps (agent / quick / skill / plugin), `killAllPty`, and `writeProgrammaticInput` — the bracket-paste + delayed `\r` dance Claude Code's TUI requires |
| `electron/core/window-manager.ts` | `BrowserWindow` (1600×1000, `hiddenInset`, `#121212`), window hardening, and the `app://` and `local-file://` protocol handlers |
| `electron/handlers/ipc-handlers.ts` | 2581 lines, nearly every `ipcMain.handle`. Start here when a renderer call has no backend |
| `electron/providers/cli-provider.ts` | The `CLIProvider` contract: interactive / scheduled / one-shot command builders, PTY env, hook config, `readAppSettingsFromDisk()` |
| `electron/providers/index.ts` | Registry of the 15 providers. Unknown ids (and `local`) fall back to Claude |
| `electron/services/api-server.ts` | The 31415 server. Token generated into `~/.dorothy/api-token` at `0600`; 4 MB body cap; only `/api/local-file`, `/api/health`, `/api/hooks/*` and `/api/kanban/complete` are exempt from auth |
| `electron/services/api-routes/agent-routes.ts` | `spawnAgentSession()` — the **single** path for API-driven sessions — plus `/start`, `/dispatch`, `/message`, `/delegate`, `/bootstrap`, `/health`, and the cross-project guard |
| `electron/services/api-routes/hooks-routes.ts` | The session-ownership contract: SessionStart registers via the `source` field; posts from any other session, or from the `lastKilledSessionId` tombstone, are rejected as `stale` |
| `electron/services/acp/` | `client.ts`, `delegate.ts`, `registry.ts`. Delegation that returns — stop reason, tools used, tokens, cost |
| `electron/services/mcp-orchestrator.ts` | Resolves the seven bundled servers under `process.resourcesPath` and writes them into each CLI's MCP config |
| `electron/services/model-catalog.ts` | Live model list and per-million-token prices from models.dev, cached at `~/.dorothy/model-catalog.json`, with a compiled-in floor. Never let a network failure zero a price |
| `electron/services/usage-ledger.ts`, `transcript-usage.ts` | The two token sources: ACP turns recorded as they happen (covers every CLI), and `~/.claude/projects/**/*.jsonl` reconstructed after the fact (Claude only) |
| `electron/services/memory-hub.ts` | The Brain page's backends — Hermes, gbrain, Honcho — over MCP HTTP |
| `electron/services/git-review.ts` | The Review page. Every git call goes through `execFile` with an argv array, never a shell |
| `electron/utils/worktree-path.ts` | Where an agent's worktree is allowed to live. The traversal guard — read the comment before relaxing anything |
| `src/types/electron.d.ts` | Renderer-side mirror of the preload surface. Must be updated in the same commit as `preload.ts` |
| `src/app/globals.css` | The entire token system — `--bg-*`, `--text-*`, `--accent-*`, `--success/warning/danger/info`, `--chart-*` — for light and `.dark` |
| `src/components/ui/index.ts` | `Button`, `Label/Input/Select/Textarea`, `Dropdown`, `StatusBadge`, `Loading`, `PageHeader`. The only directory allowed to define raw appearance |
| `src/components/ClientLayout.tsx` | The shell: sidebar + header, and the theme boot (`tars-theme` in `localStorage`, dark unless explicitly `light`) |
| `src/components/TerminalsView/` | The xterm grid that is the Dashboard, including the scroll-lock and multi-terminal hooks |
| `src/lib/providers.ts` | Frontend provider registry — icon, badge, models, default model. One entry per provider; NewChatModal and Settings both read it |
| `design/dorothy-redesign.pen` | Pencil source of truth, 63 frames. **Encrypted** — reach it only through the `pencil` MCP tools, never `Read`/`Grep` |
| `design/UI-INVENTORY.md` | Every surface the app can render. The E2E guard reads it. Its header still names the document `design/tars.pen` — that file does not exist, the Pencil source is `dorothy-redesign.pen` |
| `e2e/surfaces.mjs` | Executable manifest: 16 pages, 16 settings sections, 3 overlays = 35 surfaces |
| `scripts/design-lint.sh` | The design guardrail. Bans inline `borderRadius`, `shadow-*`, `bg-gradient`, `animate-ping`, and the raw Tailwind palette outside `src/components/ui/` |
| `scripts/sandbox.sh` | A second Tars beside your real one: `HOME=~/Tars-sandbox`, API port 31499 |
| `hooks/` | Shell hooks installed into the CLIs. `session-start.sh` registers the session and injects `/bootstrap` + memory context; `user-prompt-submit.sh` / `on-stop.sh` own the status lifecycle |

## Environment Variables

There is no `.env` file and there never will be one. Every secret — bot tokens, provider API keys, Hermes tokens — lives in `~/.dorothy/app-settings.json`, written by the Settings pages and read by `readAppSettingsFromDisk()`. Do not add a dotenv loader.

The variables the code actually reads:

```
NODE_ENV              # 'development' → load DOROTHY_DEV_URL + open DevTools; otherwise app://-/index.html
DOROTHY_DEV_URL       # override the dev renderer URL (default http://localhost:3000; e2e uses :3100)
DOROTHY_API_PORT      # override the local API port (default 31415; sandbox 31499, e2e 31498)
DOROTHY_E2E           # '1' suppresses DevTools so screenshots are clean
ELECTRON_BUILD        # '1' switches next.config.ts to output: 'export' for packaging
PATH SHELL HOME       # read when composing the PTY environment (buildFullPath, cli-paths detection)
APPLE_ID              # notarization; unset → scripts/notarize.js uses the 'Tars' keychain profile
APPLE_APP_PASSWORD
APPLE_TEAM_ID
```

Injected by Tars **into** the processes it spawns — never set them yourself:

```
CLAUDE_AGENT_ID       # PTY + MCP child env; the MCP client sends it as X-Tars-Caller-Id
CLAUDE_AGENT_NAME     # used by mcp-vault as the document author
CLAUDE_PROJECT_PATH   # scopes /api/agents and the cross-project guard
CLAUDE_SKILLS         # comma-separated skill list for the session
CLAUDE_MGR_API_URL    # read by mcp-orchestrator; defaults to http://127.0.0.1:31415
ANTHROPIC_BASE_URL    # every alt provider runs the claude binary with these two rewritten
ANTHROPIC_API_KEY     # from app-settings.json, per provider
ANTHROPIC_MODEL
```

---

## Agent Roles & Boundaries

Four roles work this tree. They map to the long-lived branches `feat/frontend`, `feat/backend`, `feat/qa`. Never modify files outside your domain — if you need a change on the other side of the IPC boundary, say so and let the other agent make it.

### Frontend Agent
- **Owns**: `src/app/`, `src/components/`, `src/hooks/`, `src/lib/`, `src/store/`, `landing/`
- **Never touches**: `electron/`, `mcp-*/`, `hooks/`, `__tests__/`, `e2e/`
- **Design rule**: the frames in `design/dorothy-redesign.pen` and the tokens in `DESIGN.md` are the specification. Never invent a layout, a colour, or a control height. Controls are **26px** (small) or **32px** (standard) — nothing else. The shell is identical on every page: sidebar 240 wide (72 collapsed), header 84 tall with padding `22/26/14/26`, content `0/26/22/26`
- **Never** mark an active state with an accent rule — no 2px orange line under a tab, beside a menu item, or under a button. Active is a **box**: tinted fill, or surface plus border
- **Never** hardcode a hex or a raw Tailwind palette class outside `src/components/ui/`. `npm run lint:design` will catch you
- The mark is the orange square grid (`public/icon.svg`, `src/components/Splash.tsx`), never a `>_` terminal prompt
- Adding an IPC-backed feature: you may *consume* `window.electronAPI`, but the channel and its type in `src/types/electron.d.ts` come from the Backend Agent

### Backend Agent
- **Owns**: `electron/`, `mcp-*/`, `hooks/`, `scripts/`
- **Never touches**: `src/components/`, `src/app/`, `design/`
- **Owns the contract**: `electron/preload.ts` and `src/types/electron.d.ts` change together, in one commit, or the renderer breaks silently
- **Spawn rule**: `spawnAgentSession()` in `electron/services/api-routes/agent-routes.ts` is the only place an API-driven session is started — the skills prefix, MCP config, model flag, `--disallowed-tools`, workspace trust, identity header and `--add-dir ~/.dorothy` all live there. Underneath it, `initAgentPty()` in `electron/core/agent-manager.ts` is the one function that spawns a PTY; `main.ts`, `ipc-handlers.ts` and the Telegram/Slack bots already call it directly. Route new work through one of those two — do not add a third way in
- **Session rule**: status, output and task-completed posts are authoritative only from `agent.currentSessionId`. Anything from another session, or matching `lastKilledSessionId`, is `stale` and must be dropped. Never clear `currentSessionId` on idle
- **Shell rule**: no `exec`/`execSync` with an interpolated string. `execFile` with an argv array, as in `git-review.ts`. Paths derived from user input go through the guards in `electron/utils/worktree-path.ts`
- **Auth rule**: exactly four routes are exempt from the bearer token — `/api/local-file`, `/api/health`, `/api/hooks/*` and `/api/kanban/complete`. Anything you add under `/api/` is authenticated

### QA Agent
- **Owns**: `__tests__/`, `e2e/`, `vitest.config.mts`, `playwright.config.ts`
- **Read-only** everywhere else — report defects, do not patch them
- **Done when**: both `tsc` passes are clean, `npm test` is green, `npm run lint` and `npm run lint:design` are clean, and `npm run e2e` shows no new visual diff and no page error
- A visual diff is a finding, not a licence to re-record. `npm run e2e:update` is only run when the design was deliberately changed and the Pencil frame already reflects it

### Orchestrator
- **Writes no product code.** Splits work by domain, dispatches, merges, reports
- Delegates through the project's own agents rather than doing the work inline; only trivial one-line fixes and pure merge/report work are done directly
- Runs QA after every implementation step and before every merge
- Owns the branch and PR lifecycle described below

---

## Workflow Rules

### 1. Pencil first, always

Every design or feature change goes through, in this order:

1. **`design/dorothy-redesign.pen`** — the frame exists and is correct before any TSX is written
2. **The app** — `src/` implements the frame, not an approximation of it
3. **The landing page** — `landing/` picks up the change
4. **`README.md`** — last

Never the other way round. Do not "build it then draw it". If a surface is new, add it to `design/UI-INVENTORY.md` and to `e2e/surfaces.mjs` in the same change, or `npm run e2e:guard` fails.

Pencil traps that will cost you an afternoon:
- `filePath` is ignored — every mutation lands in the app's **active** document. Call `get_app_state` first and guard on a known variable before writing
- Insert the whole tree in **one** `Insert` with nested `children`. Parent-then-child inserts read back fine and export black
- Text needs `textGrowth: "fixed-width"` with a width; `width` alone wraps nothing
- Helpers do not persist between `execute` calls. Re-inject the prelude every time
- `stroke`/`strokeWidth` cannot be nulled — use `strokeWidth: 0`

### 2. Delivery

- Work on a feature branch. Never commit to `main` directly
- Deliver as a **PR into `JeanBrasse/Tars` `main`**, then merge it
- **Never push to `Charlie85270/Dorothy`.** Its push URL is deliberately set to `DISABLED-no-push`. If a command would push there, stop — you have the wrong remote
- Commit subjects say what changed for the user, in lowercase, prefixed `feat:` / `fix:` / `chore:` / `perf:` / `security:` / `test:` / `design:`
- `.worktrees/` and `.claude/worktrees/` are embedded checkouts of other branches. They are gitignored and eslint-ignored. Never edit a file inside them and never commit one

### 3. Verify before done

Nothing is complete until all of these pass. Run them from the repo root on Node 22:

```bash
nvm use                                  # 22, per .nvmrc
npx tsc --noEmit                         # renderer + shared
npx tsc -p electron/tsconfig.json        # main process (also emits electron/dist, needed by e2e)
npm test                                 # vitest, __tests__/**/*.test.ts
npm run lint                             # eslint
npm run lint:design                      # radius / shadows / gradients / raw palette
npm run e2e:guard                        # every inventory page is covered by the manifest
npm run e2e                              # Playwright drives the real Electron app, 35 surfaces
```

`npm run e2e` boots Electron with `HOME` pointed at a temp dir, so your real `~/.dorothy` and `~/.claude` are never touched. It asserts zero uncaught page errors per surface as well as the screenshot. Re-run `tsc -p electron/tsconfig.json` before it or you test a stale main process.

To see a change in a real packaged build without disturbing your live instance: `npm run electron:pack` then `npm run sandbox`.

### 4. Plan first, then execute autonomously

- Enter plan mode for anything with 3+ steps or an architectural decision. Write the problem, the constraints and the chosen approach before the first line of code
- Then just do it. No "shall I proceed?" — the answer is always yes
- Given a bug report, fix it: point at the log, the error, the failing test, resolve it
- If something goes sideways, stop and re-plan rather than pushing on

### 5. Root causes only

- No temporary fixes, no `// TODO: proper fix later`, no swallowing an error to make a symptom disappear
- Every change touches the minimum number of files. If a diff is growing sideways, you are solving the wrong problem
- New behaviour that another feature depends on is not done until a test asserts the whole chain, not that a mock was called

---

## Memory System

Tars exposes Claude Code's **native memory** (`~/.claude/projects/*/memory/`) via the Memory page. No custom storage — it reads real Claude Code memory files. Project directory names use path-as-folder-name encoding (slashes → dashes); see `electron/utils/decode-project-path.ts`.

## Memory

Use auto memory (`~/.claude/projects/.../memory/`) actively on this project:
- Save architectural decisions, key file locations, and debugging insights to `MEMORY.md`
- Create topic files (e.g. `patterns.md`, `debugging.md`) for detailed notes — keep `MEMORY.md` under 200 lines
- At session start, review `MEMORY.md` for relevant context before diving in
- After any correction or new discovery, update memory so the next session benefits

## Autonomy

When you are delegated a task by Tars or an orchestrator agent, **always act autonomously**:
- Do NOT ask for confirmation before proceeding — just do the work and report results
- Do NOT ask "Would you like me to continue?" or "Shall I proceed?" — the answer is always yes
- If a task is ambiguous, make reasonable assumptions and state them in your report
- Complete the full task and return your findings/output directly

---

## Core Principles

There is no `ETHOS.md` yet — until one exists, these three are the tie-breaker. They apply to every diff:

- **Simplicity first** — make every change as simple as it can be, and touch as little as possible
- **No laziness** — find the root cause, senior-developer standards, no temporary fixes
- **Prove it** — never mark a task complete without running the checks in Workflow Rule 3

---

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
