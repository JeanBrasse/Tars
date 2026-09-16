import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Who an agent is on the local API: what its token says, not what it writes.
 *
 * Every agent used to authenticate with ~/.dorothy/api-token, one secret for
 * the whole machine, and name itself in X-Tars-Caller-Id. The server believed
 * the name. So an agent could put a colleague's id in that header and read the
 * colleague's project room, or post in it, under the colleague's name.
 *
 * These boot the real server on a port of their own and speak HTTP to it: the
 * real authentication block, the real bus and agent routes, tokens from the
 * real registry, and at the end the real MCP clients. Nothing is called
 * directly that a request would not reach the same way.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-identity-'));
/** Far from 31415, the sandbox's 31499, the e2e's 31498 and the port-retry suite's 31961. */
const PORT = 31967;

// Everything the server could write goes to the temp dir. saveBus() in
// particular writes on every call, and unredirected it would write over the
// real ~/.dorothy/bus.json.
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual,
    API_PORT: PORT,
    DATA_DIR: tmp,
    dataPath: (...segments: string[]) => path.join(tmp, ...segments),
    AGENTS_FILE: path.join(tmp, 'agents.json'),
    APP_SETTINGS_FILE: path.join(tmp, 'app-settings.json'),
    KANBAN_FILE: path.join(tmp, 'kanban-tasks.json'),
    TELEGRAM_DOWNLOADS_DIR: path.join(tmp, 'telegram-downloads'),
    VAULT_DIR: path.join(tmp, 'vault'),
    VAULT_DB_FILE: path.join(tmp, 'vault.db'),
    API_TOKEN_FILE: path.join(tmp, 'api-token'),
    BUS_FILE: path.join(tmp, 'bus.json'),
  };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import type { AgentStatus } from '../../../electron/types';

// Imported once the constants above exist: the mock factory reads them, and a
// static import would run it first. Held from here on, so that the modules the
// MCP client tests reload later cannot hand the suite a second agent registry.
let api: typeof import('../../../electron/services/api-server');
let agents: typeof import('../../../electron/core/agent-manager')['agents'];
let mintAgentToken: typeof import('../../../electron/core/agent-tokens')['mintAgentToken'];

const ALPHA = { id: 'agent-alpha', projectPath: '/projects/alpha' };
const BETA = { id: 'agent-beta', projectPath: '/projects/beta' };
/** Started before tokens existed: in the fleet, and holding none. */
const GAMMA = { id: 'agent-gamma', projectPath: '/projects/gamma' };
const ALPHA_ROOM = 'project:/projects/alpha';
const BETA_ROOM = 'project:/projects/beta';
const USURPATION = 'This call carries the token of one agent and the identity of another. '
  + 'An agent speaks as itself.';

let alphaToken: string;
let sharedToken: string;
let warnings: string[];

function putAgent(a: { id: string; projectPath: string }): void {
  agents.set(a.id, {
    ...a,
    name: a.id,
    status: 'idle',
    provider: 'claude',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
  } as AgentStatus);
}

