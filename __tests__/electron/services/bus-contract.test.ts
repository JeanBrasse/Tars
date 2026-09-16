import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The bus contract, the six points that are settled.
 *
 * Chapter 9 of briefs/bus-contract.md asks for proof of seven things. Six of
 * them are decided and cannot move: the bounds, silence, the session barrier,
 * not_sent, replacement and Stop, and a change of members. The seventh, how a
 * round advances, is being repaired while this is written, so pinning it now
 * would pin the defect: it is deliberately absent here.
 *
 * These drive the real store, the real fan out and the real queue. The journal
 * is redirected into a temp dir, which matters more here than usual: saveBus()
 * writes on every call with no `loaded` guard in front of it, so an unredirected
 * run would write over the real ~/.dorothy/bus.json.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bus-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual,
    DATA_DIR: tmp,
    AGENTS_FILE: path.join(tmp, 'agents.json'),
    BUS_FILE: path.join(tmp, 'bus.json'),
    dataPath: (f: string) => path.join(tmp, f),
  };
});

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type AgentStatus = import('../../../electron/types').AgentStatus;
type BusThread = import('../../../electron/types').BusThread;

let store: typeof import('../../../electron/services/bus-store');
let delivery: typeof import('../../../electron/services/bus-delivery');
let watch: typeof import('../../../electron/services/agent-watch');
let manager: typeof import('../../../electron/core/agent-manager');
let ptyManager: typeof import('../../../electron/core/pty-manager');
let events: typeof import('../../../electron/services/agent-events');

const ROOM = 'project:/tars';

/** What a terminal was told to display, in order. */
type FakeTerminal = { id: string; written: string[] };
const terminals: FakeTerminal[] = [];

function attachTerminal(ptyId: string): FakeTerminal {
  const terminal: FakeTerminal = { id: ptyId, written: [] };
  ptyManager.ptyProcesses.set(ptyId, { write: (data: string) => { terminal.written.push(data); } } as never);
  terminals.push(terminal);
  return terminal;
}

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = {
    name: over.id.toUpperCase(),
    status: 'idle',
    provider: 'claude',
    projectPath: '/tars',
    skills: [],
    output: [],
    ptyId: `pty-${over.id}`,
    currentSessionId: `sess-${over.id}`,
    lastActivity: new Date().toISOString(),
    ...over,
  } as AgentStatus;
  manager.agents.set(agent.id, agent);
  return agent;
}

/** Noah says something, which is the only thing that opens an anchor. */
function human(text: string, mentions?: string[]) {
  return store.appendMessage({
    roomId: ROOM,
    authorKind: 'human',
    authorId: 'human',
    authorName: 'Noah',
    text,
    mentions,
  });
}

function post(agentId: string, text: string, mentions?: string[]) {
  return store.publishAgentMessage({ roomId: ROOM, agentId, text, mentions });
}

function room() {
  return store.listRooms().find(r => r.id === ROOM)!;
}

beforeEach(async () => {
  vi.resetModules();
  terminals.length = 0;
  manager = await import('../../../electron/core/agent-manager');
  ptyManager = await import('../../../electron/core/pty-manager');
  events = await import('../../../electron/services/agent-events');
  watch = await import('../../../electron/services/agent-watch');
  store = await import('../../../electron/services/bus-store');
  delivery = await import('../../../electron/services/bus-delivery');
  manager.agents.clear();
  ptyManager.ptyProcesses.clear();
  store.resetBusStore();
  // The journal is a file as well as a map: resetBusStore clears the memory and
  // the next loadBus() reads the temp file straight back, so a member override
  // set by one test would arrive in the next one.
  fs.rmSync(path.join(tmp, 'bus.json'), { force: true });
  watch.resetAgentWatch();
  watch.startAgentWatch();
});

afterEach(() => {
  watch.stopAgentWatch();
  vi.useRealTimers();
});

