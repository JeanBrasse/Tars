# Tars 1.5.0: surface inventory

Every surface the app can render today. The Pencil document `design/tars-redesign.pen`
must contain a frame for each line here; `npm run e2e:guard` checks the routed
ones are covered by the visual suite too.

Generated against the code, not from memory. Anything removed from the app
(ClaudeMon, Support, the 3D view, Obsidian, Automations, Scheduled Tasks,
custom dashboard boards, the sidebar collapse) is deliberately absent.

## Pages (14)

| Route | Name | Frame |
|---|---|---|
| `/` | Dashboard (terminal grid) | Dashboard · dark, Dashboard · light, Dashboard · panel history, Panel history · states |
| `/chat` | Chat (Hermes overseer) | Chat · Overseer |
| `/agents` | Agents | Agents · dark |
| `/kanban` | Kanban | Kanban · dark |
| `/crons` | Schedules | Schedules · dark |
| `/review` | Review | Review · dark |
| `/logs` | Logs | Logs · dark |
| `/vault` | Vault | Vault · dark |
| `/projects` | Projects | Projects · dark |
| `/skills` | Extensions (Skills + Plugins) | Extensions · Skills, Extensions · Plugins |
| `/usage` | Usage | Usage · dark, Usage · light, Usage · daily messages |
| `/memory` | Brain (Projects / Agents / Backends) | Brain · Projects, Brain · Agents, Brain · Backends |
| `/whats-new` | What's new | What's new · dark |
| `/settings` | Settings | see below |
| `/tray-panel` | Tray panel (menu-bar popover) | Tray panel |

## Settings (6 groups, 17 sections)

| Group | Sections |
|---|---|
| General | Preferences, Terminal, Notifications, System |
| AI & Providers | Providers, CLI Paths, Permissions |
| Hermes | Connection (+ link out to Schedules) |
| Integrations | Telegram, Slack, X (Twitter), Google Workspace |
| Extensions | Skills & Plugins, Custom MCP, Tasmania |
| Workspace | Git, Memory Backends |

## Overlays and dialogs (13)

- New agent / New team (`NewChatModal`): one screen, a "One agent | A team"
  switch in the header. One agent: project, provider tiles + model, task
  textarea, one collapsed Options row (skills, effort, permissions, worktree,
  orchestrator, CLI binary). A team: project + start-from-preset, a member
  table (role/provider/model/effort/branch), a shared brief, the same
  Options pattern. Replaces the old four-step wizard and `DeployTeamDialog`.
  Frames: Overlay · New agent (one screen), Overlay · New team (one screen),
  Overlay · New agent · Options open
- Templates manager, Template form, Instantiate, Import - unchanged, but as of
  the one-screen redesign they have no entry point left in the app (the
  template-chip row they opened from is gone, and nothing else calls them)
- Agent terminal dialog: header, panel header, footer, sidebar, secondary project,
  super-agent sidebar
- Start prompt (`StartPromptModal`)
- Kanban: new task, card detail, done summary
- Plugin install, Install terminal (settings)

## Menus, dropdowns and controls

- `ui/Dropdown`: the themed replacement for `<select>`
- Add agent dropdown (dashboard)
- Terminal context menu (right-click)
- Global toolbar, terminal panel header menu, layout preset selector
- Panel view switch (`live` / `history`), in the terminal panel header
- Project tab bar (dashboard)
- Toggle, StatusBadge/StatusDot, Field (label/input/select/textarea), Button

## Panel history

A terminal panel has two views, switched from a segmented control in its own
header. `live` is the pty as it is: a full-screen CLI holds the alternate
screen, so that view does not scroll and is not meant to. `history` reads the
transcript Claude Code writes line by line and shows the conversation instead:
one row per turn, a timestamp column, a role column, and tool calls dimmed to
a single monospace line so they never read as an answer.

| Frame | What it holds |
|---|---|
| Dashboard · panel history | The board with one panel switched to `history`, the other three live |
| Panel history · states | Reading (skeleton in the real shape) and no transcript |

The `history` control is present on every panel, including the CLIs that write
no transcript. Pressing it there is what surfaces the reason: only the fifteen
providers that run on the `claude` binary keep the file, so Codex, Gemini,
Grok, OpenCode, Pi and Amp land on the empty state rather than a blank list.

## States every data surface must show

Loading (three stages: nothing under 400ms, skeleton, then a named slow
operation), empty, error, needs-sign-in, permission-denied.

## Motion

- Launch: mark, wordmark, boot steps, gateway handshake
- Page load: skeleton in the real shape of the content
