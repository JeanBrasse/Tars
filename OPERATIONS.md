# Tars — Operator Runbook

Tars runs on your own machine. There is no cluster, no cloud tenancy, no deploy.
Everything below is run locally from the repo root or against
the installed app.

Target platform is macOS: `electron-builder` is invoked with `--mac` only, the code-signing
config is `build/entitlements.mac.plist`, and the Tasmania integration reads a token out of
`~/Library/Application Support/`.

---

## Toolchain

### Node version

`.nvmrc` pins **22**. Use it:

```bash
nvm use          # reads .nvmrc → 22
node -v          # v22.x
```

`package.json` declares `"engines": { "node": ">=20" }`, and CI (`.github/workflows/ci.yml`)
runs the test job on Node 20. Both are true — but **Node 18 fails**, in two different ways:

```
# npm test on Node 18.16
file:///…/node_modules/rolldown/dist/shared/create-bundler-option-Cj0juyCQ.mjs:8
import { formatWithOptions, styleText } from "node:util";
                            ^^^^^^^^^
SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'
```

```
# next dev on Node 18.16
You are using Node.js 18.16.0. For Next.js, Node.js version ">=20.9.0" is required.
```

`util.styleText` landed in Node 20.12, and Vitest 4 → Vite 8 → rolldown imports it
unconditionally. Node 20.20.1 and 22.22.2 both run the full suite clean. If you see the
`styleText` SyntaxError, you are on the wrong Node — nothing else is wrong.

### Install

```bash
npm ci
```

`bun.lock` is committed alongside `package-lock.json`; the npm lockfile is the one CI uses.
The seven MCP servers under `mcp-*/` have **their own** `package.json` and are installed
separately by the build scripts (`cd mcp-memory && npm install && npm run build`, ×7). You do
not need them installed to run `npm run dev` or `npm test`.

---

## Development

### Run the app

```bash
npm run electron:dev
```

That is `concurrently` over two things:

1. `npm run dev` — `next dev` on port 3000.
2. `npm run electron:start` — `wait-on http://localhost:3000`, then
   `tsc -p electron/tsconfig.json`, then `NODE_ENV=development electron .`.

`main` is `electron/dist/main.js`, so **the main process is compiled every launch** by that
`tsc` step. If you edit anything under `electron/` you must restart — there is no watch.
The renderer hot-reloads normally.

In dev the window loads `process.env.DOROTHY_DEV_URL || 'http://localhost:3000'` and opens
DevTools automatically (suppressed when `DOROTHY_E2E=1`). In production it loads
`app://-/index.html` off the custom protocol, served from `<appPath>/out`.

### Run the renderer alone

```bash
npm run dev            # next dev, port 3000
npm run dev:network    # next dev -H 0.0.0.0, for a phone/tailnet client
```

`next.config.ts` already allows `http://100.92.4.122:3000` as a dev origin. The renderer alone
has no IPC bridge — every `window.electron.*` call is undefined, so most pages render empty.
Use it only for pure-layout work.

### Compile just the main process

```bash
npx tsc -p electron/tsconfig.json
```

`electron/tsconfig.json` emits CommonJS into `electron/dist/`, and its `include` list is
explicit: `main.ts`, `preload.ts`, `memory.ts`, `memory-parser.ts`, and
`types|constants|utils|core|services|handlers/**/*.ts`. `tsc` also compiles any file reached by
a transitive import from an included one, so a new directory is built as soon as something in
the list imports it — `providers/` is not in `include` yet `electron/dist/providers/` is
populated. A directory that nothing imports is the one that silently never gets compiled.

`electron/dist/` is gitignored and goes stale: it currently still contains
`automation-handlers.js`, `scheduler-handlers.js` and `world-handlers.js`, whose sources no
longer exist. `tsc` does not clean. If you are chasing a ghost, `rm -rf electron/dist` and
recompile.

### Run a second Tars beside your live one

```bash
npm run sandbox
# or: bash scripts/sandbox.sh /path/to/Tars.app
```

`scripts/sandbox.sh` launches `release/mac-arm64/Tars.app` with `HOME=$HOME/Tars-sandbox` and
`DOROTHY_API_PORT=31499`. That redirects `~/.dorothy`, `~/.claude` and
`~/Library/Application Support/Tars` into the sandbox, so agents, settings, the API token and
window state are all throwaway copies. Your production install (port 31415) is untouched and
keeps running.

The sandbox is **persistent** across launches. To reset it:

```bash
rm -rf ~/Tars-sandbox
```

Logs land in `~/Tars-sandbox/tars.log`.

> **Caveat the script does not mention:** the shell hooks in `hooks/` hardcode
> `http://127.0.0.1:31415` — all 14 occurrences. An agent spawned from the sandbox posts its
> status, output and observations to your **production** instance. Treat sandbox agent status
> as untrustworthy, and never debug the status lifecycle from the sandbox.

### Lint

```bash
npm run lint            # eslint (flat config, eslint.config.mjs)
npm run lint:design     # design guardrail, see below
```

---

## Tests and guardrails

Four separate gates. They do not overlap.

### Unit tests — `npm test`

```bash
npm test                # vitest run
npm run test:watch
npm run test:coverage
```

Current state: **46 files, 733 tests, ~5 s.** Config is `vitest.config.mts`: node environment,
globals on, `include: ['__tests__/**/*.test.ts']`, and an `@` → `src/` alias so renderer
modules resolve the same way Next resolves them.

Coverage (`v8`) is scoped to what is actually worth guarding: `electron/constants`,
`electron/utils`, `electron/services`, `electron/handlers`, `electron/providers`, plus
`mcp-orchestrator/src/{utils,tools}`, `mcp-telegram/src`, `mcp-kanban/src`.

Layout mirrors the source tree — `__tests__/electron/services/api-routes/*.test.ts`,
`__tests__/electron/providers/*.test.ts`, `__tests__/mcp/*.test.ts`. Two suites deliberately
print stack traces on success (`team-template-handlers` corrupt-store case, the security
suites); a stderr block is not a failure, read the final summary line.

`npm test` does **not** cover `src/` React components beyond two files
(`__tests__/components/`). The renderer is guarded by the E2E sweep instead.

### E2E surface sweep — `npm run e2e`

```bash
npx tsc -p electron/tsconfig.json    # REQUIRED — see below
npm run e2e
```

`playwright.config.ts` starts `npx next dev -p 3100` (reusing an existing server if one is
already up) and runs `e2e/surfaces.spec.ts` with `workers: 1`, `fullyParallel: false` — one
Electron instance drives every surface serially.

The spec launches the **real Electron app** (`electron.launch({ args: ['.'] })`) with:

