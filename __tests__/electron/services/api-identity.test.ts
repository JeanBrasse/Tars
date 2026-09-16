import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Who an agent is on the local API: the agent its token was minted for, and
 * nothing it writes.
 *
 * Every agent used to authenticate with ~/.dorothy/api-token, one secret for
 * the whole machine that every agent can read, and name itself in
 * X-Tars-Caller-Id. The server believed the name. So an agent could put a
 * colleague's id in that header and read the colleague's project room, or
 * post in it, under the colleague's name. An agent now calls with a token
 * minted for its own process, and a call on the shared token is nobody,
 * whatever headers come with it.
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

import type { AgentStatus, BusMessage } from '../../../electron/types';

// Imported once the constants above exist: the mock factory reads them, and a
// static import would run it first. Held from here on, so that the modules the
// MCP client tests reload later cannot hand the suite a second agent registry.
let api: typeof import('../../../electron/services/api-server');
let agents: typeof import('../../../electron/core/agent-manager')['agents'];
let mintAgentToken: typeof import('../../../electron/core/agent-tokens')['mintAgentToken'];
let busStore: typeof import('../../../electron/services/bus-store');

const ALPHA = { id: 'agent-alpha', projectPath: '/projects/alpha' };
const BETA = { id: 'agent-beta', projectPath: '/projects/beta' };
const ALPHA_ROOM = 'project:/projects/alpha';
const BETA_ROOM = 'project:/projects/beta';
const USURPATION = 'This call carries the token of one agent and the identity of another. '
  + 'An agent speaks as itself.';
const REMEDY = 'An agent is known by the token Tars gives its process when it starts it, not by a name: '
  + 'restart the agent from Tars.';
/** callingAgent's refusal, which comes before any room is looked at. */
const NO_AGENT = `This call has no agent identity, so it cannot be placed in a room. ${REMEDY}`;
/** The cross-project guard's refusal of an MCP client it cannot scope. */
const NO_SCOPE = `This agent has no identity, so its calls cannot be scoped to a project. ${REMEDY}`;
/** A line of Noah's conversation with the super chat, which is what the global room serves. */
const SUPER_CHAT_LINE = 'noah-private-line-7f3a';

let alphaToken: string;
let sharedToken: string;

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

function call(
  method: 'GET' | 'POST',
  pathname: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: payload ? { ...headers, 'content-type': 'application/json' } : headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (pathname: string, headers: Record<string, string>) => call('GET', pathname, headers);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  api = await import('../../../electron/services/api-server');
  ({ agents } = await import('../../../electron/core/agent-manager'));
  ({ mintAgentToken } = await import('../../../electron/core/agent-tokens'));
  busStore = await import('../../../electron/services/bus-store');
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
  // What bus-handlers wires in the app: the global room reads the super chat.
  busStore.setGlobalHistoryReader(() => [{
    id: 'overseer-1',
    roomId: busStore.GLOBAL_ROOM_ID,
    threadId: busStore.GLOBAL_ROOM_ID,
    authorKind: 'human',
    authorId: 'human',
    authorName: 'Noah',
    text: SUPER_CHAT_LINE,
    mentions: [],
    createdAt: new Date().toISOString(),
  } as BusMessage]);
});

