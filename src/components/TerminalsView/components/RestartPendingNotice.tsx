'use client';

import { StatusSquare } from '@/components/ui';
import type { AgentPendingRestart, AgentRestartWait } from '@/types/electron';

type Pending = Omit<AgentPendingRestart, 'agentId'>;

/** A launch setting as the line names it. */
const SETTING: Record<string, string> = {
  model: 'model',
  effort: 'effort',
  permissionMode: 'permissions',
  orchestrator: 'the orchestrator role',
  secondaryProjectPath: 'the second project',
  obsidianVaultPaths: 'the vaults',
  localModel: 'the local model',
};

/**
 * What the restart waits on, as the end of the sentence. The nine waits of
 * electron/core/agent-restart.ts, in the words of `AgentRestartWait`'s own
 * comment. `draft` is the one only the person at the keyboard ends.
 */
const WAIT: Record<AgentRestartWait, string> = {
  turn: 'it waits for this turn to end.',
  permission: 'it waits for its permission question to be answered.',
  note: 'it waits for a note owed to it to go in.',
  background: 'it waits for the work it left running to report back.',
  launch: 'it waits for its CLI to finish starting.',
  draft: 'it waits for you: send or clear what is typed in its field.',
  typing: 'it waits until nothing has been typed in its field for five seconds.',
  queued: 'it waits for the messages queued for its field to go in.',
  writing: 'it waits for the message Tars is typing into it to go in.',
};

function joined(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The line in two halves: what changed, then what the restart waits on. */
export function restartPendingLine({ settings, waitingFor }: Pending): { who: string; rest: string } {
  const names = joined((settings ?? []).map(setting => SETTING[setting] ?? setting));
  return {
    who: names ? `Restart pending for ${names}:` : 'Restart pending:',
    rest: WAIT[waitingFor] ?? 'it waits for the agent to be free.',
  };
}

/**
 * The line a panel shows while a changed setting waits to restart its agent.
 * Frame: `Restart pending · notice`.
 *
 * The row of MessageWaitingNotice and LeftFullscreenNotice, 26 high under the
 * header, and cut rather than wrapped. It asks nothing of anyone except in
 * `draft`, whose sentence says what to do, so it carries no action: the
 * restart happens on its own, and the line goes when it has.
 */
export default function RestartPendingNotice({ pending }: { pending: Pending }) {
  const { who, rest } = restartPendingLine(pending);
  return (
    <div
      role="status"
      title={`${who} ${rest}`}
      className="h-[26px] shrink-0 flex items-center gap-2 px-3 bg-secondary border-b border-border select-none"
    >
      <StatusSquare tone="waiting" />
      <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground">
        <span className="text-foreground">{who}</span> {rest}
      </p>
    </div>
  );
}