| env | value | why |
|---|---|---|
| `HOME` | `mkdtemp('dorothy-e2e-')` | `~/.dorothy` and `~/.claude` are empty fixtures |
| `NODE_ENV` | `development` | loads the dev URL instead of `app://` |
| `DOROTHY_DEV_URL` | `http://localhost:3100` | |
| `DOROTHY_API_PORT` | `31498` | never collides with prod (31415) or sandbox (31499) |
| `DOROTHY_E2E` | `1` | suppresses `openDevTools()` |

The sandbox HOME is `rm -rf`'d in `afterAll`. Your live install is never touched.

**Nothing in the E2E path compiles the main process.** `main` points at
`electron/dist/main.js`; if it is stale or missing, Playwright launches an old build or fails
outright. Run `tsc -p electron/tsconfig.json` first, every time.

Per surface the spec does two things:

- asserts zero uncaught page errors — hydration errors are downgraded to a
  `known-issue` annotation (kanban, vault, brain each still emit them), any **other** uncaught
  error fails the surface;
- `toHaveScreenshot()` against `e2e/__screenshots__/<name>.png` with
  `maxDiffPixelRatio: 0.005`, `animations: 'disabled'`.

The manifest is `e2e/surfaces.mjs`: **16 pages + 16 settings sections + 3 overlays = 35
surfaces**. Note `e2e/__screenshots__/` holds **36** PNGs — `settings-obsidian.png` is an
orphaned baseline with no manifest entry. Delete it or add the surface back; it is currently
neither compared nor cleaned up.

Settings clicks are scoped to `getByTestId('settings-nav')` because labels collide with the
main navigation (`Extensions` is both a page and a settings group). If you rename a settings
group or child label, the corresponding surface times out at
`target.waitFor({ state: 'visible', timeout: 8000 })` — fix `SETTINGS_TREE`, not the timeout.

### Update baselines

```bash
npm run e2e:update      # playwright test --update-snapshots
git diff --stat e2e/__screenshots__/
```

Review the diff before committing. A redesign pass that legitimately changes one page should
not be re-baselining thirty.

The HTML report is written to `e2e/report/` (gitignored) — open `e2e/report/index.html`.
Traces are `retain-on-failure`.

### Coverage guard — `npm run e2e:guard`

```bash
npm run e2e:guard       # node e2e/check-coverage.mjs
```

Cross-checks the executable manifest against `design/UI-INVENTORY.md`. It fails (`exit 1`)
when a route in its `ROUTE_EXPECTATIONS` list (`/`, `/agents`, `/kanban`, `/vault`,
`/projects`, `/skills`, `/usage`, `/memory`, `/settings`, `/whats-new`) has no covering
surface. Overlays are *reported*, never enforced.

It currently prints `Overlays automatisés : 3 / 0 listés dans l'inventaire` — the `0` means its
regex (`^- \[[ x]\] \`(src/….tsx)\``) matched nothing in `design/UI-INVENTORY.md`. The guard
is passing on pages but is blind on overlays. If you restructure the inventory file, re-check
that number is non-zero.

### Design lint — `npm run lint:design`

```bash
bash scripts/design-lint.sh
```

Greps `src/**/*.tsx`, excluding `src/components/ui/` and `app/icon.tsx`, for five banned
patterns. Exits 1 on any hit:

| check | pattern |
|---|---|
| no inline border-radius | `style={{ borderRadius` |
| no drop shadows | `shadow-(sm\|md\|lg\|xl\|2xl)` |
| no gradients | `bg-gradient` |
| no decorative ping | `animate-ping` |
| no raw tailwind palette | `(text\|bg\|border)-(red\|green\|blue\|amber\|purple\|cyan\|yellow\|orange\|zinc\|slate\|gray)-[0-9]` |

The rule it enforces: `src/components/ui/` is the only place allowed to define raw appearance.
Currently green on all five.

### CI

`.github/workflows/ci.yml` runs on PRs to `main` and pushes to `main`: `ubuntu-latest`,
Node 20, `npm ci`, `npm test`. **That is all CI does** — no lint, no design lint, no E2E, no
build. Playwright needs a display and a mac build; run it locally before you merge anything
visual.

---

## Build and release

### Package unsigned (fast, for local testing)

```bash
npm run electron:pack
```

`tsc -p electron/tsconfig.json`, then build all seven MCP bundles, then
`electron-builder --dir --mac`. Output: `release/mac-arm64/Tars.app`. This is what
`scripts/sandbox.sh` expects.

Note `electron:pack` does **not** run `next build` — it packages whatever is already in `out/`.
Run `npm run build:renderer` first if the renderer changed.

### Build the renderer for packaging

```bash
npm run build:renderer
```

This is the tricky one. Expanded:

```bash
rm -rf .next out
mv src/app/api src/app/_api_backup
mv src/app/icon.tsx src/app/_icon_backup.tsx
trap "mv src/app/_api_backup src/app/api; mv src/app/_icon_backup.tsx src/app/icon.tsx" EXIT
ELECTRON_BUILD=1 next build
```

`next.config.ts` switches to `output: 'export'` when `ELECTRON_BUILD=1`, and a static export
cannot contain route handlers or a dynamic `icon.tsx` — hence the move-and-restore dance. The
`trap … EXIT` puts them back even on failure.

**If a build is killed with `SIGKILL` the trap does not run.** Symptom: `src/app/api` is gone
and the dev server 404s every renderer API route. Recover manually:

```bash
ls src/app | grep _backup
mv src/app/_api_backup src/app/api
mv src/app/_icon_backup.tsx src/app/icon.tsx
git status src/app
```

### Full signed build

```bash
npm run electron:build
```

`build:renderer` + `tsc` + all seven MCP bundles + `electron-builder --mac`
(targets `dmg` and `zip`). Output: `release/`.

electron-builder config lives inline in `package.json` under `"build"`:

- `appId: xyz.cooperlabs.tars`, `productName: Tars`, icon `public/icon.icns`
- `directories.output: release`
- `files`: `electron/dist`, `electron/resources`, `out`, `node_modules`
  (minus `@next/swc*`, `@next/env`, `@next/eslint-plugin-next`), `skills/`, `hooks/`
- `asarUnpack`: `out/**`, `hooks/**`, `electron/resources/**`,
  `node_modules/better-sqlite3/**`, `node_modules/node-pty/**` — the two native modules and
  everything read from disk by path at runtime
- `extraResources`: one entry per `mcp-*` directory, filtered to `package.json` +
  `dist/bundle.js`, landing in `process.resourcesPath/<name>/`

If `hooks/` or `out/` were left in the asar, `getHooksPath()` and `getAppBasePath()` — both of
which do `appPath.replace('app.asar', 'app.asar.unpacked')` — would resolve to nothing and the
app would boot with no hooks and a blank window.

