import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcpSession } from '../../../electron/services/acp/client';

/**
 * A fake agent that speaks just enough ACP to prove the client's contract:
 * a turn returns a stop reason, tool events surface, and the deny list is
 * enforced by answering the agent's own permission request.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-'));
const started: AcpSession[] = [];

function fakeAgent(script: string): { command: string; args: string[] } {
  const file = path.join(tmp, `agent-${Math.abs(hash(script))}.mjs`);
  fs.writeFileSync(file, script);
  return { command: process.execPath, args: [file] };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const PRELUDE = `
let buf = '';
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
`;

afterEach(() => {
  for (const s of started.splice(0)) s.stop();
});

function track(session: AcpSession): AcpSession {
  started.push(session);
  return session;
}

describe('AcpSession', () => {
  it('returns the turn result rather than leaving the caller to guess', async () => {
    const agent = fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { agentInfo: { name: 'fake' } } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { totalTokens: 42 } } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp }));
    const info = await session.start();
    const turn = await session.prompt('do the thing', 20_000);

    expect(info.agentName).toBe('fake');
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.text).toBe('done');
    expect(turn.usage?.totalTokens).toBe(42);
  });

  it('surfaces tool calls as structured events', async () => {
    const agent = fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'Bash', kind: 'execute', status: 'pending' } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp }));
    const seen: string[] = [];
    session.on('tool', t => seen.push(t.title));
    await session.start();
    const turn = await session.prompt('run it', 20_000);

    expect(seen).toEqual(['Bash']);
    expect(turn.toolCalls.map(t => t.title)).toEqual(['Bash']);
  });

  it('rejects a denied tool when the agent asks permission', async () => {
    const agent = fakeAgent(`${PRELUDE}
let promptId = null;
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', modes: { currentModeId: 'dontAsk', availableModes: [{ id: 'default' }] } } });
  if (msg.method === 'session/set_mode') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      toolCall: { title: 'Write', kind: 'edit' },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
    } });
    return;
  }
  if (msg.id === 900) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chose:' + msg.result.outcome.optionId } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp, denyTools: ['write'] }));
    await session.start();
    const turn = await session.prompt('edit a file', 20_000);

    expect(turn.text).toBe('chose:no');
  });

  it('allows a tool that is not on the deny list', async () => {
    const agent = fakeAgent(`${PRELUDE}
let promptId = null;
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      toolCall: { title: 'Read', kind: 'read' },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
    } });
    return;
  }
  if (msg.id === 900) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chose:' + msg.result.outcome.optionId } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp, denyTools: ['write'] }));
    await session.start();
    const turn = await session.prompt('read a file', 20_000);

    expect(turn.text).toBe('chose:yes');
  });

  it('fails the pending call when the agent dies mid-turn', async () => {
    const agent = fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') process.exit(3);
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp }));
    await session.start();

    await expect(session.prompt('boom', 20_000)).rejects.toThrow(/exited/);
  });
});

describe('what a turn leaves behind when it ends (sessions that died while they waited, 2026-09-23)', () => {
  // A delegated run is one turn: when it ends, Tars stops the agent, and what
  // it left running goes with it. Measured on claude-agent-acp 0.70.0: a
  // background command's own notice reads `<status>killed</status>` two seconds
  // after the turn. And a run stopped at its turn limit answered nothing at
  // all, however much it had said and done.
  //
  // How this fails, written before the code:
  // 1. A background command, a Monitor or a ScheduleWakeup the turn started is
  //    not reported, so whoever delegated reads "done" and waits for results
  //    that were stopped.
  // 2. The call's input arrives in a later tool_call_update than the call
  //    itself (the adapter emits the call first), and only the first is read.
  // 3. A foreground command is counted as left behind.
  // 4. A turn stopped at its limit returns no text and no tools: what the
  //    agent said and did before the limit is lost.
  const agentWith = (updates: unknown[], answer = true) => fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    for (const update of ${JSON.stringify(updates)}) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
    ${answer ? "return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });" : ''}
  }
}
`);

  it('reports the background commands, monitors and wakeups the turn left running', async () => {
    const session = track(new AcpSession(agentWith([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Terminal', kind: 'execute', rawInput: {} },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'pnpm build', rawInput: { command: 'pnpm build', run_in_background: true } },
      { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'pnpm test', kind: 'execute', rawInput: { command: 'pnpm test' } },
      { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Monitor', kind: 'other', rawInput: { command: 'tail -f build.log' } },
      { sessionUpdate: 'tool_call', toolCallId: 't4', title: 'ScheduleWakeup', kind: 'other', rawInput: { delaySeconds: 1200 } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'builds are running' } },
    ]), { cwd: tmp }));
    await session.start();

    const turn = await session.prompt('upgrade', 20_000);

    expect(turn.background).toEqual(['pnpm build', 'Monitor', 'ScheduleWakeup']);
    // Named by what it ran, not by the placeholder the adapter sends first
    // ("Terminal", measured on claude-agent-acp 0.70.0).
    expect(turn.toolCalls.map(t => t.title)).toEqual(['pnpm build', 'pnpm test', 'Monitor', 'ScheduleWakeup']);
  });

  it('reports nothing for a turn that waited for its own work', async () => {
    const session = track(new AcpSession(agentWith([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pnpm build', kind: 'execute', rawInput: { command: 'pnpm build', timeout: 600000 } },
    ]), { cwd: tmp }));
    await session.start();

    expect((await session.prompt('build', 20_000)).background).toEqual([]);
  });

  it('keeps what a turn said and did when it is stopped at its limit', async () => {
    const session = track(new AcpSession(agentWith([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'three of five repos upgraded' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pnpm build', kind: 'execute', rawInput: { command: 'pnpm build' } },
    ], false), { cwd: tmp }));
    await session.start();

    await expect(session.prompt('upgrade', 1_500)).rejects.toThrow(/timed out/);
    const partial = session.partialTurn();

    expect(partial.text).toBe('three of five repos upgraded');
    expect(partial.toolCalls.map(t => t.title)).toEqual(['pnpm build']);
  });
});
