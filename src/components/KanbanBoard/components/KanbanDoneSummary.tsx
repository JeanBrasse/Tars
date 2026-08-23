'use client';

import { Button, DialogShell, PanelCaption } from '@/components/ui';
import type { KanbanTask } from '@/types/kanban';

interface KanbanDoneSummaryProps {
  task: KanbanTask;
  onClose: () => void;
  onDelete: () => void;
}

export function KanbanDoneSummary({ task, onClose, onDelete }: KanbanDoneSummaryProps) {
  const projectName = task.projectPath.split('/').pop() || task.projectId;

  // Everything the old header and the old meta footer carried, as one muted
  // line: the green banner, the CheckCircle2 and the Clock icon were three
  // decorations on top of two dates.
  const meta = [
    projectName,
    `created ${new Date(task.createdAt).toLocaleDateString()}`,
    task.completedAt && `completed ${new Date(task.completedAt).toLocaleDateString()}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <DialogShell
      onClose={onClose}
      width={720}
      title={task.title}
      subtitle={meta}
      footerLeft={
        <Button size="sm" variant="danger" className="font-mono lowercase" onClick={onDelete}>
          delete
        </Button>
      }
      footerRight={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {task.description && (
          <div>
            <PanelCaption>Original request</PanelCaption>
            <p className="mt-2 bg-bg-tertiary px-3 py-2.5 text-[12.5px] leading-[1.5] text-muted-foreground">
              {task.description}
            </p>
          </div>
        )}

        <div>
          <PanelCaption>Agent output</PanelCaption>
          <div className="mt-2 bg-bg-tertiary px-3 py-2.5">
            {task.completionSummary ? (
              <pre className="whitespace-pre-wrap font-mono text-xs text-foreground">
                {task.completionSummary}
              </pre>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">no output captured</p>
            )}
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
