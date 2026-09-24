# Tars 1.5.0: surface inventory

Every surface the app can render today. A frame must exist for each line here;
`npm run e2e:guard` checks the routed ones are covered by the visual suite too.

The frames live in two Pencil documents, and the second is a fork of the first
rather than a companion to it. `design/tars-redesign.pen` holds 93 root frames.
`design/chat-design.pen` holds 75 of those, the other fourteen being newer than the
fork, plus the eleven frames of the Chat
room listed on the `/chat` line below: 86 in all. The first 74 share their ids
and names across the two. The 75th, `Agent error · reason`, was drawn after the
fork by one script run against both documents, so it has the same name and the
same content in each but different ids. The room frames were drawn in the fork
and exist nowhere else, so until the two are reconciled, `chat-design.pen` is
the newer of the two and the only place the Chat room is specified.

Reconciling them means one document again, and it is deliberately not done here:
a headless Pen session and the Pen desktop app writing the same `.pen` end with
the last save erasing the other, so it waits for a moment when Pen is closed.
Until then, draw a Chat room frame in `chat-design.pen` and anything else in
`tars-redesign.pen`.

A third document, `design/chat-redesign-a.pen`, holds the Chat page's redesign:
direction A, which Noah chose on 2026-09-17 (the thread first, the team folded
into the left column), with its composer, modeled on Claude's and ChatGPT's. It
is what the next Chat TSX implements: the room and Hermes pages, dark and light,
and every state of the composer. Until that lands, `chat-design.pen` still
describes the Chat as it ships. Draw anything for the redesign in
`chat-redesign-a.pen`.

Generated against the code, not from memory. Anything removed from the app
(ClaudeMon, Support, the 3D view, Obsidian, Automations, Scheduled Tasks,
custom dashboard boards, the sidebar collapse) is deliberately absent.

## Pages (14)

| Route | Name | Frame |
|---|---|---|
| `/` | Dashboard (terminal grid) | Dashboard · dark, Dashboard · light, Dashboard · panel history, Panel history · states, Agent error · reason, Message waiting · notice |
| `/chat` | Chat (Hermes overseer + one room per project) | Chat · Overseer (`tars-redesign.pen`). The room, all eleven in `chat-design.pen`: Chat · Hermes · with rooms, Chat · Room · agents at work, Chat · Room · you step in, Chat · Room · limit reached, Chat · Room · all stopped, Chat · Room · no agents, Chat · Room · add an agent, Chat · Room · stop an agent, Chat · Room · edit an agent, Chat · Room · the rows a room is made of, Chat · Room · at rest or stopped. The redesign, in `chat-redesign-a.pen`: Chat · A · Room · agents at work, Chat · A · Hermes (each with its `· light`), Chat · A · Composer · states (with its `· light`), A · notes |
| `/agents` | Agents | Agents · dark (every project, grouped), Agents · one project, Agents · project picker open, Agent error · reason |
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

## Overlays and dialogs (14)

- New agent / New team (`NewChatModal`): one screen, a "One agent | A team"
  switch in the header. One agent: project, provider tiles + model, task
  textarea, one collapsed Options row (skills, effort, permissions, worktree,
  orchestrator, CLI binary). A team: project + start-from-preset, a member
  table (role/provider/model/effort/branch), a shared brief, the same
  Options pattern. Replaces the old four-step wizard and `DeployTeamDialog`.
  The Orchestrator row is the role: what it gives, one per project, and in
  the edit dialog that saving restarts the agent once it is free.
  Frames: Overlay · New agent (one screen), Overlay · New team (one screen),
  Overlay · New agent · Options open, Overlay · Edit agent · Orchestrator
  (and its light copy), Orchestrator role · states
- Replace the orchestrator of <project>?: asked before a save would give the
  role to an agent while another agent of the same project holds it (the
  toggle, a new agent, a move to another project, a team with an orchestrator
  member). It names the agent that loses the role; Cancel goes back to the
  dialog. Frames: Overlay · Replace the orchestrator (and its light copy),
  Orchestrator role · states
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
| Message waiting · notice | The line a panel shows while a message waits for a field somebody is typing in, with the two ways out |
| Panel history · states | Reading (skeleton in the real shape) and no transcript |
| Left fullscreen · notice | The line a panel shows when its claude left fullscreen and the wheel can no longer scroll it, with read history and restart (and its light copy) |
| Restart pending · notice | The line a panel shows while a changed setting waits to restart its agent: which settings, and what the restart waits on (and its light copy) |

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
