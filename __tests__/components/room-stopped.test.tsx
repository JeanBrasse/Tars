import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamRail } from '../../src/components/Chat/TeamRail';
import { RoomView } from '../../src/components/Chat/RoomView';
import type { RoomAgent } from '../../src/hooks/useRoomAgents';
import type { BusRoom } from '../../src/types/electron';

/**
 * A Chat room calls an agent stopped only when Tars holds no session for it.
 *
 * It used to read `idle`, where Claude Code rests at the end of every turn with
 * its session open, so a room of two agents answering each other said "Every
 * agent here is stopped". These hold the room's two surfaces to `stopped` as
 * useRoomAgents computes it: the rail's word and its colour, detail and `stop`
 * button, and the composer's sentence. The rail's square gave way to the
 * agent's mark on 2026-09-23 (frame `Chat · Room · at rest or stopped`): the
 * word carries the state now, muted when stopped or at rest, red in error. The rule itself, isStopped, is private
 * to the hook and not reached from here.
 */

const noop = () => {};

function member(over: Partial<RoomAgent>): RoomAgent {
  return {
    id: 'a1',
    name: 'Reviewer',
    status: 'idle',
    projectPath: '/tmp/project',
    skills: [],
    output: [],
    lastActivity: new Date(0).toISOString(),
    hasEndOfTurn: true,
    stopped: false,
    ...over,
  } as RoomAgent;
}

function rail(agent: RoomAgent): string {
  return renderToStaticMarkup(
    <TeamRail agents={[agent]} pending={{}} onOpen={noop} onStop={noop} onSend={noop} onAdd={noop} />,
  );
}

// The room's shape as BusRoom declares it: its label is `title` (it said `name` until #124 read it).
const ROOM = { id: 'project:/tmp/project', kind: 'project', title: 'project', memberIds: ['a1', 'a2'], createdAt: '2026-09-23T00:00:00.000Z' } as unknown as BusRoom;

function room(agents: RoomAgent[]): string {
  return renderToStaticMarkup(
    <RoomView
      room={ROOM}
      threads={[]}
      messages={[]}
      deliveries={[]}
      agents={agents}
      loading={false}
      onPost={async () => ({ success: true })}
    />,
  );
}

const MARK = 'data-agent-mark="agent"';
const word = (ink: string, w: string) => `${ink}">${w}<`;
const ALL_STOPPED = 'Everyone in project is stopped. Nothing you write reaches an agent until one starts.';
const START_TO_WRITE = 'Start an agent to write here';
const WRITE = 'Write to everyone in project';

describe('the team rail', () => {
  it('says stopped, muted, no live session, beside its mark, with no stop to press', () => {
    const html = rail(member({ stopped: true, currentTask: 'review the guard' }));
    expect(html).toContain(word('text-muted-foreground', 'stopped'));
    expect(html).toContain('no live session');
    expect(html).not.toContain('review the guard');
    expect(html).toContain(MARK);
    expect(html).not.toContain('>stop<');
  });

  it('keeps an agent at rest, with its session, as idle and listening', () => {
    const html = rail(member({ stopped: false }));
    expect(html).toContain(word('text-muted-foreground', 'idle'));
    expect(html).toContain('listening');
    expect(html).not.toContain('no live session');
    expect(html).toContain(MARK);
  });

  it('offers no stop for an agent with no session, whatever its record says', () => {
    const html = rail(member({ status: 'running', stopped: true }));
    expect(html).not.toContain('>stop<');
    expect(rail(member({ status: 'running', stopped: false }))).toContain('>stop<');
  });

  it('lets an error keep its own word and its reason, even with no session', () => {
    const html = rail(member({ status: 'error', stopped: true, error: 'Not logged in · Please run /login' }));
    expect(html).toContain(word('text-status-error', 'error'));
    expect(html).toContain('Not logged in · Please run /login');
    expect(html).not.toContain('no live session');
  });
});

describe('the room composer', () => {
  it('says every agent is stopped only when every one has no session', () => {
    const html = room([member({ id: 'a1', stopped: true }), member({ id: 'a2', stopped: true })]);
    expect(html).toContain(ALL_STOPPED);
    expect(html).toContain(START_TO_WRITE);
    expect(html).not.toContain(WRITE);
  });

  it('does not call a room of agents at rest stopped', () => {
    const html = room([
      member({ id: 'a1', status: 'idle', stopped: false }),
      member({ id: 'a2', status: 'completed', stopped: false }),
    ]);
    expect(html).toContain(WRITE);
    expect(html).not.toContain('is stopped');
  });

  it('does not call the room stopped while one agent still has a session', () => {
    const html = room([member({ id: 'a1', stopped: true }), member({ id: 'a2', stopped: false })]);
    expect(html).toContain(WRITE);
    expect(html).not.toContain(ALL_STOPPED);
  });
});
