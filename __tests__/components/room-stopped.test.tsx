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
 * useRoomAgents computes it: the rail's word, detail, square and `stop`
 * button, and the composer's sentence. The rule itself, isStopped, is private
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

const ROOM = { id: 'project:/tmp/project', name: 'project', memberIds: ['a1', 'a2'] } as unknown as BusRoom;

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

const HOLLOW = 'border border-text-muted';
const ALL_STOPPED = 'Every agent here is stopped. Nothing moves until you start one.';
const WRITE = 'Write to the room, or pick who it is for.';

describe('the team rail', () => {
  it('says stopped, no live session, in the hollow square, with no stop to press', () => {
    const html = rail(member({ stopped: true, currentTask: 'review the guard' }));
    expect(html).toContain('>stopped<');
    expect(html).toContain('no live session');
    expect(html).not.toContain('review the guard');
    expect(html).toContain(HOLLOW);
    expect(html).not.toContain('>stop<');
  });

  it('keeps an agent at rest, with its session, as idle and listening', () => {
    const html = rail(member({ stopped: false }));
    expect(html).toContain('>idle<');
    expect(html).toContain('listening');
    expect(html).not.toContain('no live session');
    expect(html).not.toContain(HOLLOW);
  });

  it('offers no stop for an agent with no session, whatever its record says', () => {
    const html = rail(member({ status: 'running', stopped: true }));
    expect(html).not.toContain('>stop<');
    expect(rail(member({ status: 'running', stopped: false }))).toContain('>stop<');
  });

  it('lets an error keep its own word and its reason, even with no session', () => {
    const html = rail(member({ status: 'error', stopped: true, error: 'Not logged in · Please run /login' }));
    expect(html).toContain('>error<');
    expect(html).toContain('Not logged in · Please run /login');
    expect(html).not.toContain('no live session');
    expect(html).not.toContain(HOLLOW);
  });
});

describe('the room composer', () => {
  it('says every agent is stopped only when every one has no session', () => {
    expect(room([member({ id: 'a1', stopped: true }), member({ id: 'a2', stopped: true })])).toContain(ALL_STOPPED);
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
