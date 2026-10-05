import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, deferred, ofType, textOf, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import PermissionAskNotice from '../../src/components/PermissionAskNotice';
import { Button, Input } from '../../src/components/ui';
import type { AgentStatus, AgentTickItem } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * A permission question Tars holds (#318), answered from the window: the
 * line under a panel's header and the top of the agent window's terminal
 * column (`PermissionAskNotice`), fed by useElectronAgents. Frame:
 * `Permission asked of Tars`. Written before the code. How it can fail:
 *
 * The list the page reads (useElectronAgents):
 * 1. the status event that puts an agent in waiting names the status alone,
 *    and the tick carries no permissionAsk: the page patched the status, and
 *    the question never showed;
 * 2. ask in terminal leaves the agent waiting, its lastActivity unchanged:
 *    the event says waiting again, the list read again compared equal on the
 *    fields it checked, and the question already answered stayed on screen;
 * 3. a tick that moves an agent into waiting, with no status event (one
 *    missed, a window opened late), shows no question either.
 *
 * The line (PermissionAskNotice):
 * 4. allow, deny or ask in terminal sends another decision than its own, or
 *    for another agent;
 * 5. deny sends at once, with no step for a reason; Enter in that step sends
 *    anything but deny with what was typed; spaces go as a reason; Esc
 *    answers, or reaches the window behind (the agent window closes on Esc,
 *    a fullscreen panel leaves fullscreen) instead of going back;
 * 6. a second click while the first answer is on its way answers twice;
 * 7. Tars answers that it holds no question (`success: false`: the ten
 *    minutes ran out, the turn ended, another window answered), or the call
 *    fails, and the line goes on offering the answers as if one had landed;
 * 8. the next call's question (another askedAt) inherits the last one's
 *    state: the reason step still open, or too late for a question just
 *    asked;
 * 9. a reason longer than main keeps (200, permission-asks.ts) is cut by main
 *    without a word: the field takes no more.
 */

type Tick = (items: AgentTickItem[]) => void;
type StatusEvent = (event: { agentId: string; status: string; timestamp: string }) => void;

const ASK = { tool: 'Bash', askedAt: '2026-10-05T12:02:00.000Z' };
const ON = { kind: 'permission' as const, text: 'npm run build && npm test' };

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Frontend Engineer', status: 'running', projectPath: '/p', skills: [], output: [],
    lastActivity: '2026-10-05T12:00:00.000Z', currentTask: 'Build and test', provider: 'claude', cliRunning: true,
    ...over,
  } as AgentStatus;
}

function tickItem(a: AgentStatus): AgentTickItem {
  return {
    id: a.id, name: a.name ?? a.id, character: 'robot', status: a.status, displayStatus: 'working', statusLine: '',
    currentTask: a.currentTask ?? '', projectName: 'p', lastActivity: a.lastActivity, provider: 'claude',
    cliRunning: a.cliRunning, leftFullscreen: false, launching: false,
  } as AgentTickItem;
}

const g = globalThis as unknown as { window?: unknown };