### Signing and notarization

`build.mac` sets `hardenedRuntime: true`, `gatekeeperAssess: false`, and points both
`entitlements` and `entitlementsInherit` at `build/entitlements.mac.plist`:

```xml
com.apple.security.cs.allow-jit                      true
com.apple.security.cs.allow-unsigned-executable-memory true
com.apple.security.cs.disable-library-validation      true
com.apple.security.cs.allow-dyld-environment-variables true
```

All four are load-bearing: V8 needs JIT and unsigned executable memory, `better-sqlite3` and
`node-pty` are unsigned native `.node` files (library validation), and `node-pty` spawns login
shells that inherit `DYLD_*` from the environment.

`scripts/notarize.js` exports an `afterSign` hook that calls `@electron/notarize` — using the
keychain profile named `Tars` when `APPLE_ID` is unset, otherwise
`APPLE_ID`/`APPLE_APP_PASSWORD`/`APPLE_TEAM_ID`.

> **It is not wired up.** There is no `afterSign` key in the `build` block of `package.json`,
> so `electron-builder` never calls it. `npm run electron:build` today produces a signed but
> **un-notarized** app; on another Mac Gatekeeper will refuse it. Either add
> `"afterSign": "scripts/notarize.js"` to `build`, or notarize by hand:

```bash
xcrun notarytool submit release/Tars-1.5.0-arm64.dmg --keychain-profile Tars --wait
xcrun stapler staple release/Tars-1.5.0-arm64.dmg
spctl -a -vvv -t install release/mac-arm64/Tars.app
```

To create the keychain profile once:

```bash
xcrun notarytool store-credentials Tars \
  --apple-id <apple-id> --team-id <team-id> --password <app-specific-password>
```

### The update feed — and the repo mismatch

Two independent code paths check for updates, and **they point at different repositories**:

| path | target | source |
|---|---|---|
| `electron-updater` (`latest-mac.yml`) | `JeanBrasse/Tars` | `package.json` → `build.publish` |
| GitHub-API fallback | `JeanBrasse/Dorothy` | `electron/constants/index.ts` → `GITHUB_REPO` |

`electron/services/update-checker.ts` sets `autoDownload = false` and
`autoInstallOnAppQuit = true`, calls `autoUpdater.checkForUpdates()`, and **only** on throw
falls back to `GET https://api.github.com/repos/${GITHUB_REPO}/releases/latest` — comparing
`tag_name` minus a leading `v` against `app.getVersion()` component by component, then picking
the first `.dmg` or `.zip` asset.

So: a release published to one repo is invisible to the other path. Before cutting a release,
decide which repo is real and make both agree. The comment on `GITHUB_REPO` explains why it is
not the upstream — pointing it at `Charlie85270/Dorothy` offered upstream builds as updates to
fork installs, which overwrote them. Nothing is ever pushed upstream.

Auto-check fires 5 s after `whenReady()` unless `appSettings.autoCheckUpdates === false`.

### Cut a release

```bash
# 1. bump
npm version 1.5.1 --no-git-tag-version

# 2. gate
npm test
npx tsc -p electron/tsconfig.json && npm run e2e
npm run lint && npm run lint:design

# 3. build
npm run electron:build

# 4. verify the artefacts
ls -la release/
codesign -dv --verbose=4 release/mac-arm64/Tars.app

# 5. publish — the tag must be v<version> for the fallback comparison to work
gh release create v1.5.1 release/*.dmg release/*.zip release/latest-mac.yml \
  --repo JeanBrasse/Tars
```

`latest-mac.yml` must be in the release assets or `electron-updater` throws and every client
silently drops to the GitHub-API fallback — which, per the mismatch above, is looking at the
other repo.

---

## Storage

Everything Tars owns lives under `~/.dorothy` (`DATA_DIR`). Nothing is in a database except
the vault. All of it is `HOME`-relative, which is what makes the sandbox and E2E isolation
work.

### The file table

| Path | Written by | Contents |
|---|---|---|
| `~/.dorothy/agents.json` | `electron/core/agent-manager.ts` | the fleet — schema `version: 2`, `savedAt`, `agents[]` |
| `~/.dorothy/agents.backup.json` | same | last good copy, taken from content just parsed successfully |
| `~/.dorothy/app-settings.json` | `electron/main.ts` (`saveAppSettingsToFile`) | every setting: provider keys, Telegram/Slack/X/Jira, CLI paths, memory backends |
| `~/.dorothy/api-token` | `electron/services/api-server.ts` | 32 random bytes hex, mode `0600` |
| `~/.dorothy/hermes-webhook-secret` | `electron/handlers/hermes-handlers.ts` (`readWebhookSecret`) | bearer for `POST /api/webhooks/hermes`; auto-provisioned with 32 random bytes at mode `0600` on first read |
| `~/.dorothy/hermes-connection.json` | `electron/services/hermes-config.ts` | gateway mode/url/token/ssh |
| `~/.dorothy/kanban-tasks.json` | `electron/handlers/kanban-handlers.ts` | board |
| `~/.dorothy/templates.json` + `templates.backup.json` | `electron/handlers/template-handlers.ts` | agent templates |
| `~/.dorothy/team-templates.json` | `electron/handlers/team-template-handlers.ts` | team blueprints |
| `~/.dorothy/projects.json` | `ipc-handlers.ts` (`CUSTOM_PROJECTS_FILE`) | manually added projects |
| `~/.dorothy/cli-paths.json` | `electron/handlers/cli-paths-handlers.ts` | resolved binary paths, readable by MCP |
| `~/.dorothy/usage-ledger.jsonl` | `electron/services/usage-ledger.ts` | one line per turn; capped 20 000 → trimmed to 12 000 |
| `~/.dorothy/observations/<slug>.jsonl` | `api-routes/memory-routes.ts` | post-tool-use ledger; capped 1 000 → trimmed to 500 |
| `~/.dorothy/model-catalog.json` + `.meta.json` | `electron/services/model-catalog.ts` | models.dev mirror, 6 h TTL |
| `~/.dorothy/acp-registry.json` | `electron/services/acp/registry.ts` | ACP launch commands, 24 h TTL |
| `~/.dorothy/vault.db` | `electron/services/vault-db.ts` | SQLite, WAL, `foreign_keys=ON` |
| `~/.dorothy/vault/` + `vault/attachments/` | same | vault file bodies |
| `~/.dorothy/telegram-downloads/` | `electron/services/telegram-bot.ts` | inbound media |
| `~/.dorothy/CLAUDE.md` | `electron/utils/index.ts` | copied from the repo at every boot, loaded by agents via `--add-dir` |
| `~/.dorothy/statusline.sh` | `electron/utils/statusline.ts` | installed only when the statusline is enabled |