afterAll(() => {
  busStore.setGlobalHistoryReader(undefined);
  api.stopApiServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  agents.clear();
  putAgent(ALPHA);
  putAgent(BETA);
  alphaToken = mintAgentToken(ALPHA.id);
  mintAgentToken(BETA.id);
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

describe('an agent that holds its own token and names another', () => {
  it('is refused, even for the room it would be let into as that agent', async () => {
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
  });

  it('is refused on the agent routes too, since the check is at the door and not in the bus', async () => {
    const { status, body } = await get('/api/agents', { ...bearer(alphaToken), 'x-tars-caller-id': BETA.id });

    expect(status).toBe(403);
    expect(body.error).toBe(USURPATION);
  });
});

describe('a call on the shared token', () => {
  // Every agent can read ~/.dorothy/api-token. So whatever comes with it is
  // what any agent could have written, and none of it can make the call an
  // agent. Each test here is the header being believed again, played out.

  it("is nobody, whatever agent it names: it cannot read that agent's room", async () => {
    // Beta's id and beta's project, and no room asked for, so the call would
    // land in the caller's own room. Believed, that is beta's room with a 200,
    // and no other check stands in the way: this dies on the status alone.
    const { status, body } = await get('/api/bus/read', {
      ...bearer(sharedToken), 'x-tars-caller-id': BETA.id, 'x-tars-caller-project': BETA.projectPath,
    });

    expect(status, JSON.stringify(body)).toBe(403);
    expect(body.error).toBe(NO_AGENT);
    expect(body.room, "beta's room came back to a caller that only named beta").toBeUndefined();
  });

  it("cannot post in that agent's room under its name", async () => {
    const { status, body } = await call('POST', '/api/bus/post', {
      ...bearer(sharedToken), 'x-tars-caller-id': BETA.id,
    }, { text: 'written by someone who is not beta' });

    expect(status, JSON.stringify(body)).toBe(403);
    expect(body.error).toBe(NO_AGENT);
    expect(busStore.getRoomSnapshot(BETA_ROOM)?.messages ?? []).toEqual([]);
  });

  it('opens no global room even with no header at all, and hands back none of the super chat', async () => {
    // Positive witness first: the room this asks for does serve the super chat,
    // so a body without its line below is a refusal and not an empty room.
    expect(JSON.stringify(busStore.getRoomSnapshot(busStore.GLOBAL_ROOM_ID))).toContain(SUPER_CHAT_LINE);

    const { status, body } = await get('/api/bus/read?room=global', bearer(sharedToken));

    expect(status).toBe(403);
    // Refused for having no agent, before any room is looked at. Were a call
    // with no agent behind it treated as the interface, it would get further:
    // to resolveRoom's refusal of agents, a different message, or, with that
    // gone too, to Noah's conversation.
    expect(body.error).toBe(NO_AGENT);
    expect(JSON.stringify(body)).not.toContain(SUPER_CHAT_LINE);
  });

  it('is not scoped by the project it names, so an MCP client on it cannot act on that project', async () => {
    // What an agent's MCP server sends when its process has no token of its
    // own. Believed, the project header scopes the call to beta's project and
    // the guard lets it stop beta.
    const { status, body } = await call('POST', `/api/agents/${BETA.id}/stop`, {
      ...bearer(sharedToken),
      'x-tars-client': 'mcp',
      'x-tars-caller-id': BETA.id,
      'x-tars-caller-project': BETA.projectPath,
    }, {});

    expect(status, JSON.stringify(body)).toBe(403);
    expect(body.error).toBe(NO_SCOPE);
  });

  it('is still let in: having no agent behind it is not a refusal at the door', async () => {
    // The super chat, the shell hooks and Hermes authenticate this way.
    const { status } = await get('/api/agents', bearer(sharedToken));

    expect(status).toBe(200);
  });

  it('is refused with a token nobody minted', async () => {
    const { status, body } = await get('/api/agents', { ...bearer('0'.repeat(64)), 'x-tars-caller-id': ALPHA.id });

    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });
});

describe('an agent on its own token and the global room', () => {
  it('is refused too, by the rule that keeps agents out of it', async () => {
    const { status, body } = await get('/api/bus/read?room=global', bearer(alphaToken));

    expect(status).toBe(403);
    expect(body.error).toBe('The global room is the super chat, and is not open to agents.');
    expect(JSON.stringify(body)).not.toContain(SUPER_CHAT_LINE);
  });
});

describe('the MCP servers that call the API', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'agent-home-'));
  let saved: Record<string, string | undefined>;
  const KEYS = ['HOME', 'CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN', 'CLAUDE_AGENT_ID', 'CLAUDE_PROJECT_PATH'];

  /**
   * An agent's environment, as spawnAgentPty leaves it, and nothing else of
   * the environment the suite runs in: a suite run by an agent carries that
   * agent's own CLAUDE_MGR_API_TOKEN. HOME defaults to a directory with no
   * api-token in it, so a client that ignored its own token and fell back to
   * the file would have nothing to present, rather than presenting the real
   * one of whoever runs the suite.
   */
  function asAgent(env: Record<string, string>): void {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
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
  });

  it('orchestrator: an agent that renames itself in its own environment is refused', async () => {
    // All it takes: CLAUDE_AGENT_ID=agent-beta in front of the command.
    asAgent({ CLAUDE_MGR_API_TOKEN: alphaToken, CLAUDE_AGENT_ID: BETA.id, CLAUDE_PROJECT_PATH: BETA.projectPath });
    const { apiRequest } = await orchestratorClient();

    await expect(apiRequest(`/api/bus/read?room=${encodeURIComponent(BETA_ROOM)}`)).rejects.toThrow(USURPATION);
  });

  it('orchestrator: with no token of its own, the shared file and a colleague\'s name make it nobody', async () => {
    // The other way to be beta: drop the token, and let the client fall back to
    // the file every agent can read, with beta's id in the environment.
    const sharedHome = fs.mkdtempSync(path.join(tmp, 'shared-home-'));
    fs.mkdirSync(path.join(sharedHome, '.dorothy'));
    fs.writeFileSync(path.join(sharedHome, '.dorothy', 'api-token'), sharedToken);
    asAgent({ HOME: sharedHome, CLAUDE_AGENT_ID: BETA.id, CLAUDE_PROJECT_PATH: BETA.projectPath });
    const { apiRequest } = await orchestratorClient();

    await expect(apiRequest('/api/bus/read')).rejects.toThrow(NO_AGENT);
  });

  it('memory: presents the agent\'s own token', async () => {
    asAgent({ CLAUDE_MGR_API_TOKEN: alphaToken, CLAUDE_AGENT_ID: ALPHA.id, CLAUDE_PROJECT_PATH: BETA.projectPath });
    vi.resetModules();
    const { apiRequest } = await import('../../../mcp-memory/src/utils/api');

    const data = await apiRequest('/api/agents') as { scopedToProject: string };

    // Scoped by the token's agent, not by the project its environment names.
    // A client that fell back to the file would find none in HOME and get a 401.
    expect(data.scopedToProject).toBe(ALPHA.projectPath);
  });
});