function get(pathname: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    req.end();
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const identityLines = () => warnings.filter(w => w.startsWith('[identity]'));

beforeAll(async () => {
  api = await import('../../../electron/services/api-server');
  ({ agents } = await import('../../../electron/core/agent-manager'));
  ({ mintAgentToken } = await import('../../../electron/core/agent-tokens'));
  api.startApiServer(
    null, { notificationsEnabled: false } as never, () => null, () => null, null, null,
    () => {}, () => {}, async () => 'pty', () => ({ notificationsEnabled: false } as never),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never listened: ${api.getApiServerState().phase}`)), 5000);
    const check = () => {
      if (api.getApiServerState().phase !== 'listening') return;
      clearTimeout(timer);
      api.apiServerEmitter.off('state', check);
      resolve();
    };
    api.apiServerEmitter.on('state', check);
    check();
  });
  sharedToken = api.getApiToken();
});

afterAll(() => {
  api.stopApiServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  agents.clear();
  putAgent(ALPHA);
  putAgent(BETA);
  putAgent(GAMMA);
  alphaToken = mintAgentToken(ALPHA.id);
  mintAgentToken(BETA.id);
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an agent that holds its own token', () => {
  it('is known by the token alone, with no name given', async () => {
    // No X-Tars-Caller-Id at all: if the token were not read as an identity,
    // this call would have no agent to place and would be refused.
    const { status, body } = await get('/api/bus/read', bearer(alphaToken));

    expect(status, JSON.stringify(body)).toBe(200);
    expect((body.room as { id: string }).id).toBe(ALPHA_ROOM);
  });

  it('still opens its own project room', async () => {
    const { status, body } = await get(`/api/bus/read?room=${encodeURIComponent(ALPHA_ROOM)}`, {
      ...bearer(alphaToken), 'x-tars-caller-id': ALPHA.id,
    });

    expect(status, JSON.stringify(body)).toBe(200);
    expect((body.room as { id: string }).id).toBe(ALPHA_ROOM);
  });

  it("is still kept out of another project's room", async () => {
    const { status, body } = await get(`/api/bus/read?room=${encodeURIComponent(BETA_ROOM)}`, {
      ...bearer(alphaToken), 'x-tars-caller-id': ALPHA.id,
    });

    expect(status).toBe(403);
    // The cross-project refusal by name: an identity that stopped resolving
    // would be refused too, for a different reason, and must not pass for this.
    expect(body.error).toBe(`That room belongs to ${BETA.projectPath}, and you are an agent of ${ALPHA.projectPath}.`);
  });

  it('is scoped to its own project on the agent listing, whatever project it names', async () => {
    const { status, body } = await get('/api/agents', {
      ...bearer(alphaToken), 'x-tars-caller-project': BETA.projectPath,
    });

    expect(status).toBe(200);
    expect(body.scopedToProject).toBe(ALPHA.projectPath);
    expect((body.agents as Array<{ id: string }>).map(a => a.id)).toEqual([ALPHA.id]);
  });
});

describe("an agent that holds its own token and names another", () => {
  it("is refused, even for the room it would be let into as that agent", async () => {
    // The attack in full: alpha's token, beta's name, beta's room. As beta the
    // room would open. As alpha it is another project's room, so the
    // cross-project check would refuse it with a 403 of its own, which is why
    // this asserts the message and not only the status.
    const { status, body } = await get(`/api/bus/read?room=${encodeURIComponent(BETA_ROOM)}`, {
      ...bearer(alphaToken), 'x-tars-caller-id': BETA.id,
    });

    expect(status).toBe(403);
    expect(body.error).toBe(USURPATION);
    expect(body.room, 'beta\'s room came back to alpha').toBeUndefined();
    expect(identityLines().join('\n')).toContain(`token belongs to agent ${ALPHA.id}, X-Tars-Caller-Id claimed ${BETA.id}`);
  });

  it('is refused on the agent routes too, since the check is at the door and not in the bus', async () => {
    const { status, body } = await get('/api/agents', { ...bearer(alphaToken), 'x-tars-caller-id': BETA.id });

    expect(status).toBe(403);
    expect(body.error).toBe(USURPATION);
  });
});

describe('a caller still on the shared token', () => {
  it('is believed on its header for now, and every such call is written down', async () => {
    // The transition: an agent started before it could be given a token.
    // Kept working so nothing breaks on the day this ships, and logged so the
    // day nobody is left on this path can be read rather than guessed.
    const { status, body } = await get('/api/bus/read', { ...bearer(sharedToken), 'x-tars-caller-id': GAMMA.id });

    expect(status, JSON.stringify(body)).toBe(200);
    expect((body.room as { id: string }).id).toBe(`project:${GAMMA.projectPath}`);
    expect(identityLines()).toEqual([
      `[identity] /api/bus/read: agent ${GAMMA.id} still identifies itself with the shared token. `
      + 'Restart it from Tars to give it one of its own.',
    ]);
  });

  it('is written down differently when it names an agent that holds a token of its own', async () => {
    // Still believed: the fallback is the transition, and refusing here would
    // break an agent whose MCP bundle is older than its token. But this is the
    // line that can be somebody else, so it does not read like the harmless one.
    const { status } = await get('/api/bus/read', { ...bearer(sharedToken), 'x-tars-caller-id': ALPHA.id });

    expect(status).toBe(200);
    expect(identityLines()).toEqual([
      `[identity] /api/bus/read: a call on the shared token claimed agent ${ALPHA.id}, which holds a token `
      + `of its own. Either its MCP server predates per-agent tokens, or this call is not from ${ALPHA.id}.`,
    ]);
  });

  it('writes nothing down when it names no agent, which is the interface', async () => {
    const { status } = await get('/api/agents', bearer(sharedToken));

    expect(status).toBe(200);
    expect(identityLines()).toEqual([]);
  });

  it('is refused with a token nobody minted', async () => {
    const { status, body } = await get('/api/agents', { ...bearer('0'.repeat(64)), 'x-tars-caller-id': ALPHA.id });

    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });
});

describe('the transition journal', () => {
  const journal = path.join(tmp, 'identity-transition.log');

  /**
   * The journal's lines containing this text, once at least one has landed:
   * the append is not awaited by the request. The file and the record of what
   * was already written outlive each test, so every test names an agent of its
   * own and nothing here can be satisfied by an earlier test's line.
   */
  async function journalLines(containing: string): Promise<string[]> {
    const read = () => (fs.existsSync(journal) ? fs.readFileSync(journal, 'utf-8').split('\n') : [])
      .filter(l => l.includes(containing));
    for (let i = 0; i < 50 && read().length === 0; i++) await new Promise(r => setTimeout(r, 20));
    return read();
  }

  it('is a file, because an app started from the Dock prints its console nowhere', async () => {
    putAgent({ id: 'agent-journal-file', projectPath: '/projects/journal' });

    await get('/api/agents', { ...bearer(sharedToken), 'x-tars-caller-id': 'agent-journal-file' });

    const lines = await journalLines('/api/agents: agent agent-journal-file still identifies itself');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[identity\] \/api\/agents: agent agent-journal-file /);
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
  });

  it('keeps an attempt to be another agent, which is the line that matters most', async () => {
    await get('/api/agents', { ...bearer(alphaToken), 'x-tars-caller-id': 'agent-journal-victim' });

    expect(await journalLines(`token belongs to agent ${ALPHA.id}, X-Tars-Caller-Id claimed agent-journal-victim`))
      .toHaveLength(1);
  });

  it('writes one line per agent and route, however often the call repeats', async () => {
    // A stale bundle polling /wait every few seconds would otherwise grow the
    // file without bound. The console still gets every call.
    putAgent({ id: 'agent-journal-repeat', projectPath: '/projects/journal' });
    for (let i = 0; i < 5; i++) {
      await get('/api/bus/read', { ...bearer(sharedToken), 'x-tars-caller-id': 'agent-journal-repeat' });
    }
    const needle = '/api/bus/read: agent agent-journal-repeat';
    await journalLines(needle);
    // Room for any duplicate append to land before counting.
    await new Promise(r => setTimeout(r, 150));

    expect(await journalLines(needle)).toHaveLength(1);
    expect(identityLines().filter(l => l.includes(needle))).toHaveLength(5);
  });
});

describe('the MCP servers that call the API', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'agent-home-'));
  let saved: Record<string, string | undefined>;
  const KEYS = ['HOME', 'CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN', 'CLAUDE_AGENT_ID', 'CLAUDE_PROJECT_PATH'];

  /**
   * An agent's environment, as spawnAgentPty leaves it. HOME is a directory
   * with no api-token in it: a client that ignored its own token and fell
   * back to the file would have nothing to present, rather than presenting
   * the real one of whoever runs the suite.
   */
  function asAgent(env: Record<string, string>): void {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    Object.assign(process.env, { HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${PORT}`, ...env });
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** The client reads its environment when it loads, so each identity loads it afresh. */
  async function orchestratorClient() {
    vi.resetModules();
    return import('../../../mcp-orchestrator/src/utils/api');
  }

  it('orchestrator: presents the agent\'s own token, and lands in its own room', async () => {
    asAgent({ CLAUDE_MGR_API_TOKEN: alphaToken, CLAUDE_AGENT_ID: ALPHA.id, CLAUDE_PROJECT_PATH: ALPHA.projectPath });
    const { apiRequest } = await orchestratorClient();

    const data = await apiRequest('/api/bus/read') as { room: { id: string } };

    expect(data.room.id).toBe(ALPHA_ROOM);
    expect(identityLines(), 'the client fell back to the shared token').toEqual([]);
  });

  it('orchestrator: an agent that renames itself in its own environment is refused', async () => {
    // All it takes: CLAUDE_AGENT_ID=agent-beta in front of the command.
    asAgent({ CLAUDE_MGR_API_TOKEN: alphaToken, CLAUDE_AGENT_ID: BETA.id, CLAUDE_PROJECT_PATH: BETA.projectPath });
    const { apiRequest } = await orchestratorClient();

    await expect(apiRequest(`/api/bus/read?room=${encodeURIComponent(BETA_ROOM)}`)).rejects.toThrow(USURPATION);
  });

  it('memory: presents the agent\'s own token', async () => {
    asAgent({ CLAUDE_MGR_API_TOKEN: alphaToken, CLAUDE_AGENT_ID: ALPHA.id, CLAUDE_PROJECT_PATH: BETA.projectPath });
    vi.resetModules();
    const { apiRequest } = await import('../../../mcp-memory/src/utils/api');

    const data = await apiRequest('/api/agents') as { scopedToProject: string };

    // Scoped by the token's agent, not by the project its environment names.
    expect(data.scopedToProject).toBe(ALPHA.projectPath);
    expect(identityLines()).toEqual([]);
  });
});