describe('the bounds, applied where an agent cannot get around them', () => {
  /**
   * Driven through the store's own append rather than through the rotation.
   *
   * Not because the rotation is broken, it advances since 424b1d5 and the
   * describe at the bottom of this file drives it end to end. It is so that
   * each case here names the bound that actually closed the thread: reaching
   * ten messages through three voices also reaches the third round, and a test
   * that trips both at once cannot say which one did the work.
   */
  function agentSays(speaker: string, text: string) {
    return store.appendMessage({
      roomId: ROOM, authorKind: 'agent', authorId: speaker, authorName: speaker.toUpperCase(), text,
    }).thread;
  }

  it('closes a thread on the tenth agent message', () => {
    // Four voices in rotation: three rounds hold ten messages, so the count is
    // what closes this one and the round bound is not in the way.
    const ids = ['a', 'b', 'c', 'd'];
    for (const id of ids) putAgent({ id, status: 'running' });
    const { thread } = human('four of you, talk', ids);

    let last = thread;
    for (let n = 0; n < 10; n++) last = agentSays(ids[n % ids.length], `message ${n + 1}`);

    expect(last.agentMessageCount).toBe(10);
    expect(last.round).toBeLessThanOrEqual(3);
    expect(store.getThread(thread.id)?.state).toBe('bounded');
  });

  it('closes a thread on the fourth round, well before ten messages', () => {
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'b', status: 'running' });
    const { thread } = human('you two, talk', ['a', 'b']);

    let last = thread;
    for (let n = 0; n < 7; n++) last = agentSays(n % 2 === 0 ? 'a' : 'b', `message ${n + 1}`);

    // Two voices means a round every two messages: the seventh opens the fourth.
    expect(last.round).toBe(4);
    expect(last.agentMessageCount).toBe(7);
    expect(store.getThread(thread.id)?.state).toBe('bounded');
  });

  it('refuses the same way however fast the calls come, because the caller holds no copy of the rule', () => {
    // The control for "server side": the tool and the route are read from
    // disk, and neither carries a bound, a marker or a round of its own. A
    // second implementation there is exactly how an agent would outrun this.
    const callers = [
      'electron/services/api-routes/bus-routes.ts',
      'mcp-orchestrator/src/tools/rooms.ts',
    ];
    for (const file of callers) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
      expect(source).not.toContain('MAX_ROUNDS');
      expect(source).not.toContain('MAX_AGENT_MESSAGES');
      expect(source).not.toContain('SILENCE_MARKERS');
      expect(source).not.toMatch(/agentMessageCount\s*[><=+]/);
    }
    const route = fs.readFileSync(path.join(process.cwd(), callers[0]), 'utf-8');
    expect(route).toContain('publishAgentMessage');
  });

  it('is still open one message short of the bound, so the bound is what closes it', () => {
    const ids = ['a', 'b', 'c', 'd'];
    for (const id of ids) putAgent({ id, status: 'running' });
    human('four of you, talk', ids);

    for (let n = 0; n < 9; n++) agentSays(ids[n % ids.length], `message ${n + 1}`);

    const thread = store.openThreadOf(ROOM);
    expect(thread?.state).toBe('open');
    expect(thread?.agentMessageCount).toBe(9);
  });
});

describe('silence, which costs nothing', () => {
  it.each(['(pass)', '[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY', '  (pass)  '])(
    'refuses %s without storing it or counting it',
    (marker) => {
      putAgent({ id: 'a', status: 'running' });
      putAgent({ id: 'b', status: 'running' });
      const { thread } = human('anything to add?', ['a', 'b']);

      const result = post('a', marker, ['b']);

      expect(result).toMatchObject({ published: false, reason: 'silence' });
      expect(store.messagesOfThread(thread.id).filter(m => m.authorKind === 'agent')).toHaveLength(0);
      expect(store.getThread(thread.id)?.agentMessageCount).toBe(0);
    },
  );

  it('publishes and counts the same sentence with a word in it', () => {
    // The control: without it these would pass just as well against a store
    // that published nothing at all.
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'b', status: 'running' });
    const { thread } = human('anything to add?', ['a', 'b']);

    const result = post('a', 'no reply needed from me, the build is green', ['b']);

    expect(result.published).toBe(true);
    expect(store.getThread(thread.id)?.agentMessageCount).toBe(1);
  });
});