Outside `~/.dorothy`, Tars writes into provider config it does not own — see *MCP servers* and
*Hooks*. Memory files it reads live in `~/.claude/projects/<encoded-path>/memory/`, where the
project path is encoded as a folder name (slashes → dashes).

### Migration from `~/.claude-manager`

`migrateFromClaudeManager()` runs on every boot. If `~/.claude-manager` exists it copies
`agents.json`, `agents.backup.json`, `app-settings.json`, `kanban-tasks.json`,
`scheduler-metadata.json`, `telegram-downloads/`, `scripts/` — **skipping anything that
already exists in `~/.dorothy`** — then `rm -rf`s the old directory. It is one-way and
destructive of the source. Back up `~/.claude-manager` before first launch of a renamed build
if you care about it.

### Recovering `agents.json`

`saveAgents()` writes to a temp file and renames it into place, so a crash mid-write leaves the
previous file intact rather than truncated. The backup is only taken from content that just
parsed successfully — a corrupt current file cannot overwrite the last good copy.

Autosave flushes every **30 s** when dirty (`FLUSH_INTERVAL_MS`), plus once on `before-quit`.
Only the last 100 output chunks per agent are persisted (400 are retained in memory,
`OUTPUT_RETAIN`), and `running` is written back as `idle` — a restored agent is never live.

If the fleet comes back empty:

```bash
# 1. is the current file parseable?
jq '.version, (.agents | length)' ~/.dorothy/agents.json

# 2. is the backup better?
jq '.version, (.agents | length), .savedAt' ~/.dorothy/agents.backup.json

# 3. restore — Tars must be quit, or before-quit will overwrite it
cp ~/.dorothy/agents.backup.json ~/.dorothy/agents.json
```

`parseAgentsFile()` accepts both shapes: a bare array (v1) and `{version, savedAt, agents}`
(v2). A hand-written array will load.

### Full reset

```bash
# quit Tars first
mv ~/.dorothy ~/.dorothy.bak-$(date +%F)
```

This drops agents, settings, the API token, the vault and the usage ledger. It does **not**
undo what Tars wrote into `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml`,
`~/.gemini/settings.json` or `~/.grok/config.toml` — see the two sections below for those.

---

## The local API server

`electron/services/api-server.ts`, bound to **`127.0.0.1:31415`**
(`API_PORT = Number(process.env.DOROTHY_API_PORT) || 31415`). This is how agents drive other
agents: the bundled MCP servers, the shell hooks and any external scheduler all speak to it.

### Auth model

Three layers, in order:

1. **Origin check.** Any request carrying an `Origin` header that is not `app://-` or
   `http://localhost:3000` is rejected `403 Forbidden origin` — a browser tab on any site can
   reach `127.0.0.1`, and CORS hides the response but not the side effect. Shell hooks send no
   `Origin` at all, which is why they pass.
2. **Bearer token.** `Authorization: Bearer <~/.dorothy/api-token>`, else `401`.
   Exempt paths: `/api/health`, `/api/local-file`, `/api/kanban/complete`, and anything under
   `/api/hooks/`.
3. **Body limit.** 4 MiB (`MAX_BODY_BYTES`) → `413`, enforced *before* routing so the exempt
   hook paths cannot exhaust main-process memory without a credential. `__proto__` and
   `constructor` are stripped from every parsed body.

If the port is taken the server logs `Port 31415 is in use, API server not started` and the
app carries on **without an API** — every agent-to-agent call then fails. There is no retry
and no UI warning.

### Talk to it

```bash
TOKEN=$(cat ~/.dorothy/api-token)
API=http://127.0.0.1:31415

curl -s $API/api/health                                    # {"ok":true} — no auth
curl -s -H "Authorization: Bearer $TOKEN" $API/api/agents | jq
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/agents/<id>?full=true" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/agents/<id>/output?lines=200"
curl -s -H "Authorization: Bearer $TOKEN" $API/api/memory/status | jq
```

### Route surface

| Method | Path |
|---|---|
| GET | `/api/health` |
| GET | `/api/agents` · `/api/agents/:id` · `/:id/bootstrap` · `/:id/health` · `/:id/output` · `/:id/wait` |
| POST | `/api/agents` · `/:id/start` · `/:id/dispatch` · `/:id/run-task` · `/:id/stop` · `/:id/message` |
| DELETE | `/api/agents/:id` |
| POST | `/api/hooks/{output,status,task-completed,agent-stopped,notification}` |
| GET | `/api/memory/{context,search,status}` · POST `/api/memory/{write,remember}` |
| GET/POST/PUT/DELETE | `/api/vault/documents[/:id]` · `/api/vault/folders[/:id]` · `/api/vault/search` · `/:id/attach` |
| GET | `/api/local-file` |
| POST | `/api/kanban/generate` · `/api/kanban/complete` |
| POST | `/api/telegram/{send,send-photo,send-video,send-document}` · `/api/slack/send` |
| POST | `/api/webhooks/hermes` |

`GET /api/agents/:id/wait` long-polls; default `?timeout=300` seconds, and the MCP client
raises its own fetch timeout to 600 s for any path containing `/wait` so the client never
aborts before the server resolves.

Route matching is first-match, and parameterised routes are `RegExp` with exactly one capture
group mapped to `params.id`.

### Diagnose

```bash
lsof -nP -iTCP:31415 -sTCP:LISTEN         # who owns the port
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:31415/api/health   # expect 200
stat -f '%Sp %N' ~/.dorothy/api-token      # expect -rw-------
```

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` from a script | token missing or stale | re-read `~/.dorothy/api-token`; the file is regenerated if shorter than 32 chars |
| `403 Forbidden origin` | called from a browser page or a tool that sets `Origin` | drop the header; `curl` sends none |
| every call `ECONNREFUSED` | port taken at boot, API never started | `lsof -nP -iTCP:31415`, kill the squatter, restart Tars |
| `413 Request body too large` | >4 MiB payload | it is a hard cap; chunk the prompt |

---

## Orchestration: the cross-project guard

`electron/services/api-routes/agent-routes.ts` scopes agent actions to the caller's project so
an orchestrator cannot pick another project's agent ID out of a global listing.
`assertSameProject()` gates `start`, `dispatch`, `run-task`, `stop`, `message` and `DELETE`.

The identity comes from HTTP headers the MCP client injects out of its PTY environment
(`CLAUDE_AGENT_ID`, `CLAUDE_PROJECT_PATH`, set by `initAgentPty`).

> **Known defect — read this before debugging a delegation failure.** The server reads
> `x-dorothy-caller-project` (`agent-routes.ts:337`). Both MCP clients send
> `X-Tars-Caller-Project` (`mcp-orchestrator/src/utils/api.ts:53`, `mcp-memory/src/utils/api.ts:53`).
> The names do not match, so `callerProject()` is always `undefined` for MCP callers, and the
> `X-Tars-Client: mcp` branch fires unconditionally:
>
> ```
> 403 This agent has no identity, so its calls cannot be scoped to a project.
>     Restart the agent from Tars so it is spawned with CLAUDE_AGENT_ID and CLAUDE_PROJECT_PATH.
> ```
>
> Restarting the agent does not help — the env vars are already there. Confirm with:
>
> ```bash
> grep -rn "caller-project" electron/services/api-routes/agent-routes.ts
> grep -rn "Caller-Project" mcp-orchestrator/src/utils/api.ts
> ```
>
> The unit test at `__tests__/electron/services/api-routes/agent-routes.test.ts:500` asserts the
> server-side spelling, so the suite is green either way. The two must be made to agree.

Genuine cross-project denials read differently and are recoverable:

```
403 Cross-project access denied: agent "X" belongs to project /a, but you are the
    orchestrator of /b. Use list_agents to see YOUR project's agents, or pass
    allowCrossProject: true if this is intentional.