describe('useElectronAgents reads what a waiting agent waits on', () => {
  let listed: AgentStatus[];
  let tick: Tick | undefined;
  let status: StatusEvent | undefined;
  let hook: Mount<ReturnType<typeof useElectronAgents>>;

  beforeEach(async () => {
    listed = [agent()];
    const noop = () => () => {};
    g.window = {
      electronAPI: {
        agent: {
          list: vi.fn(async () => listed),
          onOutput: noop, onError: noop, onComplete: noop,
          onStatus: (cb: StatusEvent) => { status = cb; return () => { status = undefined; }; },
          onTick: (cb: Tick) => { tick = cb; return () => { tick = undefined; }; },
        },
      },
    };
    hook = mount(() => useElectronAgents());
    await settle();
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('a status event into waiting reads the record, where the question is (1)', async () => {
    listed = [agent({ status: 'waiting', permissionAsk: ASK, waitingOn: ON, lastActivity: ASK.askedAt })];
    status!({ agentId: 'a1', status: 'waiting', timestamp: '' });
    await settle();
    expect(hook.result.agents[0]).toMatchObject({ status: 'waiting', permissionAsk: ASK, waitingOn: ON });
  });

  it('waiting again with the question gone drops it, though nothing else moved (2)', async () => {
    listed = [agent({ status: 'waiting', permissionAsk: ASK, waitingOn: ON, lastActivity: ASK.askedAt })];
    status!({ agentId: 'a1', status: 'waiting', timestamp: '' });
    await settle();
    listed = [agent({ status: 'waiting', waitingOn: ON, lastActivity: ASK.askedAt })];
    status!({ agentId: 'a1', status: 'waiting', timestamp: '' });
    await settle();
    expect(hook.result.agents[0].status).toBe('waiting');
    expect(hook.result.agents[0].permissionAsk).toBeUndefined();
  });

  it('a tick into waiting reads the record too (3)', async () => {
    listed = [agent({ status: 'waiting', permissionAsk: ASK, waitingOn: ON, lastActivity: ASK.askedAt })];
    tick!([tickItem(listed[0])]);
    await settle();
    expect(hook.result.agents[0].permissionAsk).toEqual(ASK);
  });
});

describe('the line answers the question Tars holds', () => {
  let answer: ReturnType<typeof vi.fn>;
  let reply: ReturnType<typeof deferred<{ success: boolean }>>;

  beforeEach(() => {
    reply = deferred<{ success: boolean }>();
    answer = vi.fn(() => reply.promise);
    g.window = { electronAPI: { agent: { answerPermission: answer } } };
  });
  afterEach(() => { delete g.window; });

  const asking = (over: Partial<AgentStatus> = {}) => agent({ status: 'waiting', permissionAsk: ASK, waitingOn: ON, ...over });
  const buttons = (tree: unknown) => ofType(tree, Button).map(b => ({ text: textOf(b.props.children as never), props: b.props as { onClick?: () => void; disabled?: boolean } }));
  const button = (tree: unknown, text: string) => {
    const found = buttons(tree).find(b => b.text === text);
    expect(found, `a button "${text}"`).toBeDefined();
    return found!;
  };
  const field = (tree: unknown) => ofType(tree, Input)[0]?.props as undefined | {
    value: string; maxLength?: number;
    onChange: (e: { target: { value: string } }) => void;
    onKeyDown: (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void;
  };
  const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

  for (const layout of ['panel', 'window'] as const) {
    describe(`in the ${layout}`, () => {
      it('shows nothing for an agent with no question of Tars\'s', () => {
        expect(mount(() => PermissionAskNotice({ agent: agent({ status: 'waiting', waitingOn: ON }), layout })).result).toBeNull();
        expect(mount(() => PermissionAskNotice({ agent: agent({ permissionAsk: ASK }), layout })).result).toBeNull();
      });

      it('names the call, and each answer sends its own decision for this agent (4)', async () => {
        const view = mount(() => PermissionAskNotice({ agent: asking(), layout }));
        expect(textOf(view.result as never)).toContain('npm run build && npm test');
        expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
        button(view.result, 'allow').props.onClick!();
        expect(answer).toHaveBeenCalledWith('a1', 'allow', undefined);

        const other = mount(() => PermissionAskNotice({ agent: asking({ id: 'a2' }), layout }));
        button(other.result, 'ask in terminal').props.onClick!();
        expect(answer).toHaveBeenLastCalledWith('a2', 'ask', undefined);
      });

      it('deny asks for a reason first: Enter sends it, spaces are none, Esc goes back without answering (5)', () => {
        let a = asking();
        const view = mount(() => PermissionAskNotice({ agent: a, layout }));
        button(view.result, 'deny').props.onClick!();
        expect(answer).not.toHaveBeenCalled();
        expect(buttons(view.result).map(b => b.text)).toEqual(['deny', 'back']);

        const esc = key('Escape');
        field(view.result)!.onKeyDown(esc);
        expect(esc.stopPropagation, 'Esc stays in the line').toHaveBeenCalled();
        expect(answer).not.toHaveBeenCalled();
        expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);

        button(view.result, 'deny').props.onClick!();
        field(view.result)!.onChange({ target: { value: '   ' } });
        button(view.result, 'deny').props.onClick!();
        expect(answer).toHaveBeenLastCalledWith('a1', 'deny', undefined);

        a = asking({ permissionAsk: { ...ASK, askedAt: '2026-10-05T12:04:00.000Z' } });
        view.rerender();
        button(view.result, 'deny').props.onClick!();
        field(view.result)!.onChange({ target: { value: '  use the cached build  ' } });
        field(view.result)!.onKeyDown(key('Enter'));
        expect(answer).toHaveBeenLastCalledWith('a1', 'deny', 'use the cached build');
      });

      it('the field takes no more than main keeps (9)', () => {
        const view = mount(() => PermissionAskNotice({ agent: asking(), layout }));
        button(view.result, 'deny').props.onClick!();
        expect(field(view.result)!.maxLength).toBe(200);
      });

      it('answers once: the three are off while the answer is on its way, and stay off once it landed (6)', async () => {
        const view = mount(() => PermissionAskNotice({ agent: asking(), layout }));
        button(view.result, 'allow').props.onClick!();
        expect(buttons(view.result).every(b => b.props.disabled)).toBe(true);
        button(view.result, 'ask in terminal').props.onClick!();
        expect(answer).toHaveBeenCalledTimes(1);
        reply.resolve({ success: true });
        await settle();
        expect(buttons(view.result).every(b => b.props.disabled)).toBe(true);
      });

      it('says so when Tars no longer holds the question, or the call fails, and offers nothing (7)', async () => {
        const view = mount(() => PermissionAskNotice({ agent: asking(), layout }));
        button(view.result, 'allow').props.onClick!();
        reply.resolve({ success: false });
        await settle();
        expect(textOf(view.result as never)).toContain('Tars no longer holds this question');
        expect(buttons(view.result)).toHaveLength(0);

        reply = deferred<{ success: boolean }>();
        const failing = mount(() => PermissionAskNotice({ agent: asking({ id: 'a2' }), layout }));
        button(failing.result, 'allow').props.onClick!();
        reply.reject(new Error('No handler registered'));
        await settle();
        expect(textOf(failing.result as never)).toContain('Tars no longer holds this question');
      });

      it('the next call\'s question starts afresh (8)', async () => {
        let a = asking();
        const view = mount(() => PermissionAskNotice({ agent: a, layout }));
        button(view.result, 'allow').props.onClick!();
        reply.resolve({ success: false });
        await settle();
        a = asking({ permissionAsk: { ...ASK, askedAt: '2026-10-05T12:05:00.000Z' }, waitingOn: { kind: 'permission', text: 'npm run lint' } });
        view.rerender();
        expect(textOf(view.result as never)).toContain('npm run lint');
        expect(buttons(view.result).map(b => [b.text, !!b.props.disabled])).toEqual([['allow', false], ['deny', false], ['ask in terminal', false]]);

        button(view.result, 'deny').props.onClick!();
        a = asking({ permissionAsk: { ...ASK, askedAt: '2026-10-05T12:06:00.000Z' } });
        view.rerender();
        expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
      });
    });
  }
});
