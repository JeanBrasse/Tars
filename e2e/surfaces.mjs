// Manifeste exécutable des surfaces de l'app — la contrepartie vivante de
// design/UI-INVENTORY.md. Chaque entrée est ouverte dans la VRAIE app Electron
// par e2e/surfaces.spec.ts, photographiée, et comparée à sa référence.
// `check-coverage.mjs` échoue si une page de l'inventaire manque ici.

/**
 * @typedef {Object} Surface
 * @property {string} name    identifiant stable (nom du screenshot)
 * @property {string} route   route Next à charger
 * @property {string=} clickText   texte d'un bouton à cliquer après chargement (ouvre un overlay)
 * @property {string=} clickText2  second clic (navigation dans l'overlay)
 * @property {number=} settle      ms d'attente avant screenshot (défaut 900)
 * @property {string=} within      nom d'un panneau : clickText est cherché dans son en-tête
 * @property {string=} shows       texte que la vue doit afficher avant la capture
 */

/** @type {Surface[]} */
export const PAGES = [
  { name: 'dashboard', route: '/' },
  // The fleet rail shows statuses that settle from running to idle in the first
  // seconds after launch, and chat is the second surface visited. Waiting is
  // better than masking the rail: a masked panel is a pink rectangle in the
  // baseline and no coverage at all.
  { name: 'chat', route: '/chat', settle: 3000 },
  { name: 'agents', route: '/agents' },
  { name: 'kanban', route: '/kanban' },
  { name: 'vault', route: '/vault' },
  { name: 'projects', route: '/projects' },
  { name: 'extensions-skills', route: '/skills' },
  { name: 'extensions-plugins', route: '/skills', clickText: 'Plugins', settle: 1500 },
  { name: 'crons', route: '/crons' },
  { name: 'review', route: '/review' },
  { name: 'logs', route: '/logs', settle: 3000 },
  { name: 'usage', route: '/usage' },
  { name: 'brain-agents', route: '/memory' },
  { name: 'brain-projects', route: '/memory', clickText: 'Projects' },
  { name: 'brain-backends', route: '/memory', clickText: 'Backends' },
  { name: 'whats-new', route: '/whats-new' },
  { name: 'settings-general', route: '/settings' },
  // The menu-bar popover, listed in the inventory since the redesign and
  // automated by nobody: the guard read its route list from a hand-written
  // copy, so this one sat outside every check. It carries a terminal, which
  // the sweep masks like any other.
  { name: 'tray-panel', route: '/tray-panel', settle: 2000 },
];

// Les 16 sections de Settings. Depuis le regroupement, chaque section est un
// groupe cliqué puis son enfant : le nom de surface reste celui d'avant pour
// que les baselines et l'inventaire ne bougent pas.
const SETTINGS_TREE = [
  ['terminal', 'General', 'Terminal'],
  ['ai-providers', 'AI & Providers', 'Providers'],
  ['cli-paths', 'AI & Providers', 'CLI Paths'],
  ['permissions', 'AI & Providers', 'Permissions'],
  ['hermes', 'Hermes', 'Connection'],
  ['notifications', 'General', 'Notifications'],
  ['system', 'General', 'System'],
  ['telegram', 'Integrations', 'Telegram'],
  ['slack', 'Integrations', 'Slack'],
  ['x-twitter', 'Integrations', 'X (Twitter)'],
  ['google-workspace', 'Integrations', 'Google Workspace'],
  ['skills-plugins', 'Extensions', 'Skills & Plugins'],
  ['custom-mcp', 'Extensions', 'Custom MCP'],
  ['tasmania', 'Extensions', 'Tasmania'],
  ['git', 'Workspace', 'Git'],
  ['memory-backends', 'Workspace', 'Memory Backends'],
];

export const SETTINGS_SECTIONS = SETTINGS_TREE.map(([name, group, child]) => ({
  name: 'settings-' + name,
  route: '/settings',
  clickText: group,
  clickText2: child,
}));