```

Override with `allowCrossProject: true` in the body, or `?allowCrossProject=true` on `DELETE`
(which has no parsed body).

`GET /api/agents` filters to the caller's project unless `?all=true`, and echoes
`scopedToProject` in the response so you can see which way it went.

### Dispatch semantics

`performDispatch()` is shared by `POST /api/agents/:id/dispatch` and the Hermes webhook, so
both behave identically. It:

1. calls `killStalePty(agent)` — if the PTY's recorded `ptyCwd` no longer matches
   `worktreePath || projectPath`, the PTY is killed so the spawn path restarts it in the right
   directory;
2. **refuses with `409`** if the agent is `waiting` on a permission dialog — a typed message
   cannot answer arrow-key UI, and the trailing `\r` could *accept* the pending permission:
   `Agent "X" is blocked on a permission dialog; a typed message cannot answer it.`
3. types the message into a live `running`/`waiting` session (`mode: "message"`), or
4. spawns a fresh session with the message as the prompt (`mode: "start"`).

---

## MCP servers

Seven servers ship inside the app, built from `mcp-*/` into `dist/bundle.js` and copied to
`process.resourcesPath/<name>/dist/bundle.js` by `extraResources`:

| directory | registered as | resolver |
|---|---|---|
| `mcp-orchestrator` | `claude-mgr-orchestrator` | `getMcpOrchestratorPath()` |
| `mcp-memory` | `tars-memory` | `getMcpMemoryPath()` |
| `mcp-telegram` | `claude-mgr-telegram` | `getMcpTelegramPath()` |
| `mcp-kanban` | `claude-mgr-kanban` | `getMcpKanbanPath()` |
| `mcp-vault` | `claude-mgr-vault` | `getMcpVaultPath()` |
| `mcp-socialdata` | `dorothy-socialdata` | `getMcpSocialDataPath()` |
| `mcp-x` | `dorothy-x` | `getMcpXPath()` |

Plus `tasmania` when `appSettings.tasmaniaEnabled` and the configured
`tasmaniaServerPath` exists on disk.

### How registration works

`setupMcpOrchestrator()` runs on `whenReady()`, un-awaited so it does not hold the first paint.
For each server × each of the 15 providers it calls `provider.isMcpServerRegistered(name, path)`
and, if absent, `provider.registerMcpServer(name, 'node', [bundlePath])` — yielding with
`setImmediate` between each because registering shells out and this is the thread that pumps
every PTY.

Each provider writes to its own config, CLI-first with a file fallback:

| provider(s) | config dir | mechanism |
|---|---|---|
| `claude` (+ `openrouter`, `deepseek`, `mimo`, `moonshot`, `qwen`, `zhipu`, `minimax`, `nvidia`, `nous-portal` — all share the `claude` binary and `~/.claude`) | `~/.claude` | `claude mcp add -s user …`, fallback `~/.claude/mcp.json`; presence checked in both `~/.claude/mcp.json` and `~/.claude.json` |
| `codex` | `~/.codex` | fallback writes `[mcp_servers.<name>]` into `config.toml` |
| `gemini` | `~/.gemini` | fallback writes `settings.json` |
| `grok` | `~/.grok` | fallback writes `[mcp_servers.<name>]` into `config.toml` with `enabled = true` |
| `opencode` | `~/.opencode` | |
| `pi` | `~/.pi` | |

Because the paths resolve through `process.resourcesPath`, **MCP registration only works in a
packaged app**. In `npm run electron:dev` every server logs
`MCP server <name> not found at …` and is skipped. That is expected, not a bug.

### Verify and re-register

```bash
# Claude
claude mcp list
jq '.mcpServers | keys' ~/.claude/mcp.json 2>/dev/null
jq '.mcpServers | keys' ~/.claude.json

# Codex / Grok
grep -A3 '^\[mcp_servers\.' ~/.codex/config.toml
grep -A3 '^\[mcp_servers\.' ~/.grok/config.toml

# Gemini
jq '.mcpServers | keys' ~/.gemini/settings.json

# do the bundles actually exist in the installed app?
ls -la /Applications/Tars.app/Contents/Resources/mcp-*/dist/bundle.js
```

Registration is idempotent and re-runs at every boot — to force it, remove the entry from the
provider's config and restart Tars.

### Bundled skills

`installBundledSkills()` runs at the end of `setupMcpOrchestrator()`. Its `bundledSkills` list
is currently **empty**; what it does do is *remove* stale `world-builder` skill directories
from every provider's skill dir — and only when the `SKILL.md` content matches
`/dorothy-world|create_zone|PokAImon/i`, so a user's own skill of that name is left alone.
`skills/` in the repo holds `remember.md`.

### When an agent cannot see a tool

```bash
# 1. is the server registered for THAT provider?
claude mcp list | grep tars-memory

# 2. does the bundle exist?
ls -l /Applications/Tars.app/Contents/Resources/mcp-memory/dist/bundle.js

# 3. can the server reach the API? (it needs the token file)
stat ~/.dorothy/api-token && curl -s http://127.0.0.1:31415/api/health

# 4. was the agent spawned with an identity?
curl -s -H "Authorization: Bearer $(cat ~/.dorothy/api-token)" \
  "http://127.0.0.1:31415/api/agents/<id>?full=true" | jq '{id,name,projectPath,ptyId,ptyCwd}'
