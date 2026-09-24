'use client';

import { Button, DialogShell } from '@/components/ui';

/** Which save is waiting on the answer: each says what happens in its own words. */
export type ReplaceKind = 'edit' | 'create' | 'team';

export interface PendingReplace {
  kind: ReplaceKind;
  /** The agent that holds the role now, and loses it. */
  holder: string;
  /** The agent that takes it. */
  newcomer: string;
  /** The project's folder name. */
  project: string;
}

/** What happens if the save goes ahead, as the frame `Orchestrator role · states` words each case. */
export function replaceConsequence(p: PendingReplace): string {
  const after = 'restarts once it is free, or takes the change at its next start.';
  switch (p.kind) {
    case 'edit':
      return `If you save, ${p.newcomer} takes the role and ${p.holder} becomes a worker. Each ${after}`;
    case 'create':
      return `If you create ${p.newcomer}, it takes the role and ${p.holder} becomes a worker. ${p.holder} ${after}`;
    case 'team':
      return `If you deploy this team, ${p.newcomer} takes the role and ${p.holder} becomes a worker. ${p.holder} ${after}`;
  }
}

/**
 * Asked before a save gives the orchestrator role to an agent while another
 * agent of the same project holds it. Frames: `Overlay · Replace the
 * orchestrator`, `Orchestrator role · states`.
 *
 * A project has one orchestrator, and the main process enforces it whatever
 * the renderer sends: the agent being saved takes the role and the other one
 * becomes a worker. So the question is asked before the save, and it names the
 * agent that loses the role, the one thing the person saving cannot see from
 * the dialog they are in.
 */
export function ReplaceOrchestratorDialog({ pending, onCancel, onReplace }: {
  pending: PendingReplace;
  onCancel: () => void;
  onReplace: () => void;
}) {
  return (
    // Above the dialog it answers for, which sits at z-70, the way the skill
    // install terminal is.
    <div className="relative z-[80]">
      <DialogShell
        onClose={onCancel}
        title={`Replace the orchestrator of ${pending.project}?`}
        footerRight={
          <>
            <Button size="md" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" size="md" onClick={onReplace}>Replace</Button>
          </>
        }
      >
        <div className="space-y-1.5 text-sm leading-[1.55]">
          <p className="text-foreground">{pending.holder} is the orchestrator of {pending.project}.</p>
          <p className="text-muted-foreground">{replaceConsequence(pending)}</p>
        </div>
      </DialogShell>
    </div>
  );
}
