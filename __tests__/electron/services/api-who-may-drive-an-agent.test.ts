import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Who may start, stop, message, dispatch to, delete and create an agent.
 *
 * Measured on b17db0f, before this file existed: a call presenting
 * `~/.dorothy/api-token` and no `x-tars-client` header stopped, started,
 * dispatched to and DELETEd an agent of any project, and got a 200. The guard
 * refused only a caller that volunteered `x-tars-client: mcp`, a header the
 * caller writes about itself, and every agent can read that token file, so the
 * fleet was open to whoever read it. It could not simply be refused, because
 * the super chat authenticated with it too.
 *
 * So: the super chat holds Tars's own pass, minted in the main process's
 * memory and written nowhere; Hermes holds the webhook secret, which the door
 * now knows about; an agent holds the token Tars minted for its process; and
 * the shared token drives nothing.
 *
 * Both real callers are exercised through their own code here: `sendToAgent`
 * from the overseer module makes its real loopback request, and the webhook
 * route is reached over HTTP with the file `readWebhookSecret` writes. The
 * server, the routes and the token registry are the real ones.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-drive-'));
let port = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(picked));
    });
  });
}

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual,
    get API_PORT() { return port; },
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

let api: typeof import('../../../electron/services/api-server');
let agents: typeof import('../../../electron/core/agent-manager')['agents'];
let ptyProcesses: typeof import('../../../electron/core/pty-manager')['ptyProcesses'];
let tokens: typeof import('../../../electron/core/agent-tokens');
let overseer: typeof import('../../../electron/services/overseer');

const ALPHA = { id: 'agent-alpha', projectPath: '/projects/alpha' };
const BETA = { id: 'agent-beta', projectPath: '/projects/beta' };
const NO_IDENTITY =
  'Driving an agent takes an identity of your own, and this call has none: it presents the '
  + 'shared token, which every agent can read and which therefore names nobody. '
  + 'An agent is known by the token Tars gives its process when it starts it, not by a name: '
  + 'restart the agent from Tars.';

let sharedToken = '';
let alphaToken = '';

/** A terminal that records what was typed into it, the way a live claude is one. */
function liveTerminal(agent: AgentStatus): { written: string[] } {
  const written: string[] = [];
  agent.ptyId = `pty-${agent.id}`;
  agent.status = 'running';
  agent.ptyCwd = agent.projectPath;
  ptyProcesses.set(agent.ptyId, { write: (d: string) => { written.push(d); } } as never);
  return { written };
}

function putAgent(a: { id: string; projectPath: string }): AgentStatus {
  const agent = {
    ...a, name: a.id, status: 'idle', provider: 'claude', skills: [], output: [],
    lastActivity: new Date().toISOString(),
  } as AgentStatus;
  agents.set(a.id, agent);
  return agent;
}

function call(
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
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
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  port = await freePort();
  api = await import('../../../electron/services/api-server');
  ({ agents } = await import('../../../electron/core/agent-manager'));
  ({ ptyProcesses } = await import('../../../electron/core/pty-manager'));
  tokens = await import('../../../electron/core/agent-tokens');
  overseer = await import('../../../electron/services/overseer');
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
  ptyProcesses.clear();
  putAgent(ALPHA);
  putAgent(BETA);
  alphaToken = tokens.mintAgentToken(ALPHA.id);
  tokens.mintAgentToken(BETA.id);
});

describe('the super chat, which is Noah driving every project', () => {
  it('reaches an agent of any project, through its own code and its own request', async () => {
    const beta = agents.get(BETA.id)!;
    const terminal = liveTerminal(beta);

    const result = await overseer.sendToAgent(BETA.id, 'ship the thing');

    expect(result, JSON.stringify(result)).toEqual({ success: true, mode: 'message' });
    // Not "a 200 came back": the words Noah typed reached the terminal.
    expect(terminal.written.join('')).toContain('ship the thing');
  });

  it('is the only one that reaches it that way: the same request on the shared token is refused', async () => {
    // The negative witness for the test above. Were the guard reading anything
    // the caller says about itself, this would pass too and the one above
    // would prove nothing about the pass.
    const beta = agents.get(BETA.id)!;
    const terminal = liveTerminal(beta);

    const { status, body } = await call('POST', `/api/agents/${BETA.id}/dispatch`, bearer(sharedToken), { message: 'ship the thing' });

    expect(status, JSON.stringify(body)).toBe(403);
    expect(body.error).toBe(NO_IDENTITY);
    expect(terminal.written, 'the shared token typed into an agent of another project').toEqual([]);
  });

  it('cannot be impersonated by a header, which is the whole class of defect here', async () => {
    // What the old guard did wrong in the other direction: it read
    // x-tars-client, a claim the caller writes about itself. Tars's own pass
    // is a token or it is nothing, so every header that names it is just a
    // header. The shared token is what every agent already holds.
    const beta = agents.get(BETA.id)!;
    const terminal = liveTerminal(beta);
    const claims = [
      { 'x-tars-internal': '1' },
      { 'x-tars-internal': 'true' },
      { 'x-tars-client': 'tars' },
      { 'x-tars-client': 'overseer' },
      { 'x-tars-caller-id': 'tars' },
      { 'x-tars-caller-kind': 'internal' },
    ];

    for (const claim of claims) {
      const { status, body } = await call('POST', `/api/agents/${BETA.id}/dispatch`, {
        ...bearer(sharedToken), ...claim,
      }, { message: 'ship the thing' });

      expect(status, `${JSON.stringify(claim)} was believed: ${JSON.stringify(body)}`).toBe(403);
      expect(body.error).toBe(NO_IDENTITY);
    }
    expect(terminal.written, 'a header got a message into an agent').toEqual([]);
  });

  it('holds a pass that is in no file an agent can read', () => {
    // A file is what made the shared token shared. This walks everything the
    // app writes under its data directory and refuses to find the pass in any
    // of it; `~/.dorothy` is the directory every agent is handed.
    const pass = tokens.internalToken();
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (content.includes(pass)) found.push(path.relative(tmp, full));
      }
    };
    // The witness that the walk can see anything at all: the shared token is
    // in there, in api-token, and an empty walk would otherwise pass this test.
    fs.writeFileSync(path.join(tmp, 'api-token'), sharedToken);
    walk(tmp);
    const sharedFound: string[] = [];
    for (const entry of fs.readdirSync(tmp)) {
      const full = path.join(tmp, entry);
      if (fs.statSync(full).isFile() && fs.readFileSync(full, 'utf-8').includes(sharedToken)) sharedFound.push(entry);
    }

    expect(sharedFound, 'the walk found nothing at all, so finding no pass means nothing').toContain('api-token');
    expect(found).toEqual([]);
  });
});