```

MCP clients honour `CLAUDE_MGR_API_URL` if you need to point them at a non-default port.

---

## Hooks

`hooks/` is bundled and unpacked from the asar; `getHooksPath()` resolves it via
`app.getAppPath()` with `app.asar` → `app.asar.unpacked`. `configureStatusHooks()` runs at boot
and delegates to every provider whose `getHookConfig().supportsNativeHooks` is true.

### Claude — `~/.claude/settings.json`

Eight hooks, each installed as `{ type: 'command', command: '<hooksDir>/<file>', timeout: 30 }`:

| event | script | matcher |
|---|---|---|
| `SessionStart` | `session-start.sh` | `*` |
| `UserPromptSubmit` | `user-prompt-submit.sh` | — |
| `PostToolUse` | `post-tool-use.sh` | `*` |
| `Stop` | `on-stop.sh` | — |
| `SessionEnd` | `session-end.sh` | `*` |
| `Notification` | `notification.sh` | `*` |
| `PermissionRequest` | `permission-request.sh` | — |
| `TaskCompleted` | `task-completed.sh` | — |

Existing entries are matched by `command.includes(<file>)` and **rewritten in place** when the
path changed — so moving or reinstalling the app repairs stale absolute paths, and a manual
edit to the command will be overwritten on next boot.

### Gemini — `~/.gemini/settings.json`

Separate scripts from `hooks/gemini/`: `session-start.sh`, `user-prompt-submit.sh`,
`post-tool-use.sh`, `on-stop.sh`, `session-end.sh`, `notification.sh`.

### What the hooks do

- `session-start.sh` — POSTs `{agent_id, session_id, status: idle, source}` to
  `/api/hooks/status`. Only `SessionStart` sends `source`; the server records the session id
  **without** touching status, because the status lifecycle belongs to `UserPromptSubmit`/`Stop`.
  It retries once after 1 s: a lost registration makes the stale-session guard ignore every
  later status post from that session. It then fetches `/api/agents/$CLAUDE_AGENT_ID/bootstrap`
  (identity + team roster) and `/api/memory/context`, and injects both as
  `hookSpecificOutput.additionalContext`.
- `post-tool-use.sh` — marks the agent `running` and POSTs the observation to
  `/api/memory/remember`.
- `on-stop.sh` — extracts the last assistant message (from `last_assistant_message`, or by
  streaming the transcript JSONL with `jq -rRn 'inputs | fromjson? …'` — portable because macOS
  has no `tac`, and tolerant of a truncated final line still being flushed), truncates to
  4 000 chars, POSTs to `/api/hooks/output`, then `/api/hooks/status` idle and
  `/api/hooks/agent-stopped`.

Hooks read the API token from `$HOME/.dorothy/api-token` and pass it via
`-H @<(printf "Authorization: Bearer %s" …)` — process substitution, so the token never appears
in `ps`.

### Debugging hooks

```bash
tail -f /tmp/dorothy-hooks.log          # session-start
tail -f /tmp/dorothy-hooks-debug.log    # on-stop, verbose

# are they installed and pointing at a file that exists?
jq -r '.hooks | to_entries[] | "\(.key)\t\(.value[0].hooks[0].command)"' ~/.claude/settings.json
jq -r '.hooks | to_entries[] | .value[0].hooks[0].command' ~/.claude/settings.json | xargs -I{} test -x {} || echo MISSING