describe('a provider with no end of turn', () => {
  it('is recorded not_sent with its reason, never queued in silence', () => {
    putAgent({ id: 'writer', status: 'running' });
    putAgent({ id: 'cx', provider: 'codex' as AgentStatus['provider'], status: 'running' });
    const { message } = human('anyone there?', ['cx']);

    const deliveries = delivery.fanOutDeliveries(message, room());

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ targetAgentId: 'cx', state: 'not_sent', reasonCode: 'no_end_of_turn' });
    expect(deliveries[0].reason).toBeTruthy();
    // And nothing was handed to the queue behind the interface's back.
    expect(terminals.flatMap(t => t.written)).toHaveLength(0);
  });

  it('queues for a provider that does have one, which is the same call', () => {
    const terminal = attachTerminal('pty-cl');
    putAgent({ id: 'writer', status: 'running' });
    putAgent({ id: 'cl', provider: 'claude', status: 'idle', ptyId: 'pty-cl' });
    const { message } = human('anyone there?', ['cl']);

    const deliveries = delivery.fanOutDeliveries(message, room());

    expect(deliveries[0]).toMatchObject({ targetAgentId: 'cl', state: 'queued' });
    expect(terminal.written.join('')).toContain('anyone there?');
  });

  it('says no_live_session for a reachable provider with no session to write into', () => {
    putAgent({ id: 'writer', status: 'running' });
    putAgent({ id: 'cl', provider: 'claude', status: 'idle', ptyId: undefined });
    const { message } = human('anyone there?', ['cl']);

    const deliveries = delivery.fanOutDeliveries(message, room());

    expect(deliveries[0]).toMatchObject({ targetAgentId: 'cl', state: 'not_sent', reasonCode: 'no_live_session' });
  });
});

describe('the session barrier', () => {
  it('does not hand a message to the session that replaced the one it was for', () => {
    const dropped: string[] = [];
    watch.setBusDroppedHook((targetAgentId, messageId) => dropped.push(`${targetAgentId}:${messageId}`));
    attachTerminal('pty-old');
    putAgent({ id: 'writer', status: 'running' });
    const target = putAgent({ id: 'busy', status: 'running', ptyId: 'pty-old', currentSessionId: 'sess-old' });
    const { message } = human('for you when you are free', ['busy']);
    delivery.fanOutDeliveries(message, room());

    // Killed and relaunched: new terminal, new session, the old id tombstoned.
    const fresh = attachTerminal('pty-new');
    target.ptyId = 'pty-new';
    target.lastKilledSessionId = 'sess-old';
    target.currentSessionId = 'sess-new';
    target.status = 'idle';
    events.emitAgentStatus('busy');

    expect(fresh.written).toHaveLength(0);
    expect(dropped).toContain(`busy:${message.id}`);
  });

  it('hands it over when it is the same session, which is the whole difference', () => {
    const terminal = attachTerminal('pty-old');
    putAgent({ id: 'writer', status: 'running' });
    const target = putAgent({ id: 'busy', status: 'running', ptyId: 'pty-old', currentSessionId: 'sess-old' });
    const { message } = human('for you when you are free', ['busy']);
    delivery.fanOutDeliveries(message, room());
    expect(terminal.written).toHaveLength(0);

    target.status = 'idle';
    events.emitAgentStatus('busy');

    expect(terminal.written.join('')).toContain('for you when you are free');
    expect(store.deliveriesOf(message.id)[0].state).toBe('queued');
  });
});

