import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A task delegated over ACP runs on the agent's model and effort.
 *
 * A terminal launch puts them on the command line. This path has none, and
 * set neither, so every delegation ran on the adapter's defaults whatever the
 * agent was set to. ACP configures a session once it is open, through the
 * options the agent offers: claude-agent-acp, 0.70 (Tars' compiled-in
 * fallback) as 0.79 (what the registry serves today), offers `model` and
 * `effort` through `session/set_config_option`.
 *
 * The fake agent below offers both, records every setting it is sent, and
 * reports them, in order, as its answer.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-settings-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const FAKE_AGENT = `
let buf = '';
const offered = JSON.parse(process.env.FAKE_OFFERS || '["model","effort"]');
const set = [];
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 's1',
      configOptions: offered.map(id => ({ id, name: id, type: 'select', currentValue: 'default', options: [] })),
    } });
  }
  if (msg.method === 'session/set_config_option') {
    set.push([msg.params.configId, msg.params.value]);
    return send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });
  }
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(set) } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}
`;

let launch: { command: string; args: string[] };

vi.mock('../../../electron/services/acp/registry', () => ({
  acpLaunchFor: () => launch,
  loadAcpRegistry: async () => undefined,
}));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({
  getMcpOrchestratorPath: () => path.join(tmp, 'absent.js'),
  getMcpMemoryPath: () => path.join(tmp, 'absent.js'),
}));
vi.mock('../../../electron/providers', () => ({
  getProvider: () => ({ getPtyEnvVars: () => ({}) }),
}));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import type { AgentStatus } from '../../../electron/types';

/** What the agent was set to before the turn, in the order it was sent. */
async function settingsOfARun(fields: Partial<AgentStatus>, offers?: string[]): Promise<string[][]> {
  const script = path.join(tmp, 'agent.mjs');
  fs.writeFileSync(script, FAKE_AGENT);
  launch = { command: process.execPath, args: [script] };
  process.env.FAKE_OFFERS = JSON.stringify(offers ?? ['model', 'effort']);

  let set: string[][] | undefined;
  const result = await delegateOverAcp({
    agent: {
      id: 'agent-acp', name: 'Delegated', status: 'idle', projectPath: tmp, provider: 'claude',
      skills: [], output: [], lastActivity: new Date().toISOString(),
      ...fields,
    } as AgentStatus,
    task: 'report', appSettings: {} as never, timeoutMs: 20_000,
    onEvent: ({ type, payload }) => { if (type === 'text') set = JSON.parse(payload as string); },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return set!;
}

beforeEach(() => {
  delete process.env.FAKE_OFFERS;
});

describe('a task delegated over ACP', () => {
  it("runs on the agent's model, then its effort", async () => {
    expect(await settingsOfARun({ model: 'claude-opus-5-5', effort: 'max' }))
      .toEqual([['model', 'claude-opus-5-5'], ['effort', 'max']]);
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('passes effort %s as it is set', async (effort) => {
    expect(await settingsOfARun({ effort })).toEqual([['effort', effort]]);
  });

  it('sets nothing for an agent on Default with no effort', async () => {
    expect(await settingsOfARun({ model: 'default' })).toEqual([]);
  });

  it('still runs the task when the agent offers no effort, and sets what it does offer', async () => {
    expect(await settingsOfARun({ model: 'claude-opus-5-5', effort: 'max' }, ['model']))
      .toEqual([['model', 'claude-opus-5-5']]);
  });
});
