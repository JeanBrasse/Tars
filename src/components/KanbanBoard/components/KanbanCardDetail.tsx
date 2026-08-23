'use client';

import { useState } from 'react';
import type { KanbanColumn, KanbanTask } from '@/types/kanban';
import { Button, DialogShell, Dropdown, MetaChip, PanelCaption } from '@/components/ui';
import { COLUMN_CONFIG, COLUMN_ORDER } from '../constants';

interface KanbanCardDetailProps {
  task: KanbanTask;
  onClose: () => void;
  onUpdate: (data: Partial<KanbanTask>) => Promise<void>;
  onDelete: () => void;
  /**
   * Advances the task to another column. `kanban:update` only writes the task's
   * own fields and drops `column`, so moving is a separate IPC call the board
   * owns. Without it the COLUMN dropdown and the advancing primary stay off and
   * the footer keeps its Save button.
   */
  onMove?: (column: KanbanColumn) => Promise<void> | void;
}

/** `41m ago`, `3h ago`, `2 days ago` - the card only ever shows one of these. */
function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const columnLabel = (column: KanbanColumn) => COLUMN_CONFIG[column].title.toLowerCase();

export function KanbanCardDetail({ task, onClose, onUpdate, onDelete, onMove }: KanbanCardDetailProps) {
  const [description, setDescription] = useState(task.description);
  const [isSaving, setIsSaving] = useState(false);

  const hasChanges = description !== task.description;

  // The column the primary advances to. `done` has nowhere to go, and this
  // dialog is never opened on it anyway.
  const nextColumn = COLUMN_ORDER[COLUMN_ORDER.indexOf(task.column) + 1];
  const canAdvance = Boolean(onMove && nextColumn);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onUpdate({ description: description.trim() });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnassign = async () => {
    setIsSaving(true);
    try {
      await onUpdate({ assignedAgentId: null });
    } finally {
      setIsSaving(false);
    }
  };

  const handleMove = async (column: KanbanColumn) => {
    if (!onMove) return;
    setIsSaving(true);
    try {
      if (hasChanges) await onUpdate({ description: description.trim() });
      await onMove(column);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DialogShell
      onClose={onClose}
      title={task.title}
      subtitle={`${columnLabel(task.column)} · ${task.projectId} · created ${relativeTime(task.createdAt)}`}
      footerLeft={
        <>
          <Button variant="danger" onClick={onDelete}>Delete</Button>
          <Button
            variant="ghost"
            onClick={handleUnassign}
            disabled={!task.assignedAgentId || isSaving}
          >
            Unassign
          </Button>
        </>
      }
      footerRight={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {canAdvance ? (
            <Button variant="primary" onClick={() => handleMove(nextColumn)} disabled={isSaving}>
              {isSaving ? 'Moving…' : `Move to ${columnLabel(nextColumn)}`}
            </Button>
          ) : (
            <Button variant="primary" onClick={handleSave} disabled={!hasChanges || isSaving}>
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {/* Tags left, the one thing that actually changed on this task right */}
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {task.labels.map((label) => (
              <MetaChip key={label}>{label}</MetaChip>
            ))}
          </div>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">
            moved to {columnLabel(task.column)} {relativeTime(task.updatedAt)}
          </span>
        </div>

        <div className="space-y-1.5">
          <PanelCaption>Description</PanelCaption>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What needs doing?"
            rows={5}
            className="w-full bg-bg-tertiary border border-border px-3 py-2.5 text-[12.5px] leading-[1.5] resize-none placeholder:text-muted-foreground"
          />
        </div>

        {onMove && (
          <div className="space-y-1.5">
            <PanelCaption>Column</PanelCaption>
            <Dropdown<KanbanColumn>
              value={task.column}
              options={COLUMN_ORDER.map((column) => ({ value: column, label: columnLabel(column) }))}
              onChange={handleMove}
              className="w-48"
            />
          </div>
        )}
      </div>
    </DialogShell>
  );
}
