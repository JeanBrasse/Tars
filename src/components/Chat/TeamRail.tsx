'use client';

import { Button, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import { errorReason } from '@/app/agents/constants';

/**
 * The right rail, 264 wide: who is in this room, then how the room runs.
 * Frames: `Chat · Room · agents at work` > `Rail`.
 */

/** How the room runs, in the room. Every line is a rule the bus enforces in
 *  code, not advice: publishing is an act, silence is the default, the anchor
 *  is bounded, and only you change the membership. */
const RULES: Array<[string, string]> = [
  ['posts', 'publishing is an act: a turn can end without a word'],
  ['speaks', 'when named, or to hand back a job it was given'],
  ['never', 'a bare acknowledgement, and nothing on a heartbeat'],
  ['queue', 'a message to a busy agent waits for its turn to end'],
  ['limit', '3 rounds or 10 agent messages without you, then it pauses'],
  ['you', 'only you stop, add or change an agent'],
];

export function agentTone(agent: RoomAgent): StatusTone | 'none' {
  // An agent whose CLI never reports a turn end has no state Tars can vouch
  // for, so it gets no square rather than a green one that would claim work.
  if (!agent.hasEndOfTurn) return 'none';
  switch (agent.status) {
    case 'running': return 'running';
    case 'waiting': return 'waiting';
    case 'error': return 'error';
    default: return 'idle';
  }
}

/** Stopped as the rail shows it. An error keeps its own word and its colour,
 *  since its reason says more than the absence of a session does. */
export function shownStopped(agent: RoomAgent): boolean {
  return agent.stopped && agent.status !== 'error';
}

export function agentStatusLabel(agent: RoomAgent): string {
  if (!agent.hasEndOfTurn) return 'no turn signal';
  // Idle is an agent at rest between turns, still holding its session, so the
  // word is only replaced when there is no session to rest in.
  if (shownStopped(agent)) return 'stopped';
  return agent.status === 'completed' ? 'finished' : agent.status;
}

/** What the agent is on, in words.
 *
 *  Not `statusLine`: that is the last raw line its terminal printed, which for
 *  an idle CLI is its shell prompt (`Mac:tars-hermes noah$`). A prompt is not a
 *  description of work, and putting one here told the reader nothing while
 *  looking like it did. */
function detail(agent: RoomAgent): string {
  if (!agent.hasEndOfTurn) return 'Tars sees its output, not its turns';
  // Why it stopped before what it was asked. An agent whose turn failed still
  // has its task set, and the task came first here, so the reason this rail
  // was written to show only ever appeared for an agent that had no task.
  const reason = errorReason(agent);
  if (reason) return reason;
  // Before the task, which a stopped agent can still carry: it is on nothing.
  // And never `listening`, the word below for idle, which is exactly what an
  // agent with no session cannot do.
  if (shownStopped(agent)) return 'no live session';
  if (agent.currentTask) return agent.currentTask;
  switch (agent.status) {
    case 'running': return 'working';
    case 'waiting': return 'waiting on you';
    case 'error': return 'stopped on an error';
    case 'completed': return 'finished its turn';
    default: return 'listening';
  }
}

export function TeamRail({
  agents,
  pending,
  onOpen,
  onStop,
  onSend,
  onAdd,
}: {
  agents: RoomAgent[];
  /** Per agent: how many messages are waiting, and how many will not move
   *  without you. Both come from the bus, never from a guess. */
  pending: Record<string, { queued: number; notSent: number }>;
  onOpen: (agent: RoomAgent) => void;
  onStop: (agent: RoomAgent) => void;
  onSend: (agent: RoomAgent) => void;
  onAdd: () => void;
}) {
  return (
    <div className="w-[264px] shrink-0 flex flex-col gap-2.5 min-h-0">
      <div className="border border-border bg-card flex flex-col min-h-0">
        <div className="flex items-center justify-between h-8 pl-2.5 pr-[3px] border-b border-border shrink-0">
          <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
            the team · {agents.length}
          </span>
          <Button size="sm" className="font-mono" onClick={onAdd}>+ agent</Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {agents.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] leading-[1.5] text-muted-foreground">
              Nobody here yet. A new agent in this project shows up here with its status.
            </p>
          ) : agents.map(agent => {
            const waiting = pending[agent.id] ?? { queued: 0, notSent: 0 };
            const t = agentTone(agent);
            return (
              <div key={agent.id} className="flex gap-2 px-2.5 py-[9px] border-b border-border last:border-b-0">
                <span className="pt-1.5 shrink-0">
                  {t === 'none'
                    ? <span className="block w-1.5 h-1.5" />
                    : <StatusSquare tone={t} hollow={shownStopped(agent)} />}
                </span>
                <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[12.5px] text-foreground truncate">{agent.name ?? agent.id.slice(0, 8)}</span>
                    <span className="font-mono text-[9.5px] text-muted-foreground truncate">
                      {agent.provider ?? 'claude'}
                    </span>
                    <span className="flex-1" />
                    <span className="font-mono text-[10.5px] shrink-0 text-muted-foreground">{agentStatusLabel(agent)}</span>
                  </div>
                  {detail(agent) && (
                    <p className="text-[11px] leading-[1.45] text-muted-foreground line-clamp-2">{detail(agent)}</p>
                  )}
                  {(waiting.queued > 0 || waiting.notSent > 0) && (
                    <span className="font-mono text-[10px] leading-[1.5] text-text-secondary">
                      {waiting.queued > 0 && `${waiting.queued} queued for it`}
                      {waiting.queued > 0 && waiting.notSent > 0 && ' · '}
                      {waiting.notSent > 0 && `${waiting.notSent} not sent to it`}
                    </span>
                  )}
                  <div className="flex items-center gap-2 pt-[5px]">
                    <Button size="sm" className="font-mono" onClick={() => onOpen(agent)}>open</Button>
                    {/* Empties what is held for an agent whose CLI reports no
                        turn end, oldest first. It was drawn disabled while the
                        bus had no call for it; `releaseNotSent` exists now, so
                        the button does what it says instead of explaining why
                        it cannot. */}
                    {waiting.notSent > 0 && (
                      <Button
                        size="sm"
                        className="font-mono"
                        title={`Send the ${waiting.notSent === 1 ? 'message' : `${waiting.notSent} messages`} held for this agent, oldest first.`}
                        onClick={() => onSend(agent)}
                      >
                        send
                      </Button>
                    )}
                    {!agent.stopped && agent.status !== 'idle' && agent.status !== 'completed' && (
                      <Button size="sm" className="font-mono" onClick={() => onStop(agent)}>stop</Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border border-border bg-card shrink-0">
        <div className="flex items-center h-8 px-2.5 border-b border-border">
          <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">how this room runs</span>
        </div>
        {RULES.map(([key, value]) => (
          <div key={key} className="flex gap-2 px-2.5 py-1.5">
            <span className="w-10 shrink-0 font-mono text-[9.5px] leading-[1.72] text-muted-foreground">{key}</span>
            <span className="flex-1 min-w-0 text-[10.5px] leading-[1.55] text-text-secondary">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