describe('replacement and Stop', () => {
  it('closes the anchor when Noah speaks again, and refuses the late reply', () => {
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'b', status: 'running' });
    const first = human('first question', ['a', 'b']);

    const second = human('actually, this instead', ['a', 'b']);

    expect(store.getThread(first.thread.id)?.state).toBe('superseded');
    expect(second.supersededThreadId).toBe(first.thread.id);
    expect(second.thread.id).not.toBe(first.thread.id);
    expect(second.thread.state).toBe('open');
    // A reply aimed at the old anchor is refused rather than filed under the new one.
    expect(store.messagesOfThread(first.thread.id).every(m => m.authorKind === 'human')).toBe(true);
  });

  it('leaves the anchor open when nobody replaced it', () => {
    putAgent({ id: 'a', status: 'running' });
    const first = human('first question', ['a']);

    expect(store.getThread(first.thread.id)?.state).toBe('open');
  });

  it('drops what Stop was still holding, with the reason, and refuses what comes after', () => {
    attachTerminal('pty-busy');
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'busy', status: 'running', ptyId: 'pty-busy' });
    const { message, thread } = human('start on this', ['busy']);
    delivery.fanOutDeliveries(message, room());
    expect(store.deliveriesOf(message.id)[0].state).toBe('queued');

    store.closeThread(thread.id, 'stopped');
    delivery.closeAndAnnounce(thread.id, 'thread_stopped', 'the thread was stopped');

    expect(store.deliveriesOf(message.id)[0]).toMatchObject({ state: 'dropped', reasonCode: 'thread_stopped' });
    // Refused, which is what Stop has to mean. The reason it gives is
    // `no_open_thread` and not `thread_stopped`: openThreadOf only ever returns
    // a thread in state `open`, so the three refusals that name a closed one
    // cannot be reached at all. Pinned as found and reported rather than
    // repaired: an agent that posts after a deliberate Stop is told no thread
    // was ever open here, which is not what happened to it.
    expect(post('a', 'too late', ['busy'])).toMatchObject({ published: false, reason: 'no_open_thread' });
  });

  it('keeps the queued delivery when nothing stopped the thread', () => {
    attachTerminal('pty-busy');
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'busy', status: 'running', ptyId: 'pty-busy' });
    const { message } = human('start on this', ['busy']);
    delivery.fanOutDeliveries(message, room());

    expect(store.deliveriesOf(message.id)[0].state).toBe('queued');
  });
});

/**
 * The round ending, which is what makes every bound above reachable at all.
 *
 * Pinned only now. Until 424b1d5 an exchange stopped after one round: the
 * guard refused an agent that had already been heard, and that refused message
 * was precisely the one that would have advanced the counter. So MAX_ROUNDS
 * was dead code, and a room with fewer members than MAX_AGENT_MESSAGES, which
 * is every real room, never reached `bounded` at all. It simply refused
 * everyone, with no state the interface could show.
 */