describe('Hermes, the one caller published off this machine', () => {
  /** The file `readWebhookSecret()` provisions in ~/.dorothy, and hands to Hermes. */
  function provisionWebhookSecret(): string {
    const secret = 'f'.repeat(64);
    fs.writeFileSync(path.join(tmp, 'hermes-webhook-secret'), secret, { mode: 0o600 });
    return secret;
  }

  it('dispatches with the secret Settings hands it, which the door used to refuse', async () => {
    const secret = provisionWebhookSecret();
    const beta = agents.get(BETA.id)!;
    const terminal = liveTerminal(beta);

    const { status, body } = await call('POST', '/api/webhooks/hermes', bearer(secret), {
      agent_id: BETA.id, message: 'the cron fired',
    });

    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.mode).toBe('message');
    expect(terminal.written.join('')).toContain('the cron fired');
  });

  it('opens the webhook and nothing else', async () => {
    const secret = provisionWebhookSecret();

    const { status, body } = await call('POST', `/api/agents/${BETA.id}/dispatch`, bearer(secret), { message: 'go' });

    expect(status, JSON.stringify(body)).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('refuses a secret that is not the one on disk', async () => {
    provisionWebhookSecret();

    const { status, body } = await call('POST', '/api/webhooks/hermes', bearer('0'.repeat(64)), {
      agent_id: BETA.id, message: 'go', dry_run: true,
    });

    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('refuses an agent that aims its own token at the webhook', async () => {
    // The route's own check, which the door reaching it does not replace: this
    // is the one route that takes an agent id from the body without scoping.
    provisionWebhookSecret();

    const { status, body } = await call('POST', '/api/webhooks/hermes', bearer(alphaToken), {
      agent_id: BETA.id, message: 'go', dry_run: true,
    });

    expect(status, JSON.stringify(body)).toBe(401);
  });
});

describe('an agent keeps exactly the rights it had', () => {
  it('drives an agent of its own project', async () => {
    const other = putAgent({ id: 'agent-alpha-2', projectPath: ALPHA.projectPath });
    const terminal = liveTerminal(other);

    const { status, body } = await call('POST', `/api/agents/${other.id}/dispatch`, bearer(alphaToken), { message: 'your turn' });

    expect(status, JSON.stringify(body)).toBe(200);
    expect(terminal.written.join('')).toContain('your turn');
  });

  it('is still refused another project\'s, with the message it has always had', async () => {
    const { status, body } = await call('POST', `/api/agents/${BETA.id}/dispatch`, bearer(alphaToken), { message: 'go' });

    expect(status).toBe(403);
    expect(String(body.error)).toContain('Cross-project access denied');
  });

  it('still crosses deliberately with allowCrossProject', async () => {
    const beta = agents.get(BETA.id)!;
    const terminal = liveTerminal(beta);

    const { status, body } = await call('POST', `/api/agents/${BETA.id}/dispatch`, bearer(alphaToken), {
      message: 'go', allowCrossProject: true,
    });

    expect(status, JSON.stringify(body)).toBe(200);
    expect(terminal.written.join('')).toContain('go');
  });

  it('still creates an agent', async () => {
    const { status, body } = await call('POST', '/api/agents', bearer(alphaToken), { projectPath: ALPHA.projectPath, name: 'fresh' });

    expect(status, JSON.stringify(body)).toBe(200);
    expect((body.agent as { name: string }).name).toBe('fresh');
  });
});
