# Tars: Operator Runbook

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

`package.json` declares `"engines": { "node": ">=22.12.0" }`, the floor Electron itself declares since 43, and CI
(`.github/workflows/ci.yml`) runs the test job on Node 22. **Node 18 fails**, in two different ways:

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
unconditionally. Node 20.20.1 and 22.22.2 both ran the full suite clean before the floor moved to 22.12. If you see the
`styleText` SyntaxError, you are on the wrong Node: nothing else is wrong.

### Install

```bash
npm ci
```

`package-lock.json` is the only lockfile, and the one CI uses.

Since Electron 44 the `electron` package has no install script: its binary is downloaded the first time
something asks for it (`require('electron')`, `npx electron`, Playwright's launch), into
`node_modules/electron/dist`. `npx install-electron` fetches it ahead of time, which a first E2E run wants.
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

1. `npm run dev`: `next dev` on port 3000.
2. `npm run electron:start`: `wait-on http://localhost:3000`, then
   `tsc -p electron/tsconfig.json`, then `NODE_ENV=development electron .`.

`main` is `electron/dist/main.js`, so **the main process is compiled every launch** by that
`tsc` step. If you edit anything under `electron/` you must restart: there is no watch.
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
has no IPC bridge: every `window.electron.*` call is undefined, so most pages render empty.
Use it only for pure-layout work.

### Compile just the main process

```bash
npx tsc -p electron/tsconfig.json
```

`electron/tsconfig.json` emits CommonJS into `electron/dist/`, and its `include` list is
explicit: `main.ts`, `preload.ts`, `memory.ts`, `memory-parser.ts`, and
`types|constants|utils|core|services|handlers/**/*.ts`. `tsc` also compiles any file reached by
a transitive import from an included one, so a new directory is built as soon as something in
the list imports it: `providers/` is not in `include` yet `electron/dist/providers/` is
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

`scripts/sandbox.sh` launches `release/mac-arm64/Tars.app` with `HOME=$HOME/Tars-sandbox`,
`CFFIXED_USER_HOME` set to the same directory, and `DOROTHY_API_PORT=31499`. That redirects
`~/.dorothy`, `~/.claude` and `~/Library/Application Support/Tars` into the sandbox, so agents,
settings, the API token and window state are all throwaway copies. Your production install
(port 31415) is untouched and keeps running.

`HOME` alone is not enough on macOS. Electron finds the home directory, and with it the profile
under `~/Library/Application Support`, through the system and not through `HOME`: measured on
2026-09-16, with only `HOME` moved, `app.getPath('home')` still answered the real home. Until
then the sandbox opened the live install's profile, and spawned its agents with the real
`~/.claude/mcp.json`. The main process now takes its home from `os.homedir()` everywhere, and
`CFFIXED_USER_HOME` moves the profile.

The sandbox is **persistent** across launches. To reset it:

```bash
rm -rf ~/Tars-sandbox
```

Logs land in `~/Tars-sandbox/tars.log`.

> **The hooks follow the port.** Each of the 14 reads `CLAUDE_MGR_API_URL`, which Tars puts in
> the pty environment from `DOROTHY_API_PORT`, and falls back to `http://127.0.0.1:31415` only
> when nothing set it, which is the case for a `claude` you started yourself. A sandbox on 31499
> therefore writes to the sandbox.
>
> Until 1.7.0 all 14 hardcoded `http://127.0.0.1:31415`, so an agent spawned from the sandbox
> posted its status, output and observations into the **production** instance. If you are reading
> an older build, treat sandbox agent status as untrustworthy.

### Lint

```bash
npm run lint            # eslint (flat config, eslint.config.mjs)
npm run lint:design     # design guardrail, see below
```

---

## Tests and guardrails

Four separate gates. They do not overlap.

### Unit tests: `npm test`

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

Layout mirrors the source tree: `__tests__/electron/services/api-routes/*.test.ts`,
`__tests__/electron/providers/*.test.ts`, `__tests__/mcp/*.test.ts`. Two suites deliberately
print stack traces on success (`team-template-handlers` corrupt-store case, the security
suites); a stderr block is not a failure, read the final summary line.

`npm test` does **not** cover `src/` React components beyond two files
(`__tests__/components/`). The renderer is guarded by the E2E sweep instead.

### E2E surface sweep: `npm run e2e`

```bash
npx tsc -p electron/tsconfig.json    # REQUIRED, see below
npm run e2e
```

`playwright.config.ts` starts `npx next dev -p 3100` (reusing an existing server if one is
already up) and runs `e2e/surfaces.spec.ts` with `workers: 1`, `fullyParallel: false`: one
Electron instance drives every surface serially.

The spec launches the **real Electron app** (`electron.launch({ args: ['.'] })`) with:

| env | value | why |
|---|---|---|
| `HOME` | `mkdtemp('dorothy-e2e-')` | `~/.dorothy` and `~/.claude` are empty fixtures |
| `NODE_ENV` | `development` | loads the dev URL instead of `app://` |
| `DOROTHY_DEV_URL` | `http://localhost:3100` | |
| `DOROTHY_API_PORT` | `31498` | never collides with prod (31415) or sandbox (31499) |
| `DOROTHY_E2E` | `1` | suppresses `openDevTools()` |
| `CFFIXED_USER_HOME` | the sandbox HOME | macOS ignores `HOME` for application support, caches and logs |
| `--user-data-dir` (argument) | `<sandbox>/electron-profile` | the Chromium profile, which `HOME` does not move |

The sandbox HOME is `rm -rf`'d in `afterAll`. `HOME` alone did not keep the live install out of reach: the dev app is named `tars`, and on a case-insensitive disk its profile is the installed Tars's `~/Library/Application Support/Tars`, which every run opened until 2026-09-16. Every spec launches through `launchSandboxed` in `e2e/fixture.mjs`, which adds the two rows above and asks the running app where each of its folders landed before any page opens.

**Nothing in the E2E path compiles the main process.** `main` points at
`electron/dist/main.js`; if it is stale or missing, Playwright launches an old build or fails
outright. Run `tsc -p electron/tsconfig.json` first, every time.

Per surface the spec does two things:

- asserts zero uncaught page errors: hydration errors are downgraded to a
  `known-issue` annotation (kanban, vault, brain each still emit them), any **other** uncaught
  error fails the surface;
- `toHaveScreenshot()` against `e2e/__screenshots__/<name>.png` with
  `maxDiffPixelRatio: 0.005`, `animations: 'disabled'`.

The manifest is `e2e/surfaces.mjs`: **16 pages + 16 settings sections + 3 overlays = 35
surfaces**. Note `e2e/__screenshots__/` holds **36** PNGs: `settings-obsidian.png` is an
orphaned baseline with no manifest entry. Delete it or add the surface back; it is currently
neither compared nor cleaned up.

Settings clicks are scoped to `getByTestId('settings-nav')` because labels collide with the
main navigation (`Extensions` is both a page and a settings group). If you rename a settings
group or child label, the corresponding surface times out at
`target.waitFor({ state: 'visible', timeout: 8000 })`: fix `SETTINGS_TREE`, not the timeout.

### Update baselines

```bash
npm run e2e:update      # playwright test --update-snapshots
git diff --stat e2e/__screenshots__/
```

Review the diff before committing. A redesign pass that legitimately changes one page should
not be re-baselining thirty.

The HTML report is written to `e2e/report/` (gitignored); open `e2e/report/index.html`.
Traces are `retain-on-failure`.

### Coverage guard: `npm run e2e:guard`

```bash
npm run e2e:guard       # node e2e/check-coverage.mjs
```

Cross-checks the executable manifest against `design/UI-INVENTORY.md`. It fails (`exit 1`)
when a route in its `ROUTE_EXPECTATIONS` list (`/`, `/agents`, `/kanban`, `/vault`,
`/projects`, `/skills`, `/usage`, `/memory`, `/settings`, `/whats-new`) has no covering
surface. Overlays are *reported*, never enforced.

It currently prints `Overlays automatisés : 3 / 0 listés dans l'inventaire`: the `0` means its
regex (`^- \[[ x]\] \`(src/….tsx)\``) matched nothing in `design/UI-INVENTORY.md`. The guard
is passing on pages but is blind on overlays. If you restructure the inventory file, re-check
that number is non-zero.

### Design lint: `npm run lint:design`

```bash
bash scripts/design-lint.sh
```

Greps the `.ts`, `.tsx` and `.css` files under `src/`, excluding `src/components/ui/` and
`src/app/icon.tsx`, for six banned patterns. Exits 1 on any hit:

| check | pattern |
|---|---|
| no inline border-radius | `style={{ borderRadius` |
| no drop shadows | `shadow-(sm\|md\|lg\|xl\|2xl)` |
| no gradients | `bg-gradient` |
| no decorative ping | `animate-ping` |
| no raw tailwind palette | `(text\|bg\|border)-(red\|green\|blue\|amber\|purple\|cyan\|yellow\|orange\|zinc\|slate\|gray)-[0-9]` |
| no hardcoded hex colour | `#` and 3, 4, 6 or 8 hex digits, standing on their own |

The rule it enforces: `src/components/ui/` is the only place allowed to define raw appearance.

It also exits 1 when grep could not search, instead of reading that as a clean tree: a file
it cannot open, a pattern it cannot parse, or no file read at all. It prints how many files it
read first. That count is the check for a missing `src/`: grep on macOS answers one that does
not exist with the same silent 1 as a tree with nothing to report.

The hex rule excludes two more places, each because writing a colour out is their job:
`src/app/globals.css`, where every colour the app uses is named once, and comment lines in
`.ts` and `.tsx`, where `#418` is an error number rather than a colour.

Green on this tree, on all six checks, with 221 files read. The wider scan landed red: 13 lines
of raw palette in `src/components/KanbanBoard/constants.ts` and `src/lib/providers.ts`, which the
`.tsx`-only scan never read, and 22 hardcoded hex colours in `src/lib/terminal-theme.ts` (20),
`src/app/layout.tsx` and `src/components/ProviderBadge.tsx`. All 35 were resolved in the same
lot: the Kanban table was dead code, the provider colours and marks moved into
`src/components/ui/`, the terminal theme reads the tokens, and the `theme-color` tag was
removed after measuring that nothing in the app listens for it.

### CI

`.github/workflows/ci.yml` runs on PRs to `main` and pushes to `main`: `ubuntu-latest`,
Node 22, `npm ci`, `npm test`. **That is all CI does**: no lint, no design lint, no E2E, no
build. Playwright needs a display and a mac build; run it locally before you merge anything
visual.

**And it has never run.** Measured on 2026-09-17: the workflow is listed as active, and
`gh api repos/JeanBrasse/Tars/actions/runs` answers `total_count: 0`, PR #105 included. Actions
stay off on a fork until somebody enables them in the repository's Actions tab. Until that click,
every check is one you ran yourself, on your own machine, and nothing is checked on Linux.

---

## Build and release

### Package unsigned (fast, for local testing)

```bash
npm run electron:pack
```

`tsc -p electron/tsconfig.json`, then build all seven MCP bundles, then
`electron-builder --dir --mac`. Output: `release/mac-arm64/Tars.app`. This is what
`scripts/sandbox.sh` expects.

Note `electron:pack` does **not** run `next build`: it packages whatever is already in `out/`.
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
cannot contain route handlers or a dynamic `icon.tsx`: hence the move-and-restore dance. The
`trap … EXIT` puts them back even on failure.

**If a build is killed with `SIGKILL` the trap does not run.** Symptom: `src/app/api` is gone
and the dev server 404s every renderer API route. Recover manually:

```bash
ls src/app | grep _backup
mv src/app/_api_backup src/app/api
mv src/app/_icon_backup.tsx src/app/icon.tsx
git status src/app
```

### Full build

```bash
npm run electron:build
```

`build:renderer` + `tsc` + all seven MCP bundles + `electron-builder --mac`
(targets `dmg` and `zip`), then `scripts/prune-releases.mjs`. Output: `release/` of the checkout
it runs in. To publish, do not stop here: `npm run release` runs this build itself, see
*Cut a release*.

electron-builder config lives inline in `package.json` under `"build"`:

- `appId: xyz.cooperlabs.tars`, `productName: Tars`, icon `public/icon.icns`
- `directories.output: release`
- `files`: `electron/dist`, `electron/resources`, `out`, `node_modules`
  (minus `@next/swc*`, `@next/env`, `@next/eslint-plugin-next`), `skills/`, `hooks/`
- `asarUnpack`: `out/**`, `hooks/**`, `electron/resources/**`,
  `node_modules/better-sqlite3/**`, `node_modules/node-pty/**`: the two native modules and
  everything read from disk by path at runtime
- `extraResources`: one entry per `mcp-*` directory, filtered to `package.json` +
  `dist/bundle.js`, landing in `process.resourcesPath/<name>/`

If `hooks/` or `out/` were left in the asar, `getHooksPath()` and `getAppBasePath()` (both of
which do `appPath.replace('app.asar', 'app.asar.unpacked')`) would resolve to nothing and the
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

`scripts/notarize.js` exports an `afterSign` hook that calls `@electron/notarize`: using the
keychain profile named `Tars` when `APPLE_ID` is unset, otherwise
`APPLE_ID`/`APPLE_APP_PASSWORD`/`APPLE_TEAM_ID`.

> **It is not wired up, and there is nothing to sign with.** There is no `afterSign` key in the
> `build` block of `package.json`, so `electron-builder` never calls it, and this machine has no
> Developer ID identity (`security find-identity -v -p codesigning` reports 0). So
> `npm run electron:build` produces an app signed **ad hoc** (`codesign -dv` gives
> `Signature=adhoc`, `TeamIdentifier=not set`), not a signed one: on another Mac Gatekeeper
> warns on first open, which is what the footer of every release note says. With an identity,
> either add `"afterSign": "scripts/notarize.js"` to `build`, or notarize by hand:

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

### The two update paths

Two independent code paths check for updates. **Both point at `JeanBrasse/Tars`**, and each
reads its own setting, so they agree only as long as both are kept in step:

| path | target | source |
|---|---|---|
| `electron-updater` (`latest-mac.yml`) | `JeanBrasse/Tars` | `package.json` → `build.publish` |
| GitHub-API fallback | `JeanBrasse/Tars` | `electron/constants/index.ts` → `GITHUB_REPO` |

`electron/services/update-checker.ts` sets `autoDownload = false` and
`autoInstallOnAppQuit = true`, calls `autoUpdater.checkForUpdates()`, and **only** on throw
falls back to `GET https://api.github.com/repos/${GITHUB_REPO}/releases/latest`: comparing
`tag_name` minus a leading `v` against `app.getVersion()` component by component, then picking
the first `.dmg` or `.zip` asset.

A release published to a repository that one of the two does not name is invisible to that
path, so a change to either setting changes the other with it. The comment on `GITHUB_REPO` explains why it is
not the upstream: pointing it at `Charlie85270/Dorothy` offered upstream builds as updates to
fork installs, which overwrote them. Nothing is ever pushed upstream.

Auto-check fires 5 s after `whenReady()` unless `appSettings.autoCheckUpdates === false`.

### Cut a release

**`npm run release` is the only way a release is published.** Never `gh release create` by
hand, never a script outside the repository, never a copy of the artifacts. On 16/09 all three
happened: 1.7.0 and 1.7.1 were built in a worktree while the folder Noah opens stayed on 1.6.19,
the artifacts were copied instead of moved, and one version's `latest-mac.yml` was written over
another's.

Before it, as always: the version bumped in `package.json`, its entry at the top of
`src/data/changelog.ts`, merged into `main`, and the gate passed (`npm test`, both `tsc`, lint,
the final e2e).

```bash
npm run release -- --dry-run   # the checks, the artifacts of this version if built, the notes; nothing else
npm run release                # the release
```

Between two releases, `release/` of the main checkout holds the last release's build, its
`latest-mac.yml` included. The dry run says so and checks the artifacts only once `release/` holds
a build of the version being released.

`scripts/release.mjs` stops at the first thing that is not as it should be:

1. **refuses** unless `HEAD` is `origin/main` after a fetch, the tracked tree is clean,
   `v<version>` exists on GitHub neither as a release nor as a tag, the top entry of the
   changelog is that version, and no newer version is published. A GitHub it cannot ask is a
   refusal, not a pass;
2. runs `npm run electron:build` in this checkout (a worktree is fine), without `CI`, `GH_TOKEN`
   or `GITHUB_TOKEN`, so `electron-builder` never publishes anything by itself. **Not before**
   checking what the build writes over: `latest-mac.yml`, `builder-debug.yml` and `mac-arm64` in
   `release/` belong to the last build put there. They may go only if that build is an earlier
   attempt at this same version, or an older version GitHub proves published with that very
   `latest-mac.yml`. From a worktree, the kept folder must also be able to take the build at step
   7: no file of this version in it, and the same proof for the build it holds, or the release
   would be public before the move is refused. The dry run makes the same checks;
3. checks the artifacts: `version` of `latest-mac.yml`, the size and sha512 (base64 of the whole
   file) it gives the dmg and the zip, and `CFBundleShortVersionString` of the built app;
4. writes the notes from that changelog entry, with the footer on the ad hoc signature, in the
   form of `v1.7.1`. A long dash stops it;
5. `gh release create v<version>` with the dmg, the zip and `latest-mac.yml`, on the exact commit
   built (`--target`), as the latest release;
6. reads back what GitHub serves: the tag on that commit, the `sha256` digest of every asset
   against the local file, `latest-mac.yml` byte for byte, and `/releases/latest`;
7. from a worktree, **moves** (never copies) the dmg, the zip, their blockmaps, `latest-mac.yml`,
   `builder-debug.yml` and `mac-arm64` into the kept folder. It checks again what step 2 checked
   before building: it overwrites no file of this version with other bytes, and replaces the
   previous build's manifest and app only when GitHub proves that version published with that very
   manifest;
8. prunes the kept folder;
9. prints the local path of the dmg and the URL of the release.

`latest-mac.yml` must be in the release assets or `electron-updater` throws and every client
silently drops to the GitHub-API fallback.

### Which builds are kept

**The kept folder is `release/` of the main checkout**, `/Users/noah/tars/release/`, the one Noah
opens. `scripts/prune-releases.mjs` finds it through git (the parent of
`git rev-parse --git-common-dir`) from the main checkout or any worktree, and never uses
`release/` of the current directory; tests name their folder with `--release-dir` or
`TARS_RELEASE_DIR`.

It keeps the **three newest versions** and deletes an older one **only when GitHub proves it
published**: a release `v<version>` on the repository of `build.publish` carrying its dmg and
its zip, with the size and, where GitHub gives one, the `sha256` digest of the local files. A
version that is not published, or published with other files, is kept and named. When the proof
cannot be had at all (gh missing, logged out, offline, an API error), nothing is deleted, the
build still succeeds, and every version kept for that reason is named. It runs at the end of every
`electron:build` and as step 8 of the release.

Beside the versions, the folder holds the `latest-mac.yml`, `builder-debug.yml` and `mac-arm64`
of the last release. Leave them: the next release checks them before building over them (step 2),
and a manifest deleted by hand is one that nothing can compare any more.

---

## The agents' CLIs: kept up to date by Tars

Tars starts every claude with `DISABLE_AUTOUPDATER=1` and every Amp with its update check off,
so neither updates itself inside a Tars terminal. Tars updates them instead
(`electron/services/cli-updater.ts`): 5 s after launch, then every 30 minutes, one CLI at a time.

| CLI | Covered when installed as | Command Tars runs |
|---|---|---|
| claude | the native installer: `~/.local/bin/claude` is a link into `~/.local/share/claude/versions/` | `claude update` |
| amp | a global npm package | `npm view <package> version`, a download into a scratch prefix, then `npm install --global --prefix <prefix> --prefer-offline <package>@<version>`, with the npm beside that prefix's node and a cache in the scratch folder, deleted after |

What a running session sees: nothing. A claude update writes the new version beside the old one
and swaps the link in one step; the session keeps running its own file, and its next turn
answers. New launches and restarts start on the new version. A session that outlives two newer
releases can see its file deleted by claude's own cleanup (SPECS §13): its turns go on, but its
Grep and Glob fail (every time with no `rg` on PATH, once with Homebrew's), as does a `claude`
started from inside it, and a restart ends it.

An Amp update is never started while a process has the Amp binary open (`lsof -t`), because npm
removes the old package before the new one is in place: `amp` is missing for a few seconds while
it runs, and a launch in those seconds fails. npm's cache for it lives in the scratch folder and
goes with it, so `~/.npm` does not grow by an Amp release each time; each check fetches the
package's metadata whole instead, 1.2 MB for `@sourcegraph/amp`.

Everything else is left alone and named once per launch in the log: codex, gemini, grok,
opencode, pi, claude installed through npm or Homebrew, Amp installed any other way. Update those
yourself.

```bash
# what Tars did, newest last, times in UTC (these two are from the sandbox it was measured in)
tail -n 20 ~/.dorothy/cli-updates.log
# 2026-09-22T20:30:40.981Z claude updated 2.1.273 to 2.1.280: Successfully updated from 2.1.273 to version 2.1.280 (9.0 s)
# 2026-09-22T20:34:32.376Z amp updated 0.0.1788811227-gce258b to 0.0.1790107230-g213fd2: npm install -g @sourcegraph/amp@0.0.1790107230-g213fd2 (17.4 s)

# what is installed now
readlink ~/.local/bin/claude          # .../versions/<version>
amp --version
```

A check that changes nothing is written once, not every half hour; a failure is written every
time. Past 256 KB the log moves to `cli-updates.log.1`.

**To stop it for one CLI**, use that CLI's own switch, which Tars reads: for claude,
`"env": { "DISABLE_AUTOUPDATER": "1" }` in `~/.claude/settings.json` (or `DISABLE_UPDATES`, the
administrator lockdown, which also makes a typed `claude update` refuse); for Amp,
`"amp.updates.mode": "disabled"` in `~/.config/amp/settings.json`. Tars started with
`DISABLE_AUTOUPDATER` in its own environment, from a Tars terminal for instance, updates nothing
for claude.

| Log line | Meaning |
|---|---|
| `claude failed ...: Error: Failed to install native update; ... ECONNREFUSED ...` | no network. Retried at the next pass |
| `claude failed ...: Another Claude process ...` | a `claude update` of yours was running. Retried at the next pass |
| `claude unchanged ...: Updates are disabled by your administrator...` | `DISABLE_UPDATES` in a managed settings file. Tars cannot see it beforehand; claude refuses and says so |
| `claude skipped: ... is one fixed version` | Settings > CLI paths points at `~/.local/share/claude/versions/<v>`: point it at `~/.local/bin/claude` |
| `amp deferred ...: waiting for the process running it to end (pid N)` | an `amp` is running, in Tars or elsewhere. Updated at the first pass after it ends |
| `... skipped ...: is outside <home>` | the install belongs to another home. Normal in a sandbox (`scripts/sandbox.sh`), whose `HOME` is `~/Tars-sandbox` |

An Amp installed before its rename is the package `@sourcegraph/amp`, and `amp update` cannot
update it: it runs `npm install -g @ampcode/cli`, which fails with `EEXIST` on the `amp` link the
old package owns. Tars updates `@sourcegraph/amp` by its own name, which works. Moving to the new
name is a manual step: `npm uninstall -g @sourcegraph/amp && npm install -g @ampcode/cli`.

---

## Storage

Everything Tars owns lives under `~/.dorothy` (`DATA_DIR`). Nothing is in a database except
the vault. All of it is `HOME`-relative, which is what makes the sandbox and E2E isolation
work.

### The file table

| Path | Written by | Contents |
|---|---|---|
| `~/.dorothy/agents.json` | `electron/core/agent-manager.ts` | the fleet: schema `version: 2`, `savedAt`, `agents[]` |
| `~/.dorothy/agents.backup.json` | same | last good copy, taken from content just parsed successfully |
| `~/.dorothy/app-settings.json` | `electron/main.ts` (`saveAppSettingsToFile`) | every setting: provider keys, Telegram/Slack/X/Jira, CLI paths, memory backends |
| `~/.dorothy/api-token` | `electron/services/api-server.ts` | 32 random bytes hex, mode `0600` |
| `~/.dorothy/hermes-connection.json` | `electron/services/hermes-config.ts` | gateway mode/url/token/ssh |
| `~/.dorothy/kanban-tasks.json` | `electron/handlers/kanban-handlers.ts` | board |
| `~/.dorothy/bus.json` | `electron/services/bus-store.ts` | the agent bus journal: threads, messages, deliveries, and any membership set by hand. Rooms themselves are derived from the fleet, and the global room is the overseer's own conversation, not a copy of it |
| `~/.dorothy/templates.json` + `templates.backup.json` | `electron/handlers/template-handlers.ts` | agent templates |
| `~/.dorothy/team-templates.json` | `electron/handlers/team-template-handlers.ts` | team blueprints |
| `~/.dorothy/projects.json` | `ipc-handlers.ts` (`CUSTOM_PROJECTS_FILE`) | manually added projects |
| `~/.dorothy/cli-paths.json` | `electron/handlers/cli-paths-handlers.ts` | resolved binary paths, readable by MCP |
| `~/.dorothy/cli-updates.log` + `.1` | `electron/services/cli-updater.ts` | one line per CLI update result; moved to `.1` past 256 KB |
| `~/.dorothy/usage-ledger.jsonl` | `electron/services/usage-ledger.ts` | one line per turn; capped 20 000 → trimmed to 12 000 |
| `~/.dorothy/observations/<slug>.jsonl` | `api-routes/memory-routes.ts` | post-tool-use ledger; capped 1 000 → trimmed to 500 |
| `~/.dorothy/model-catalog.json` + `.meta.json` | `electron/services/model-catalog.ts` | models.dev mirror, 6 h TTL |
| `~/.dorothy/acp-registry.json` | `electron/services/acp/registry.ts` | ACP launch commands, 24 h TTL |
| `~/.dorothy/vault.db` | `electron/services/vault-db.ts` | SQLite, WAL, `foreign_keys=ON` |
| `~/.dorothy/vault/` + `vault/attachments/` | same | vault file bodies |
| `~/.dorothy/telegram-downloads/` | `electron/services/telegram-bot.ts` | inbound media |
| `~/.dorothy/CLAUDE.md` | `electron/utils/index.ts` | copied from the repo at every boot, loaded by agents via `--add-dir` |
| `~/.dorothy/statusline.sh` | `electron/utils/statusline.ts` | installed only when the statusline is enabled |
| `~/.dorothy/token-stats.json` | the `statusline.sh` it installs | one entry per Claude session, rewritten at every render; anything that is not one JSON object starts again from `{}` |

Two files live outside that directory, on purpose, in `~/.tars-private`. `~/.dorothy` is handed to
every agent through `--add-dir`; this directory is handed to nothing, no path under it is ever passed
to a CLI, and Tars makes it `0700` whichever write creates it:

| Path | Written by | Contents |
|---|---|---|
| `~/.tars-private/overseer.json` | `electron/services/overseer.ts` | Noah's conversation with the super chat, plus the standing job id and the Chat's settings. Mode `0600`. Moved out of `~/.dorothy/overseer.json` at the first startup that finds it there: the copy is read back before the old file is deleted, an old file that will not parse is left exactly where it is and still read, and when both exist the private one wins and the old one is moved into the private directory rather than deleted |
| `~/.tars-private/hermes-webhook-secret` | `electron/services/hermes-webhook-secret.ts` (`provisionWebhookSecret`) | the bearer for `POST /api/webhooks/hermes` and the only credential that opens it: 32 random bytes hex, mode `0600`, minted the first time Settings > Hermes asks for it. Moved out of `~/.dorothy/hermes-webhook-secret` at the first startup that finds it there, value unchanged, so Hermes keeps working; read back before the old file is deleted, and while it cannot be moved the webhook opens to nobody. An old file found beside the private one opens nothing and is deleted |

Outside `~/.dorothy`, Tars writes into provider config it does not own: see *MCP servers* and
*Hooks*. Memory files it reads live in `~/.claude/projects/<encoded-path>/memory/`, where the
project path is encoded as a folder name (slashes → dashes).

### Migration from `~/.claude-manager`

`migrateFromClaudeManager()` runs on every boot. If `~/.claude-manager` exists it copies
`agents.json`, `agents.backup.json`, `app-settings.json`, `kanban-tasks.json`,
`scheduler-metadata.json`, `telegram-downloads/`, `scripts/` (**skipping anything that
already exists in `~/.dorothy`**) then `rm -rf`s the old directory. It is one-way and
destructive of the source. Back up `~/.claude-manager` before first launch of a renamed build
if you care about it.

### Recovering `agents.json`

`saveAgents()` writes to a temp file and renames it into place, so a crash mid-write leaves the
previous file intact rather than truncated. The backup is only taken from content that just
parsed successfully: a corrupt current file cannot overwrite the last good copy.

Autosave flushes every **30 s** when dirty (`FLUSH_INTERVAL_MS`), plus once on `before-quit`.
Only the last 100 output chunks per agent are persisted (400 are retained in memory,
`OUTPUT_RETAIN`), and `running` is written back as `idle`: a restored agent is never live.

If the fleet comes back empty:

```bash
# 1. is the current file parseable?
jq '.version, (.agents | length)' ~/.dorothy/agents.json

# 2. is the backup better?
jq '.version, (.agents | length), .savedAt' ~/.dorothy/agents.backup.json

# 3. restore: Tars must be quit, or before-quit will overwrite it
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
`~/.gemini/settings.json` or `~/.grok/config.toml`: see the two sections below for those.

---

## The local API server

`electron/services/api-server.ts`, bound to **`127.0.0.1:31415`**
(`API_PORT = Number(process.env.DOROTHY_API_PORT) || 31415`). This is how agents drive other
agents: the bundled MCP servers, the shell hooks and any external scheduler all speak to it.

### Auth model

Three layers, in order:

1. **Origin check.** Any request carrying an `Origin` header that is not `app://-` or
   `http://localhost:3000` is rejected `403 Forbidden origin`: a browser tab on any site can
   reach `127.0.0.1`, and CORS hides the response but not the side effect. Shell hooks send no
   `Origin` at all, which is why they pass.
2. **Bearer token.** `Authorization: Bearer <~/.dorothy/api-token>`, or the token an agent was
   started with (`CLAUDE_MGR_API_TOKEN`), else `401`. Exempt paths: `/api/health`,
   `/api/local-file`, and anything under `/api/hooks/`. **Who is calling** is decided here too,
   by `resolveCaller`: an agent's own token names that agent, and an `X-Tars-Caller-Id` naming
   anyone else alongside it is refused `403` before any route runs. The shared token names no
   agent, and no header is read with it: every agent can read that file.
3. **Body limit.** 4 MiB (`MAX_BODY_BYTES`) → `413`, enforced *before* routing so the exempt
   hook paths cannot exhaust main-process memory without a credential. `__proto__` and
   `constructor` are stripped from every parsed body.

If the port is taken the server logs `Port 31415 is in use, API server not started` and the
app carries on **without an API**: every agent-to-agent call then fails. There is no retry
and no UI warning.

### Talk to it

```bash
TOKEN=$(cat ~/.dorothy/api-token)
API=http://127.0.0.1:31415

curl -s $API/api/health                                    # {"ok":true}, no auth
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
| POST | `/api/kanban/generate` |
| POST/GET | `/api/bus/post` · `/api/bus/read` (what `room_post` and `room_read` call; authenticated, and the caller is the agent its token names; a call on the shared token has no agent behind it and is refused `403`, before any room is looked at) |
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

The identity comes from the token the MCP client presents, and from nothing else:
`spawnAgentPty` mints one per agent terminal and `delegateOverAcp` one per delegated run, into
`CLAUDE_MGR_API_TOKEN`, and the caller's project is that agent's `projectPath` in the fleet. The
headers (`X-Tars-Caller-Id`, `X-Tars-Caller-Project`) scope nothing, on any token.

An MCP client whose process has no token of its own falls back to `~/.dorothy/api-token` and is
refused on these routes:

```
403 This agent has no identity, so its calls cannot be scoped to a project.
    An agent is known by the token Tars gives its process when it starts it, not by a name:
    restart the agent from Tars.
```

It happens to an agent started outside Tars, or to a CLI that does not pass its environment on
to its MCP servers. Confirm the token reached the server process (names only, never print the
values):

```bash
ps -Eww -o command= -p <pid of the mcp-orchestrator bundle> | tr ' ' '\n' | grep -o '^CLAUDE_[A-Z_]*=' | sort -u
```

**What this guard is not.** A caller with no agent token and no `X-Tars-Client: mcp` header is
not scoped at all: that is how the super chat dispatches to every project, and it is also what
any process that reads `~/.dorothy/api-token` gets. `allowCrossProject: true` lets any agent
through. The guard stops an orchestrator from acting on the wrong project by mistake; it does not
stop an agent that means to.

`mcp-kanban` is outside this: it never calls the API, it reads and writes the files directly.

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

1. calls `killStalePty(agent)`: if the PTY's recorded `ptyCwd` no longer matches
   `worktreePath || projectPath`, the PTY is killed so the spawn path restarts it in the right
   directory;
2. **refuses with `409`** if the agent is `waiting` on a permission dialog: a typed message
   cannot answer arrow-key UI, and the trailing `\r` could *accept* the pending permission:
   `Agent "X" is blocked on a permission dialog; a typed message cannot answer it.`
3. types the message into the session (`mode: "message"`) when a CLI runs in the terminal,
   whatever the status says (a turn ends on `idle`, a failed one on `error`, both with the CLI
   at its prompt). A session the API started counts from its spawn: its terminal was handed
   `cd … && exec <cli>` and ends with the CLI. The status alone never types: `running` or
   `waiting` over a bare shell had the message run as a command. Otherwise it
4. spawns a fresh session with the message as the prompt (`mode: "start"`), only where no CLI
   runs: the spawn kills the terminal, and a session it replaced is not resumed.

Until 2026-09-23 step 3 read the status alone, so a message to an agent that had just ended a
turn (`idle`) spawned over its CLI and threw its conversation away: the hooks log shows it as a
`SESSION_END` of the agent's session followed within two seconds by a `SESSION_START` of a new
one. `/message` follows the same rule; `/start` refuses with `409` (`cliRunning: true`) when a CLI
is up.

Until the same date a session the API started ran its CLI without `exec`, and the terminal named
`bash` in front for the CLI's whole life: such an agent read as no CLI (`cliRunning: false`, a
Start button on its panel) while claude worked, so the rule above did not protect it, and Start
typed its launch line into claude's field. To see which shape a live agent has, read its CLI's
parent without touching it: `ps -o pid,ppid,comm -p <claude pid>`. Under a build with the exec,
an API-started claude is a child of Tars itself (`Electron` in a development run), with no shell
in between; a claude started from the Dashboard runs under an interactive `/bin/bash -l`, as
before. Under an older build the first has a `/bin/bash -l -c cd …` parent, and reads as no CLI.

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
For each server × each of the 19 providers it calls `provider.isMcpServerRegistered(name, path)`
and, if absent, `provider.registerMcpServer(name, 'node', [bundlePath])`, yielding with
`setImmediate` between each because registering shells out and this is the thread that pumps
every PTY.

Each provider writes to its own config, CLI-first with a file fallback:

| provider(s) | config dir | mechanism |
|---|---|---|
| `claude` (+ `openrouter`, `deepseek`, `mimo`, `moonshot`, `qwen`, `zhipu`, `minimax`, `nvidia`, `nous-portal`, all share the `claude` binary and `~/.claude`) | `~/.claude` | `claude mcp add -s user …`, fallback `~/.claude/mcp.json`; presence checked in both `~/.claude/mcp.json` and `~/.claude.json` |
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

Registration is idempotent and re-runs at every boot: to force it, remove the entry from the
provider's config and restart Tars.

### Bundled skills

`installBundledSkills()` runs at the end of `setupMcpOrchestrator()`. Its `bundledSkills` list
is currently **empty**; what it does do is *remove* stale `world-builder` skill directories
from every provider's skill dir, and only when the `SKILL.md` content matches
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

### Claude: `~/.claude/settings.json`

Nine hooks, each installed as `{ type: 'command', command: '<hooksDir>/<file>', timeout: 30 }`:

| event | script | matcher |
|---|---|---|
| `SessionStart` | `session-start.sh` | `*` |
| `UserPromptSubmit` | `user-prompt-submit.sh` | - |
| `PostToolUse` | `post-tool-use.sh` | `*` |
| `Stop` | `on-stop.sh` | - |
| `StopFailure` | `stop-failure.sh` | - |
| `SessionEnd` | `session-end.sh` | `*` |
| `Notification` | `notification.sh` | `*` |
| `PermissionRequest` | `permission-request.sh` | - |
| `TaskCompleted` | `task-completed.sh` | - |

Existing entries are matched by `command.includes(<file>)` and **rewritten in place** when the
path changed: so moving or reinstalling the app repairs stale absolute paths, and a manual
edit to the command will be overwritten on next boot.

### Gemini: `~/.gemini/settings.json`

Separate scripts from `hooks/gemini/`: `session-start.sh`, `user-prompt-submit.sh`,
`post-tool-use.sh`, `on-stop.sh`, `session-end.sh`, `notification.sh`.

### What the hooks do

- `session-start.sh`: POSTs `{agent_id, session_id, status: idle, source}` to
  `/api/hooks/status`. Only `SessionStart` sends `source`; the server records the session id
  **without** touching status, because the status lifecycle belongs to `UserPromptSubmit`/`Stop`.
  It retries once after 1 s: a lost registration makes the stale-session guard ignore every
  later status post from that session. It then fetches `/api/agents/$CLAUDE_AGENT_ID/bootstrap`
  (identity + team roster) and `/api/memory/context`, and injects both as
  `hookSpecificOutput.additionalContext`.
- `user-prompt-submit.sh`: POSTs `{agent_id, session_id, status: running, event:
  UserPromptSubmit, current_task}`. `event` is what tells the server a turn actually began:
  `status: running` on its own cannot, because `post-tool-use.sh` sends that too and a dispatch
  has already set it at spawn. It is what clears the pending delivery in `armTaskStartWatch`.
- `post-tool-use.sh`: marks the agent `running` and POSTs the observation to
  `/api/memory/remember`.
- `on-stop.sh`: extracts the last assistant message (from `last_assistant_message`, or by
  streaming the transcript JSONL with `jq -rRn 'inputs | fromjson? …'`, portable because macOS
  has no `tac`, and tolerant of a truncated final line still being flushed), truncates to
  4 000 chars, POSTs to `/api/hooks/output`, then `/api/hooks/status` idle and
  `/api/hooks/agent-stopped`.
- `stop-failure.sh`: a turn that ends on an API error fires `StopFailure`, never `Stop`, and
  the CLI stays alive at its prompt, so without this the agent stays `running` for good. POSTs
  `{status: error, event: StopFailure, error_kind, error_message}` to `/api/hooks/status`, built
  with `jq -n --arg` because the message is the CLI's text. The server sets `status: error` and
  `agent.error` to that message verbatim, capped at 500 chars, which is also the body of the
  error notification. Measured with claude 2.1.268 and a HOME holding no credential:
  `error: authentication_failed`, `last_assistant_message: "Not logged in · Please run /login"`.
  The next `UserPromptSubmit` clears `agent.error`. About 60 s after the failure the CLI raises its
  idle prompt, which `notification.sh` sends twice, as a notification and as `status: waiting`:
  for an agent in `error` neither lands (`isStoppedOnAFailure` in `hooks-routes.ts`), so the
  card keeps the failure and no "is waiting" alert contradicts it. A permission prompt is not
  held back, since it only occurs inside a turn, and a turn has already left `error`.

### The idle prompt, and what an orchestrator is told (1.7.8)

That 60 s is measured: of the 1,393 idle prompts that followed a `Stop` in a month of this
machine's hook logs, 1,390 came exactly 60 s after it, and of the 345 `Stop`s followed by a new
turn inside that minute, none brought one. Three rules follow from it.

- **An idle prompt inside the minute is about a rest that is over.** `isStaleIdlePrompt`
  (`hooks-routes.ts`) drops a `waiting` on an agent that is `running` when `workHandedAt` or
  `lastTurnStartedAt` is less than 60 s old: the prompt was raised before the work and arrived
  after it. `/run-task` is how it happens, since it sets `running` and leaves the terminal
  alone, so the CLI keeps counting from its own last `Stop`. Neither the desktop alert nor the
  note to the orchestrator is sent. After that minute the prompt is taken, and it should be: 18
  turns that month ended with no `Stop` hook at all, and the idle prompt was the only sign.
- **The end of delegated work is announced at the `Stop`, not a minute later.** Coming back to
  rest, `idle` or the idle `waiting`, is news once, and only when a turn has begun since the work
  was handed over (`workHandedAt` against `lastTurnStartedAt`). Before 1.7.8 only the idle prompt
  ever said a delegated turn had ended, so every notice was a minute late.
- **Sitting still is not news.** An agent that comes back to rest for any other reason, typed in
  by hand or put back by a failed ACP start, reports nothing: the link a dispatch left is spent
  at the end of the work it was recorded for, and a spent link is written to disk with it.
  A note held for a busy orchestrator is dropped if the agent was handed new work since, or if
  the wait it described is over.

### A message that has to wait for what you are typing (1.7.8)

Tars types notes, room messages and dispatched tasks straight into a CLI's input field. If you
are half way through a sentence in that same field, the two used to be submitted together: your
unfinished text went out with the message. Never mix and never block, so:

- **While you are typing**, the message waits. Five seconds of quiet ends the wait, re-armed by
  every key, so it lasts as long as the typing does (`TYPING_PAUSE_MS`, `pty-manager.ts`).
- **At the first pause**, Tars empties the field, writes the message, submits it, and types your
  draft back exactly as it was, caret included, without sending it. Keys you type during that
  window are held and replayed in order.
- **If it cannot promise to give your draft back**, it writes nothing at all. Your field is
  never touched by something it does not understand.

What it understands is rebuilt from the keys the interface relays (`input-draft.ts`): of the 166
key encodings xterm sends from a Mac keyboard it follows 112 and gives up on 54, among them the
history arrows, Tab, a lone Esc, the word and line kills, the function keys, a paste that folds
into `[Pasted text #N]`, and Right or End at the very end of the text, where they can accept an
inline suggestion instead of moving.

**A wait always ends.** Sending what is in the field ends it, and so does Ctrl+C. An Enter on a
field Tars has lost track of is taken as "whatever was in it, it emptied", and the
`UserPromptSubmit` hook confirms it 33 to 57 ms later. Before 1.7.8 only Ctrl+C did, and a
message could sit behind a stale draft through a whole turn.

**A command typed by hand ends it too.** A `/model` or `/effort` picker answered with the arrows
and Enter fires no hook, and until 2026-09-23 a message waited behind it until somebody pressed
Ctrl+C in that terminal (three agents were deaf that way on 2026-09-22). A command leaves three
records in the session transcript when it finishes, `<local-command-caveat>`, `<command-name>`
and `<local-command-stdout>`, 44 to 74 ms after the key that closes it (Claude Code 2.1.280). A
terminal holding a message looks for them every second (`FIELD_PROBE_MS`,
`lastLocalCommandAt`), and one newer than the last key typed there means the field is empty:
the message goes in, and the log says `a command typed into <agent>'s terminal has finished`.
Not while a panel is open: `/config` wrote its records only when it closed. And only when the
last key typed there is the Enter or Esc that closed the panel: a key typed in the tens of
milliseconds before the record went into the field, and the message waits for it to be sent or
cleared. Three cases leave the message waiting for the next thing typed into that terminal, or
for Ctrl+C: `/help` and `/config` closed without a change write no record, and `/model`
cancelled with Esc writes two `system` records the reader skips on purpose, because the same
pair comes when the "Switch model?" confirmation is backed out of while the picker stays open.
A terminal that exits drops what it held for it.

**Where to see one.** The agent's panel says who is waiting; `agent:message-waiting` pushes each
change and `electronAPI.agent.messagesWaiting()` answers for a panel that opened later. In the
log, one line when a message starts waiting and one when it goes out:

```bash
# The main process logs to the terminal Tars was started from. No log file has
# these lines: app.getPath('logs') is never used, ~/Library/Logs/tars does not
# exist, and the one log Tars writes, ~/.dorothy/cli-updates.log, is about CLI
# updates only. Started from the Dock, these lines are only in the Console app.
grep 'is waiting for a terminal'   # in that terminal's output
grep 'is going out now'
```

`POST /api/agents/:id/dispatch` and `/message` answer `held: true` with a `heldReason` when the
message was queued behind a field rather than typed in, so an MCP client is not told it was sent.
`send_message`, `start_agent` and `delegate_task` say it too, in a result that begins `HELD:`;
`delegate_task` then returns at once rather than wait on a turn that has not begun
(`wait_for_agent` follows it).

**Who a message is from.** A message Tars types into a CLI, short or pasted, comes after a line
saying who sent it, as Tars verified it:
`Message from agent "<name>" ("<id>")` for the agent whose token made the call, `Message from
Tars` for Tars's own notes and pass, `Message from Telegram`, `Slack` or `Hermes`. Claude Code
2.1.280 hands a folded paste to the model as `<pasted_content>`, and a dispatch used to arrive
with nothing outside it; the line stays outside the tag (measured once with a real account; a
stub API with key auth never folds). Never a bare name: any agent can be named "Noah". A short
message used to go without the line, which let an agent type Tars's own line itself.

| Symptom | Cause |
|---|---|
| a task "sent" that the CLI never received | the terminal is holding a draft. The panel names it; clear the field with Ctrl+C or send it |
| the panel says a message is waiting and nothing is in the field | a key Tars does not follow left it unsure, or a command that ends without a record Tars takes (`/model` cancelled with Esc, `/help`, `/config` closed without a change). Ctrl+C settles it |
| a message waiting for an agent nobody is typing into | the pause is per terminal: check that the right one is named in `messagesWaiting()` |

A note is also skipped while the orchestrator is sitting in `GET /api/agents/:id/wait` on that
same agent: the long poll's answer already says it, and typing it in again costs the
orchestrator a whole turn to read what it has been handed. Every other way it is told, from
`send_message` to Telegram, Slack and the webhook, has no poll behind it and still gets the note.

| Symptom | Where to look |
|---|---|
| "X is now waiting" about an agent that is working | an idle prompt older than the minute, or a turn that sent no `Stop`. `/tmp/dorothy-hooks.log` gives the prompt's time; compare with the last `UserPromptSubmit` |
| an orchestrator never hears that its agent finished | the link. `jq '.agents[] \| select(.id=="<child>") \| .requestedBy' ~/.dorothy/agents.json`: absent means spent, and a `ptyId` that is not the agent's current one is inert by design |
| the orchestrator reads the same end of turn twice | it was not in a `/wait` when the turn ended, so the note was written as well. Expected on any path that is not the long poll |

Hooks read the API token from `$HOME/.dorothy/api-token` and pass it via
`-H @<(printf "Authorization: Bearer %s" …)`, process substitution, so the token never appears
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
| agents stuck `idle` while clearly working | `jq` not on the hook's PATH: every script `exit 0`s with `{"continue":true}` and posts nothing |
| status posts ignored after a restart | `SessionStart` registration was lost; the stale-session guard drops later posts. Stop and re-dispatch the agent |
| no memory injected at session start | `/api/memory/context` returned empty, or `$HOME/.dorothy/api-token` is unreadable; `/api/memory/*` is **not** auth-exempt |
| sandbox/E2E agent status shows up in prod | fixed in 1.7.0: the hooks follow `CLAUDE_MGR_API_URL`. On an older build they hardcoded `31415`; see *Run a second Tars beside your live one* |

---

## Memory backends

Six sources sit behind one interface (`electron/services/memory-hub.ts`):

| id | source |
|---|---|
| `project` | `~/.claude/projects/<encoded>/memory/*.md`, `MEMORY.md` first |
| `observations` | `~/.dorothy/observations/<slug>.jsonl`, last 15 |
| `hermes` | gateway `GET /api/memory` + `GET /api/sessions/search` |
| `gbrain` | remote streamable-HTTP MCP server |
| `honcho` | remote streamable-HTTP MCP server |

Both remote backends are spoken to directly over MCP (`electron/services/mcp-http-client.ts`,
protocol `2025-06-18`, `Accept: application/json, text/event-stream`, 15 s timeout), so
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
entry whose URL matches the one Tars itself configured: a gbrain you registered by hand
survives.

### Check reachability

```bash
TOKEN=$(cat ~/.dorothy/api-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:31415/api/memory/status?project_path=$PWD" | jq
```

Returns one object per source with `{id, label, configured, reachable, detail, tools[]}`.
`configured: true, reachable: false` means the URL is set but the MCP handshake failed: check
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
silently and an empty result means "all sources". `limit` is clamped to 1-50.

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

- **token**: static `X-Hermes-Session-Token` header;
- **cookie** (`auth_flows: ['cookie']`): `POST /auth/password-login {provider, username,
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

Hermes exposes no HTTP API for memory *content*: `/api/memory` returns state only; the
searchable body is the FTS index behind `/api/sessions/search`.

### Inbound webhook

`POST /api/webhooks/hermes` lets the gateway drive a Tars agent.

```bash
# the secret is auto-provisioned (32 random bytes, mode 0600) when Settings > Hermes first shows it
cat ~/.tars-private/hermes-webhook-secret

# make the localhost-bound API reachable from the VPS
tailscale serve 31415

# validate auth + agent resolution without dispatching
curl -s -X POST https://<this-machine>.<tailnet>.ts.net/api/webhooks/hermes \
  -H "Authorization: Bearer $(cat ~/.tars-private/hermes-webhook-secret)" \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"Backend","project_path":"$PWD","message":"ping","dry_run":true}' | jq
```

Body: `agent_id` **or** `agent_name` (case-insensitive exact match, narrowed by
`project_path` when the same role exists on several projects), plus `message` (required),
`model`, `permission_mode` (`normal|auto|bypass`), `dry_run`.

Auth: the webhook secret, and nothing else. The master `~/.dorothy/api-token` used to be
accepted as a fallback; since 1.7.6 it gets a `403`, as do an agent's own token and Tars's pass,
and with no secret file nothing opens the route at all. Before 1.7.6 a missing secret file
skipped the route's check entirely. This is the one route published over the tailnet, which is
why it carries its own credential. A Hermes job set up with the master token needs the secret
from Settings > Hermes instead.

Rotating the secret: delete `~/.tars-private/hermes-webhook-secret`, open Settings > Hermes, which
mints a new one, and give Hermes that. Worth doing once after upgrading to 1.7.6: until then the
secret sat in `~/.dorothy`, which every agent can read.

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

If Tasmania is not `running`, the agent is spawned **anyway**, with no Tasmania env vars: the
log line is `Agent <id> is local provider but Tasmania is not running. PTY created without
Tasmania env vars`. The agent then silently talks to the public Anthropic API. Check the status
before starting local agents.

Tasmania is also registered as an MCP server when `tasmaniaEnabled` is set and
`tasmaniaServerPath` exists; a missing path logs `Tasmania MCP server not found at <path>` and
is skipped.

---

## Agents and PTYs

Every agent runs in a `node-pty` login shell: `pty.spawn('/bin/bash', ['-l'], …)`,
`xterm-256color`, `cwd = worktreePath || projectPath` (falling back to `$HOME` with a warning
if that path is gone), at the size the agent's panel last asked for, or 120×30 (120×40 for an
API-driven session) when no panel has. Free-standing terminals use `process.env.SHELL || '/bin/zsh'`.

The environment is `process.env` plus:

- `PATH`: rebuilt by `buildFullPath()` from `~/.nvm/versions/node/v20.11.1/bin`,
  `~/.nvm/versions/node/v22.0.0/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`,
  and every `~/.nvm/versions/node/*/bin` (`~/.grok/bin`, `~/Library/pnpm` and `~/.yarn/bin`
  are only in `detectCLIPaths()`'s probe list, not the PTY PATH);
- provider env (`getPtyEnvVars`, this is where `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` are
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
shells: set the path explicitly in Settings rather than fighting it.

### What a panel shows

A panel is handed its terminal's screen by `agent:get`, from the terminal's mirror
(`electron/core/terminal-mirror.ts`): a headless xterm fed every byte of that PTY. It does
not depend on how much output was kept, so a panel that comes back after a long turn is whole.
Cost, measured with 20 PTYs replaying real Claude Code streams under Electron 43: 3.1 ms of
main process CPU per second for all 20 (68 chunks a second), 0.3 MB per mirror at 180×45, a
snapshot of 2 KB in 1 to 2 ms. A mirror with its 1000 lines of history full is 2.3 to 3.7 MB
and its snapshot 127 to 254 KB in 9 to 18 ms; a flood costs about 30 ms of CPU per MB.

| Symptom | Look for |
|---|---|
| a panel blank but for the spinner after coming back to the Dashboard | `[terminal-mirror] xterm-headless could not be loaded` at startup: without it the panels replay the kept chunks, as they did before the mirror. `[terminal-mirror] <agent id>: dropped after a parse failure`: that one terminal fell back |
| the wheel does nothing in a Claude panel, keys still work | `[terminal-mirror] <agent id>: repaints inline on an alternate screen it never left`. Claude Code left fullscreen without resetting the terminal; the agent carries `leftFullscreen: true`. The panel's history view reads the transcript, and a restart brings a fullscreen session back |
| Claude drawn at another width than its panel | the PTY predates the panel's size. `agent:resize` is remembered even with no PTY and a new PTY is spawned at it; a panel only sends its size when it changes |

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

### An agent restarted by itself after its model or effort changed

Saving a model, an effort, a permission mode, orchestrator mode, a secondary folder, an
Obsidian vault or a local model in the Agents page restarts that agent's CLI on the new values,
continuing its conversation (`--resume <session> --fork-session`), unless something would be cut
(`electron/core/agent-restart.ts`). Every decision is one line in the main process log:

```
[restart] Planner: model, effort changed: restarting its CLI now
[restart] Planner: model changed: restarting when its turn ends
[restart] Planner: model changed: restarting once its field is empty: something is typed in it and not sent
[restart] Planner: effort changed: restarting once the background work it started (bql8cpyac) has reported back
[restart] Planner: effort changed with no CLI running: the next launch uses the new values
```

A turn can end with work still running in the background (Claude Code refuses a long foreground
`sleep` and runs it in the background, and orchestrators run monitors that way). That work
reports back as a turn of its own; the restart waits for it, reading the session's transcript.

A restart waiting on a field is waiting on you: send what is typed there, or clear it. Only the
CLIs on the claude binary are restarted this way, the thirteen providers that point it at another
vendor included, and they continue their conversation too; codex, gemini, grok, opencode, pi and
amp never are: stop and start them. To see what a running CLI was actually launched with, read
its argv (the model and effort are on the command line):

```bash
ps -Aww -o pid,lstart,args | grep -- '--add-dir' | grep -v grep
```

### Fleet-wide log search

The Logs page reads the retained output buffers in the main process (400 chunks per agent, ANSI
stripped, capped at 500 result lines). It supports plain substring search or `/regex/flags`;
a bad regex falls back to a literal search rather than throwing.

These buffers are **memory only**. Only the last 100 chunks per agent survive to
`agents.json`; restarting Tars loses the rest. If you need durable output, capture it from
`GET /api/agents/:id/output?lines=N` while the app is up.

---

## Usage and cost accounting

Two independent sources feed the Usage page:

1. **`~/.dorothy/usage-ledger.jsonl`**: one record per turn, written by
   `recordUsage()`. Every ACP turn reports its own tokens, which is the only source that covers
   Codex, Gemini, Grok and the rest. When the agent does not report a cost, the ledger prices
   the turn itself from the catalogue; cache reads default to 10 % of input and cache writes to
   125 % when the catalogue omits them.
2. **Claude Code transcripts**: `~/.claude/projects/**/*.jsonl`, parsed by
   `electron/services/transcript-usage.ts`. Claude Code only writes
   `~/.claude/stats-cache.json` for some account types; the per-message `usage` block in the
   transcripts is always there. 1 h cache writes are kept apart from 5 m ones because they
   price at 2× base rather than 1.25×.

Both reach the page per local day, so that one window can cut every figure: the transcripts
through `claude:getData` (`stats.dailyModelTokens[i]`, with the day's `costUSD` and its split
`costByModel`), the ledger through `usage:by-provider` (`daily` for every turn in the file, and
`oldest` for the first day it still holds). A ledger row whose provider is `claude` is in the
transcripts too: the Claude ACP adapter runs the claude binary, which writes one.

`~/.dorothy/token-stats.json`, which the status line writes, is not a third source. Every
session in it ran in the claude binary and is in the transcripts already, so its `extraCost`
says how much of that spend went over quota; it is never added to it.

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
wc -c ~/.dorothy/token-stats.json; jq 'length' ~/.dorothy/token-stats.json  # status line sessions
```

| Symptom | Cause |
|---|---|
| "Usage by Provider" empty for non-Claude CLIs | those agents ran over PTY, not ACP; only ACP turns hit `recordUsage()` |
| costs plausible but stale | catalogue served from disk after a failed fetch; delete `~/.dorothy/model-catalog*.json` and restart |
| Claude costs zero | no transcripts under `~/.claude/projects/` for the window being shown |
| "of which ~$X over quota" never shows under the total cost | `~/.dorothy/token-stats.json` is 0 bytes. A status line script older than 2026-09-22 can never refill an empty file (jq given nothing prints nothing, and that is moved back over it); the fixed script is installed at the next launch while the status line is on |

---

## ACP transport

`electron/services/acp/` drives CLIs over the Agent Client Protocol instead of typing into a
terminal: the same JSON-RPC conversation for Claude Code, Codex, Gemini, Grok, opencode and
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

A run is set to the agent's model, then its effort, with `session/set_config_option` once the
session is open, when the agent offers those options. A value it refuses is logged as
`[acp] <agent>: this run is not on <model>` (or `... at <level> effort`) and the turn runs anyway.

---

## Lifecycle

### Boot order (`electron/main.ts`, `app.whenReady()`)

`ensureTarsClaudeMd()` → `migrateFromClaudeManager()` → `loadAgents()` →
`startAgentAutosave()` → `initTray()` → `initVaultDb()` → `startApiServer()` →
`loadCatalog()` (un-awaited) → `setupMcpOrchestrator()` (un-awaited) →
`setupMemoryBackends()` → `await configureStatusHooks()` → `initAutoUpdater()` →
update check after 5 s → `startCliUpdates()`, whose first pass runs 5 s later too (see *The
agents' CLIs: kept up to date by Tars*).

The two un-awaited calls are deliberate: both shell out per provider and used to hold the main
thread through the first paint.

### Shutdown (`before-quit`)

`destroyTray()` → `stopAgentAutosave()` → `saveAgents()` → `killAllPty()` → `closeVaultDb()`.

**Killing Tars with `SIGKILL` skips all of it**: up to 30 s of agent state is lost, every PTY is
orphaned, and the SQLite WAL is left unclosed. Quit from the menu or the tray.

On macOS, closing the window does **not** quit: `window-all-closed` only quits on
non-darwin. The tray stays live and agents keep running. To actually stop everything:

```bash
osascript -e 'quit app "Tars"'     # graceful, runs before-quit
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
only 234. The top-level `-not -path './node_modules/*'` is not enough: you must exclude
`node_modules` at every depth:

```bash
find . -name '*.test.ts' -not -path '*/node_modules/*' -not -path './.worktrees/*' -not -path './.claude/*'
```

Also gitignored and safe to delete: `.next/`, `out/`, `electron/dist/`,
`mcp-*/dist`, `mcp-*/node_modules`, `e2e/report/`, `test-results/`, `design/exports/`,
`*.tsbuildinfo`. Not `release/` of the main checkout: it is the folder where builds are kept,
and it may hold the only copy of a version never published (see *Which builds are kept*).

`build/` is in `.gitignore` but `build/entitlements.mac.plist` is tracked: do not "clean" it.

`CLAUDE.md` at the repo root carries a block re-written by `next dev`
(`node_modules/next/dist/server/lib/generate-agent-files.js`). Removing it from a diff only
re-creates the uncommitted change; commit it with your work to keep the tree clean.