describe('a round that ends, so a thread can bound itself', () => {
  const others = (ids: string[], speaker: string) => ids.filter(id => id !== speaker);

  function threeTalking(): string[] {
    const ids = ['a', 'b', 'c'];
    for (const id of ids) putAgent({ id, status: 'running' });
    human('you three, sort it out', ids);
    return ids;
  }

  it('advances one, two, three as three agents cite each other', () => {
    const ids = threeTalking();
    const rounds: number[] = [];

    for (let n = 0; n < 9; n++) {
      const speaker = ids[n % 3];
      const result = post(speaker, `message ${n + 1}`, others(ids, speaker));
      expect(result.published, `message ${n + 1} from ${speaker}`).toBe(true);
      if (result.published) rounds.push(result.thread.round);
    }

    expect(rounds).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  it('stops three agents in bounded, and refuses what comes after', () => {
    const ids = threeTalking();

    let last: ReturnType<typeof post> | undefined;
    for (let n = 0; n < 10; n++) {
      const speaker = ids[n % 3];
      last = post(speaker, `message ${n + 1}`, others(ids, speaker));
      expect(last.published, `message ${n + 1}`).toBe(true);
    }

    expect(last && last.published && last.thread.state).toBe('bounded');
    expect(store.openThreadOf(ROOM)).toBeUndefined();
    expect(post('a', 'one more', ['b', 'c']).published).toBe(false);
  });

  it('bounds a room of two on rounds, which no room could reach before', () => {
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'b', status: 'running' });
    human('you two', ['a', 'b']);

    const accepted: BusThread[] = [];
    for (let n = 0; n < 8; n++) {
      const speaker = n % 2 === 0 ? 'a' : 'b';
      const result = post(speaker, `message ${n + 1}`, [speaker === 'a' ? 'b' : 'a']);
      if (result.published) accepted.push(result.thread);
    }

    // Two voices means a round every two messages, so the seventh opens the
    // fourth round and closes the thread on seven messages, nowhere near ten.
    expect(accepted).toHaveLength(7);
    expect(accepted[6].state).toBe('bounded');
    expect(accepted[6].agentMessageCount).toBe(7);
    expect(accepted[6].round).toBe(4);
  });

  /**
   * The negative control: the same exchange, refereed by the guard as it was.
   *
   * It runs on its own journal rather than being asked about the real one.
   * That is the whole point: the old guard refused the message that would have
   * ended the round, so the journal it produced is not the journal produced
   * today, and asking it about messages it would never have let through would
   * flatter it. Here it only ever sees what it accepted.
   */
  type OldEntry = { authorKind: 'human' | 'agent'; authorId: string; mentions: string[] };

  /** currentRound, which the fix did not touch, over an arbitrary journal. */
  const roundAndHeard = (journal: OldEntry[]) => {
    let round = 1;
    let heard = new Set<string>();
    for (const entry of journal) {
      if (entry.authorKind !== 'agent') continue;
      if (heard.has(entry.authorId)) { round += 1; heard = new Set<string>(); }
      heard.add(entry.authorId);
    }
    return { round, heard };
  };

  /** The guard as it read before 424b1d5, over what it had itself accepted. */
  function runOldGuard(voices: string[], attempts: number) {
    // The opening human message, which names everyone, exactly as the room
    // helper posts it: the old guard scanned it too when looking for a mention.
    const journal: OldEntry[] = [{ authorKind: 'human', authorId: 'human', mentions: voices }];
    let taken = 0;

    for (let n = 0; n < attempts; n++) {
      const me = voices[n % voices.length];
      const { round, heard } = roundAndHeard(journal);
      if (round > 1 || heard.size > 0) {
        const mentionedByAnother = journal.some(m => m.authorId !== me && m.mentions.includes(me));
        if (!mentionedByAnother) continue;
        if (heard.has(me)) continue;
      }
      journal.push({ authorKind: 'agent', authorId: me, mentions: others(voices, me) });
      taken += 1;
    }
    return { taken, round: roundAndHeard(journal).round };
  }

  it('is what the old guard prevented: it took three and then refused everyone', () => {
    const ids = threeTalking();
    let published = 0;
    for (let n = 0; n < 9; n++) {
      const speaker = ids[n % 3];
      if (post(speaker, `message ${n + 1}`, others(ids, speaker)).published) published += 1;
    }

    const old = runOldGuard(ids, 9);

    // Nine today, three then. The old guard refused the fourth message, the one
    // that would have ended the round, so every message after it was refused
    // too: the third voice had spoken, so nobody was left that the round had
    // not already heard, and nothing ever cleared it.
    expect(published).toBe(9);
    expect(old.taken).toBe(3);
    expect(old.round).toBe(1);
  });

  it('is what the old guard prevented: one turn each, at any number of voices', () => {
    // Measured against the real store before the fix, and reproduced here: one
    // message per voice and no more, whatever the room size.
    expect(runOldGuard(['a', 'b', 'c', 'd'], 12).taken).toBe(4);
    expect(runOldGuard(['a', 'b'], 8).taken).toBe(2);
  });
});

describe('a change of members', () => {
  it('closes the anchor in flight and reports the new membership', () => {
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'b', status: 'running' });
    const { thread } = human('talk among yourselves', ['a', 'b']);

    const result = store.setMembers(ROOM, ['a']);

    expect(result?.superseded?.id).toBe(thread.id);
    expect(store.getThread(thread.id)?.state).toBe('superseded');
    expect(result?.room.memberIds).toEqual(['a']);
    // A new anchor is not invented: only a human message opens one.
    expect(store.openThreadOf(ROOM)).toBeUndefined();
    expect(post('a', 'still here?', ['b'])).toMatchObject({ published: false, reason: 'no_open_thread' });
  });

  it('leaves the anchor alone when the members are not touched', () => {
    putAgent({ id: 'a', status: 'running' });
    putAgent({ id: 'b', status: 'running' });
    const { thread } = human('talk among yourselves', ['a', 'b']);

    expect(store.getThread(thread.id)?.state).toBe('open');
    expect(room().memberIds.sort()).toEqual(['a', 'b']);
  });
});