# the hooks need jq and curl
which jq curl
```

| Symptom | Cause |
|---|---|
| agents stuck `idle` while clearly working | `jq` not on the hook's PATH — every script `exit 0`s with `{"continue":true}` and posts nothing |
| status posts ignored after a restart | `SessionStart` registration was lost; the stale-session guard drops later posts. Stop and re-dispatch the agent |
| no memory injected at session start | `/api/memory/context` returned empty, or `$HOME/.dorothy/api-token` is unreadable — `/api/memory/*` is **not** auth-exempt |
| sandbox/E2E agent status shows up in prod | hooks hardcode `31415`; see *Run a second Tars beside your live one* |

---

## Memory backends

Five sources sit behind one interface (`electron/services/memory-hub.ts`):

| id | source |
|---|---|
| `project` | `~/.claude/projects/<encoded>/memory/*.md`, `MEMORY.md` first |
| `observations` | `~/.dorothy/observations/<slug>.jsonl`, last 15 |
| `hermes` | gateway `GET /api/memory` + `GET /api/sessions/search` |
| `gbrain` | remote streamable-HTTP MCP server |
| `honcho` | remote streamable-HTTP MCP server |

Both remote backends are spoken to directly over MCP (`electron/services/mcp-http-client.ts`,
protocol `2025-06-18`, `Accept: application/json, text/event-stream`, 15 s timeout) — so
"Connected" in the UI means a real `initialize` + `tools/list` round trip, not "a URL is filled
in". The search tool is discovered by name preference:
`memory_search`, `search_memory`, `honcho_search`, `search`, `recall`, `query`, `retrieve`,
then any tool matching `/search|recall|query|retriev/i`. The query parameter key is read off the
tool's own input schema (`query`/`q`/`search`/`text`/`question`).

### Configure

Settings → Workspace → Memory Backends writes into `~/.dorothy/app-settings.json`:
`memoryGbrainEnabled` / `memoryGbrainMcpUrl` / `memoryGbrainAuthToken`, and
`memoryHonchoEnabled` / `memoryHonchoMcpUrl` / `memoryHonchoApiKey`.

Saving any key starting `memoryGbrain` or `memoryHoncho` triggers `setupMemoryBackends()`,
which additionally mirrors them into `~/.claude.json` as
`{ type: 'http', url, headers: { Authorization: 'Bearer …' } }` so the Claude binary sees them
natively. It **never** clobbers a `~/.claude.json` it could not parse, and it only *removes* an
entry whose URL matches the one Tars itself configured — a gbrain you registered by hand
survives.

### Check reachability

```bash
TOKEN=$(cat ~/.dorothy/api-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:31415/api/memory/status?project_path=$PWD" | jq
```

Returns one object per source with `{id, label, configured, reachable, detail, tools[]}`.
`configured: true, reachable: false` means the URL is set but the MCP handshake failed — check
the token, then the URL scheme.

```bash
# federated search, same path the agents use
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:31415/api/memory/search?q=pty&sources=project,observations&limit=5" | jq

# what gets injected at session start
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:31415/api/memory/context?project_path=$PWD" | jq -r .context

# is Tars registering them for the claude binary?
jq '.mcpServers.gbrain, .mcpServers.honcho' ~/.claude.json
```

`sources` accepts only `project,observations,hermes,gbrain,honcho`; unknown values are dropped
silently and an empty result means "all sources". `limit` is clamped to 1–50.

---

## Hermes gateway

Tars has **no scheduler of its own**. Hermes cron jobs and automation blueprints call back into
Tars instead.

### Connection

`~/.dorothy/hermes-connection.json`, four modes (`electron/types/hermes.ts`):

| mode | base URL |
|---|---|
| `local` | `http://127.0.0.1:<localPort>`, default port **9119** |
| `ssh` | `http://127.0.0.1:<ssh.localPort ?? ssh.remotePort ?? 9119>` |
| `remote` / `cloud` | `conn.url`, trailing slashes stripped |

Two auth flavours, advertised by the gateway on `GET /api/status`:

- **token** — static `X-Hermes-Session-Token` header;
- **cookie** (`auth_flows: ['cookie']`) — `POST /auth/password-login {provider, username,
  password}`, cookies kept in an in-memory jar in the main process only, never exposed to the
  renderer. The gateway rotates the access cookie transparently while the refresh cookie lives.

Sign-in state is process-local: **restarting Tars logs you out of a cookie gateway.**

### Check it is reachable

```bash
jq . ~/.dorothy/hermes-connection.json

# local gateway
curl -s http://127.0.0.1:9119/api/status | jq '{version, auth_flows}'

# token gateway
curl -s -H "X-Hermes-Session-Token: $TOK" https://<gateway>/api/status | jq

# what Tars actually pulls
curl -s -H "X-Hermes-Session-Token: $TOK" https://<gateway>/api/memory | jq
curl -s -H "X-Hermes-Session-Token: $TOK" "https://<gateway>/api/cron/jobs?profile=all" | jq
curl -s -H "X-Hermes-Session-Token: $TOK" "https://<gateway>/api/sessions/search?q=deploy" | jq
```

The Crons page reads `/api/cron/jobs?profile=all`; with no gateway configured it renders
`waiting on /api/cron/jobs` and stays there. That is the expected empty state, not a hang.

Hermes exposes no HTTP API for memory *content* — `/api/memory` returns state only; the
searchable body is the FTS index behind `/api/sessions/search`.

### Inbound webhook

`POST /api/webhooks/hermes` lets the gateway drive a Tars agent.

```bash
# the secret is auto-provisioned (32 random bytes, mode 0600) on first read — no minting needed
cat ~/.dorothy/hermes-webhook-secret

# make the localhost-bound API reachable from the VPS
tailscale serve 31415

# validate auth + agent resolution without dispatching
curl -s -X POST https://<this-machine>.<tailnet>.ts.net/api/webhooks/hermes \
  -H "Authorization: Bearer $(cat ~/.dorothy/hermes-webhook-secret)" \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"Backend","project_path":"$PWD","message":"ping","dry_run":true}' | jq
```

Body: `agent_id` **or** `agent_name` (case-insensitive exact match, narrowed by
`project_path` when the same role exists on several projects), plus `message` (required),
`model`, `permission_mode` (`normal|auto|bypass`), `dry_run`.

Auth: the webhook secret if the file exists, **or** the master `~/.dorothy/api-token` — the
master token is accepted so an existing setup keeps working. If the secret file is absent, only
the master token works. This is the one route published over the tailnet, which is why it
carries its own credential.

Response mirrors `/dispatch` (`{success, mode, agent}`); poll `GET /api/agents/:id` for the
result afterwards.

---

## Tasmania (local models)

`electron/services/tasmania-client.ts` talks to a Control API on **`http://localhost:3999`**,
authenticated with a bearer read from
`~/Library/Application Support/Tasmania/.control-api-token`. Every request has a 5 s
`AbortSignal.timeout`.

Agents with `provider: 'local'` get Tasmania's endpoint baked into their PTY environment at
spawn time:

```
ANTHROPIC_BASE_URL=<endpoint with trailing /v1 stripped>
ANTHROPIC_MODEL=<agent.localModel || status.modelName || 'default'>
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

The `/v1` suffix is stripped because the Claude Code SDK appends `/v1/messages` itself.

```bash
curl -s -H "Authorization: Bearer $(cat ~/Library/Application\ Support/Tasmania/.control-api-token)" \
  http://localhost:3999/api/status | jq
```

If Tasmania is not `running`, the agent is spawned **anyway**, with no Tasmania env vars — the
log line is `Agent <id> is local provider but Tasmania is not running — PTY created without
Tasmania env vars`. The agent then silently talks to the public Anthropic API. Check the status
before starting local agents.

Tasmania is also registered as an MCP server when `tasmaniaEnabled` is set and
`tasmaniaServerPath` exists; a missing path logs `Tasmania MCP server not found at <path>` and
is skipped.

---

## Agents and PTYs

Every agent runs in a `node-pty` login shell: `pty.spawn('/bin/bash', ['-l'], …)`, 120×30,
`xterm-256color`, `cwd = worktreePath || projectPath` (falling back to `$HOME` with a warning
if that path is gone). Free-standing terminals use `process.env.SHELL || '/bin/zsh'`.

The environment is `process.env` plus:

- `PATH` — rebuilt by `buildFullPath()` from `~/.nvm/versions/node/v20.11.1/bin`,
  `~/.nvm/versions/node/v22.0.0/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`,
  and every `~/.nvm/versions/node/*/bin` (`~/.grok/bin`, `~/Library/pnpm` and `~/.yarn/bin`
  are only in `detectCLIPaths()`'s probe list, not the PTY PATH);
- provider env (`getPtyEnvVars` — this is where `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` are
  injected for the nine providers that drive the `claude` binary against another API);
- `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, so `~/.dorothy/CLAUDE.md` is loaded via
  `--add-dir`;
- Tasmania env, when applicable.

`ensureProjectTrusted(cwd)` pre-accepts Claude Code's workspace-trust dialog for the cwd, so
bypass-mode agents never stall on the first-launch prompt.

### CLI path detection

`detectCLIPaths()` runs `$SHELL -ilc 'echo $PATH'` (5 s timeout) to pick up `.zshrc`/`.bashrc`
additions, then probes the common directories above for
`claude, codex, gemini, grok, qwencode, opencode, pi, gws, gcloud, gh, node, minimax`.
A path you set by hand in Settings → AI & Providers → CLI Paths wins, provided the file exists.
Results are cached to `~/.dorothy/cli-paths.json` so MCP servers can read them too.

```bash
jq . ~/.dorothy/cli-paths.json
zsh -ilc 'echo $PATH' | tr ':' '\n'
```

If a provider shows as unavailable but the binary works in your terminal, the difference is
almost always a PATH entry added by a shell rc file that only runs for interactive **login**
shells — set the path explicitly in Settings rather than fighting it.

### Agent stuck in the wrong directory

