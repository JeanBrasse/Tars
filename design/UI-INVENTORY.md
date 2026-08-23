# Tars 1.5.0: surface inventory

Every surface the app can render today. The Pencil document `design/tars.pen`
must contain a frame for each line here; `npm run e2e:guard` checks the routed
ones are covered by the visual suite too.

Generated against the code, not from memory. Anything removed from the app
(ClaudeMon, Support, the 3D view, Obsidian, Automations, Scheduled Tasks,
custom dashboard boards, the sidebar collapse) is deliberately absent.

## Pages (14)

| Route | Name | Frame |
|---|---|---|
| `/` | Dashboard (terminal grid) | Dashboard · dark, Dashboard · light |
| `/chat` | Chat (Hermes overseer) | Chat · Overseer |
| `/agents` | Agents | Agents · dark |
| `/kanban` | Kanban | Kanban · dark |
| `/crons` | Schedules | Schedules · dark |
| `/review` | Review | Review · dark |
| `/logs` | Logs | Logs · dark |
| `/vault` | Vault | Vault · dark |
| `/projects` | Projects | Projects · dark |
| `/skills` | Extensions (Skills + Plugins) | Extensions · Skills, Extensions · Plugins |
| `/usage` | Usage | Usage · dark, Usage · light |
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

## Overlays and dialogs (14)

- New agent (`NewChatModal`): steps Project, Model, Tools, Task; persona editor;
  orchestrator toggle; skill install terminal
- Deploy team (`DeployTeamDialog`): member list, per-member provider/model/effort/branch
- Templates manager, Template form, Instantiate, Import
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
- Project tab bar (dashboard)
- Toggle, StatusBadge/StatusDot, Field (label/input/select/textarea), Button

## States every data surface must show

Loading (three stages: nothing under 400ms, skeleton, then a named slow
operation), empty, error, needs-sign-in, permission-denied.

## Motion

- Launch: mark, wordmark, boot steps, gateway handshake
- Page load: skeleton in the real shape of the content