// Overlays dont le déclencheur est connu et stable. Les autres entrées de
// l'inventaire sont ajoutées ici au fur et à mesure que le redesign les touche
// (check-coverage.mjs liste celles qui restent non automatisées).
//
// `overlay-new-agent` and `overlay-new-team` are the same `NewChatModal`,
// opened on either half of its "One agent | A team" switch - `+ Team` used to
// open the separate `DeployTeamDialog`, now folded into this component.
// `overlay-templates-manager` is back: the one-screen redesign dropped the
// template-chip row it used to open from, which left the manager unreachable
// rather than deleted. It has its own button on the Agents page now, so the
// surface is automated again.
export const OVERLAYS = [
  { name: 'overlay-templates-manager', route: '/agents', clickText: 'Templates' },
  { name: 'overlay-new-agent', route: '/agents', clickText: '+ Agent' },
  { name: 'overlay-new-team', route: '/agents', clickText: '+ Team' },
];

export const ALL = [...PAGES, ...SETTINGS_SECTIONS, ...OVERLAYS];

// Panel history: two states of a Dashboard panel, reached through that panel's
// own live | history switch. The inventory's "Dashboard · panel history" and
// the no-transcript half of "Panel history · states". The skeleton half is a
// state that lasts as long as one small IPC read, so it is not photographed.
//
// Deliberately not in ALL. e2e/panel-history.spec.ts drives them in a sandbox
// of its own: the sweep above leaves auto start on, so every agent on the
// board is a real CLI, and what a claude panel's history shows would depend on
// how fast that CLI registers its session. There nothing starts, the
// Orchestrator reads a transcript seeded on disk, and the Backend Engineer
// runs codex, which writes none.
// The Chat room, the six frames `design/chat-design.pen` specifies as states
// of the page rather than as overlays. One room per state, because a room is
// derived from a project and a journal can only put a given one in a single
// state at a time.
//
// Deliberately not in ALL, for the reason PANEL_HISTORY is not: they need a
// sandbox whose agents do not start, whose projects are five rather than two,
// and whose bus journal is seeded. e2e/chat-rooms.spec.ts drives them.
//
// `delivered`, `dropped`, `bounded` and `superseded` are rendered here for the
// first time. Every one of them was code that had never been on a screen.
export const CHAT_ROOMS = [
  {
    name: 'chat-hermes-with-rooms', route: '/chat',
    shows: 'All projects',
  },
  {
    name: 'chat-room-agents-at-work', route: '/chat', clickText: 'tars',
    shows: 'Then I hold the write until the fit resolves, and add the test that caught it.',
  },
  {
    name: 'chat-room-you-step-in', route: '/chat', clickText: 'orion',
    shows: 'Stop there, both of you. Cache the parts, and measure it before you tune it.',
  },
  {
    name: 'chat-room-limit-reached', route: '/chat', clickText: '1212-capital',
    shows: 'Nobody was stopped: every agent finished its turn and is waiting for you.',
  },
  {
    // The room says this in the composer's placeholder rather than in the log,
    // which is the point of the frame: the room is readable and the box tells
    // you why nothing will move.
    name: 'chat-room-all-stopped', route: '/chat', clickText: 'atlas',
    placeholder: 'Every agent here is stopped. What you write waits until you start one.',
    shows: 'Three paragraphs assume the reader already has an account. I have marked them.',
  },
  {
    name: 'chat-room-no-agents', route: '/chat', clickText: 'mercury',
    shows: 'Nobody in this room yet',
  },
];

export const PANEL_HISTORY = [
  {
    name: 'dashboard-panel-history', route: '/', clickText: 'history', within: 'Orchestrator',
    shows: 'Ship it, with the test that caught it.',
  },
  {
    name: 'panel-history-no-transcript', route: '/', clickText: 'history', within: 'Backend Engineer',
    shows: 'Codex CLI does not write a transcript Tars can read.',
  },
];