`killStalePty()` compares the PTY's recorded `ptyCwd` against `worktreePath || projectPath` and
kills it on mismatch, so the next dispatch respawns in the right place. It runs on every
dispatch. To force it:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:31415/api/agents/<id>?full=true" | jq '{projectPath, worktreePath, ptyCwd, ptyId}'
# then stop and re-dispatch
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:31415/api/agents/<id>/stop
```

### Fleet-wide log search

The Logs page reads the retained output buffers in the main process (400 chunks per agent, ANSI
stripped, capped at 500 result lines). It supports plain substring search or `/regex/flags` —
a bad regex falls back to a literal search rather than throwing.

These buffers are **memory only**. Only the last 100 chunks per agent survive to
`agents.json`; restarting Tars loses the rest. If you need durable output, capture it from
`GET /api/agents/:id/output?lines=N` while the app is up.

---

## Usage and cost accounting

Two independent sources feed the Usage page:

1. **`~/.dorothy/usage-ledger.jsonl`** — one record per turn, written by
   `recordUsage()`. Every ACP turn reports its own tokens, which is the only source that covers
   Codex, Gemini, Grok and the rest. When the agent does not report a cost, the ledger prices
   the turn itself from the catalogue; cache reads default to 10 % of input and cache writes to
   125 % when the catalogue omits them.
2. **Claude Code transcripts** — `~/.claude/projects/**/*.jsonl`, parsed by
   `electron/services/transcript-usage.ts`. Claude Code only writes
   `~/.claude/stats-cache.json` for some account types; the per-message `usage` block in the
   transcripts is always there. 1 h cache writes are kept apart from 5 m ones because they
   price at 2× base rather than 1.25×.

Prices come from **models.dev** (`https://models.dev/api.json`, mirror
`raw.githubusercontent.com/anomalyco/models.dev/dev/models.json`), USD per million tokens,
cached to `~/.dorothy/model-catalog.json` with a 6 h TTL and conditional GET. Three tiers in
order: fresh fetch → last-good copy on disk *whatever its age* → the compiled-in floor. A
network failure must never zero out cost accounting.

```bash
jq -s 'length' ~/.dorothy/usage-ledger.jsonl                 # turns recorded
jq -r '.provider' ~/.dorothy/usage-ledger.jsonl | sort | uniq -c
jq '.meta // {}' ~/.dorothy/model-catalog.meta.json
jq 'keys | length' ~/.dorothy/model-catalog.json             # providers in the catalogue
```

| Symptom | Cause |
|---|---|
| "Usage by Provider" empty for non-Claude CLIs | those agents ran over PTY, not ACP — only ACP turns hit `recordUsage()` |
| costs plausible but stale | catalogue served from disk after a failed fetch; delete `~/.dorothy/model-catalog*.json` and restart |
| Claude costs zero | no transcripts under `~/.claude/projects/` for the window being shown |

---

## ACP transport

`electron/services/acp/` drives CLIs over the Agent Client Protocol instead of typing into a
terminal — the same JSON-RPC conversation for Claude Code, Codex, Gemini, Grok, opencode and
pi, and a turn *returns* with a stop reason and its token usage rather than leaving Tars to
infer completion from screen output.

Launch commands come from the public registry
(`raw.githubusercontent.com/agentclientprotocol/registry/main`), cached to
`~/.dorothy/acp-registry.json` with a 24 h TTL, with a deliberately small hardcoded fallback
(`npx -y @agentclientprotocol/claude-agent-acp@0.70.0`, `@agentclientprotocol/codex-acp@1.6.2`,
`@google/gemini-cli --acp`, `@xai-official/grok agent stdio`, `opencode acp`).

```bash
jq '.fetchedAt, (.agents | keys)' ~/.dorothy/acp-registry.json
rm ~/.dorothy/acp-registry.json    # force a refresh on next boot
```

Provider → registry id: `claude→claude-acp`, `codex→codex-acp`, `gemini`, `grok`, `opencode`,
`pi`. A provider absent from that map has no ACP path and runs over PTY only.

---

## Lifecycle

### Boot order (`electron/main.ts`, `app.whenReady()`)

`ensureTarsClaudeMd()` → `migrateFromClaudeManager()` → `loadAgents()` →
`startAgentAutosave()` → `initTray()` → `initVaultDb()` → `startApiServer()` →
`loadCatalog()` (un-awaited) → `setupMcpOrchestrator()` (un-awaited) →
`setupMemoryBackends()` → `await configureStatusHooks()` → `initAutoUpdater()` →
update check after 5 s.

The two un-awaited calls are deliberate: both shell out per provider and used to hold the main
thread through the first paint.

### Shutdown (`before-quit`)

`destroyTray()` → `stopAgentAutosave()` → `saveAgents()` → `killAllPty()` → `closeVaultDb()`.

**Killing Tars with `SIGKILL` skips all of it**: up to 30 s of agent state is lost, every PTY is
orphaned, and the SQLite WAL is left unclosed. Quit from the menu or the tray.

On macOS, closing the window does **not** quit — `window-all-closed` only quits on
non-darwin. The tray stays live and agents keep running. To actually stop everything:

```bash
osascript -e 'quit app "Tars"'     # graceful — runs before-quit
pgrep -fl 'Tars' ; pgrep -fl 'node-pty'   # verify nothing is orphaned
```

### Stdout hardening

`main.ts` installs an `error` handler on `process.stdout` and `process.stderr` that swallows
`EPIPE`. A closed pipe (the launching shell exited) would otherwise make `console.log` throw
and crash the app. Any other stream error still rethrows.

---

## Repo hygiene

`.worktrees/` and `.claude/worktrees/` are agent-created embedded checkouts and are gitignored.
The real reason a naive `find . -name '*.test.ts' -not -path './node_modules/*'` returns 1432
files while `vitest` collects 46 (~31×) is nested `node_modules` the top-level exclude misses:
166 under `landing/` and 140 in each of the seven `mcp-*/` dirs; the two worktree trees add
only 234. The top-level `-not -path './node_modules/*'` is not enough — you must exclude
`node_modules` at every depth:

```bash
find . -name '*.test.ts' -not -path '*/node_modules/*' -not -path './.worktrees/*' -not -path './.claude/*'
```

Also gitignored and safe to delete: `.next/`, `out/`, `release/`, `electron/dist/`,
`mcp-*/dist`, `mcp-*/node_modules`, `e2e/report/`, `test-results/`, `design/exports/`,
`*.tsbuildinfo`.

`build/` is in `.gitignore` but `build/entitlements.mac.plist` is tracked — do not "clean" it.

`CLAUDE.md` at the repo root carries a block re-written by `next dev`
(`node_modules/next/dist/server/lib/generate-agent-files.js`). Removing it from a diff only
re-creates the uncommitted change; commit it with your work to keep the tree clean.
