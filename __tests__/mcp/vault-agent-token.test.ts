import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { moveTestHome } from '../setup/test-home';

/**
 * mcp-vault presents the agent's own token when it has one.
 *
 * The transport is replaced and nothing else: the real client builds the
 * request, and these read where it would have gone and the headers it would
 * have sent. Nothing reaches a Tars, not even the one the suite may be running
 * inside.
 */

const sent: Array<{ hostname?: string; port?: number; headers: Record<string, string> }> = [];

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    request: vi.fn((options: { hostname?: string; port?: number; headers: Record<string, string> }, onResponse: (res: EventEmitter) => void) => {
      sent.push({ hostname: options.hostname, port: options.port, headers: options.headers });
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
      req.write = () => {};
      req.end = () => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        onResponse(res);
        res.emit('data', '{}');
        res.emit('end');
      };
      return req;
    }),
  };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vault-token-'));
let saved: Record<string, string | undefined>;
let restoreHome: () => void;

beforeEach(() => {
  sent.length = 0;
  saved = { CLAUDE_MGR_API_TOKEN: process.env.CLAUDE_MGR_API_TOKEN, CLAUDE_MGR_API_URL: process.env.CLAUDE_MGR_API_URL };
  // The shared file an agent without a token of its own falls back to.
  fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dorothy', 'api-token'), 'the-shared-token-from-the-file');
  restoreHome = moveTestHome(home);
});

afterEach(() => {
  restoreHome();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Loaded afresh each time: the client reads its environment when it loads. */
async function vaultClient() {
  vi.resetModules();
  return import('../../mcp-vault/src/utils/api');
}

describe('the vault client', () => {
  it("presents the agent's own token rather than the machine's shared one", async () => {
    process.env.CLAUDE_MGR_API_TOKEN = 'the-token-minted-for-this-agent';
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents');

    expect(sent).toHaveLength(1);
    expect(sent[0].headers.Authorization).toBe('Bearer the-token-minted-for-this-agent');
  });

  it('still presents the shared token for a session started before tokens existed', async () => {
    delete process.env.CLAUDE_MGR_API_TOKEN;
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents');

    expect(sent[0].headers.Authorization).toBe('Bearer the-shared-token-from-the-file');
  });
});

describe('which Tars the vault client calls', () => {
  // It called 127.0.0.1:31415 whatever the environment said, so the agents of a
  // sandbox or of the e2e suite sent their documents to the Tars on this
  // machine. mcp-orchestrator and mcp-memory read CLAUDE_MGR_API_URL.
  it('the one CLAUDE_MGR_API_URL names', async () => {
    process.env.CLAUDE_MGR_API_URL = 'http://127.0.0.1:31499';
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents');

    expect(sent[0]).toMatchObject({ hostname: '127.0.0.1', port: 31499 });
  });

  it('31415 on this machine when nothing names one', async () => {
    delete process.env.CLAUDE_MGR_API_URL;
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents');

    expect(sent[0]).toMatchObject({ hostname: '127.0.0.1', port: 31415 });
  });
});
