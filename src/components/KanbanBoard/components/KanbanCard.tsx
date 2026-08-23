'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'framer-motion';
import type { KanbanTask, KanbanColumn } from '@/types/kanban';

interface KanbanCardProps {
  task: KanbanTask;
  onEdit?: (task: KanbanTask) => void;
  onDelete?: (taskId: string) => void;
  onStart?: (taskId: string, column: KanbanColumn) => Promise<{ success: boolean }>;
  onOpenTerminal?: (agentId: string) => void;
  isDragging?: boolean;
  isBeingDragged?: boolean;
}

// Row actions are 26px bordered lowercase mono text buttons — never glyphs (R7)
const ACTION_CLASS =
  'h-[26px] px-2 border border-border font-mono text-[11px] lowercase text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors';

export function KanbanCard({ task, onEdit, onDelete, onStart, onOpenTerminal, isDragging, isBeingDragged }: KanbanCardProps) {
  // Disable drag for ongoing and done tasks
  const isOngoing = task.column === 'ongoing';
  const isDone = task.column === 'done';
  const isLocked = isOngoing || isDone;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({
    id: task.id,
    data: {
      type: 'task',
      task,
    },
    disabled: isLocked, // Disable drag for ongoing and done tasks
  });

  // Get project name from path
  const projectName = task.projectPath.split('/').pop() || task.projectId;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isTaskDragging = isDragging || isSortableDragging;
  const isAgentWorking = task.column === 'ongoing' && task.assignedAgentId;
  const isBacklog = task.column === 'backlog';

  // Handle start button click
  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onStart) {
      await onStart(task.id, 'planned');
    }
  };

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{
        opacity: isBeingDragged ? 0 : 1,
        y: 0,
        scale: isBeingDragged ? 0.95 : 1,
      }}
      exit={{ opacity: 0, scale: 0.95 }}
      onClick={() => onEdit?.(task)}
      {...attributes}
      {...listeners}
      className={`
        group relative bg-bg-tertiary p-3 transition-all duration-200
        border ${isAgentWorking ? 'border-border-accent' : 'border-border'}
        cursor-pointer hover:border-border-accent
        ${isTaskDragging ? 'scale-105 z-50 rotate-2' : ''}
        ${isDone ? 'opacity-70' : ''}
        ${isBeingDragged ? 'pointer-events-none' : ''}
      `}
    >
      {/* Start action for backlog tasks */}
      {isBacklog && onStart && (
        <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100">
          <button onClick={handleStart} className={ACTION_CLASS} title="Start task">
            start
          </button>
        </div>
      )}

      {/* Agent working marker + terminal/stop actions for ongoing tasks */}
      {isAgentWorking && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
          {onOpenTerminal && task.assignedAgentId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenTerminal(task.assignedAgentId!);
              }}
              className={ACTION_CLASS}
              title="View terminal"
            >
              terminal
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Stop this task and kill the agent?')) {
                onDelete?.(task.id);
              }
            }}
            className={`${ACTION_CLASS} opacity-0 group-hover:opacity-100`}
            title="Stop task"
          >
            stop
          </button>
          {/* Working indicator — 6px solid square (R5) */}
          <span className="w-1.5 h-1.5 bg-status-running" />
        </div>
      )}

      {/* Title */}
      <h4 className={`font-medium text-[13px] text-foreground line-clamp-2 font-sans ${isDone ? 'line-through opacity-60' : ''}`}>
        {task.title}
      </h4>

      {/* Progress bar for ongoing tasks */}
      {task.column === 'ongoing' && task.progress > 0 && (
        <div className="mt-2 h-1 bg-secondary overflow-hidden">
          <motion.div
            className="h-full bg-status-running"
            initial={{ width: 0 }}
            animate={{ width: `${task.progress}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      )}

      {/* Meta row: lowercase mono tag left, project right */}
      <div className="flex items-center gap-2 mt-2 text-[11px]">
        {task.labels.length > 0 && (
          <span className="font-mono lowercase text-muted-foreground truncate">{task.labels[0]}</span>
        )}
        <span className="ml-auto text-muted-foreground truncate">{projectName}</span>
      </div>
    </motion.div>
  );
}
