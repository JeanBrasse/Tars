'use client';

import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { motion, AnimatePresence } from 'framer-motion';
import type { KanbanTask, KanbanColumn as KanbanColumnType } from '@/types/kanban';
import { Panel, PanelCaption } from '@/components/ui';
import { KanbanCard } from './KanbanCard';
import { COLUMN_CONFIG } from '../constants';

interface KanbanColumnProps {
  column: KanbanColumnType;
  tasks: KanbanTask[];
  onAddTask?: () => void;
  onEditTask?: (task: KanbanTask) => void;
  onDeleteTask?: (taskId: string) => void;
  onStartTask?: (taskId: string, column: KanbanColumnType) => Promise<{ success: boolean }>;
  onOpenTerminal?: (agentId: string) => void;
  activeTaskId?: string;
}

export function KanbanColumn({
  column,
  tasks,
  onAddTask,
  onEditTask,
  onDeleteTask,
  onStartTask,
  onOpenTerminal,
  activeTaskId,
}: KanbanColumnProps) {
  const config = COLUMN_CONFIG[column];

  const { setNodeRef, isOver } = useDroppable({
    id: column,
    data: {
      type: 'column',
      column,
    },
  });

  return (
    // One bordered track: the header band and the cards live inside the same
    // box, so an empty column still reads as a drop target.
    <Panel fill padded={false} className="flex-1 min-w-[200px]">
      {/* Column header band */}
      <div className="flex items-center justify-between gap-2 p-3">
        <PanelCaption>{config.title}</PanelCaption>
        <span className="text-[11px] text-muted-foreground">{tasks.length}</span>
      </div>

      {/* Tasks container */}
      <div
        ref={setNodeRef}
        className={`
          flex-1 min-h-0 space-y-2 overflow-y-auto p-3 pt-0
          transition-colors duration-200
          ${isOver ? 'bg-accent-dim' : ''}
        `}
      >
        <SortableContext
          items={tasks.map(t => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <AnimatePresence mode="popLayout">
            {tasks.length > 0 ? (
              tasks.map((task) => (
                <KanbanCard
                  key={task.id}
                  task={task}
                  onEdit={onEditTask}
                  onDelete={onDeleteTask}
                  onStart={column === 'backlog' ? onStartTask : undefined}
                  onOpenTerminal={column === 'ongoing' ? onOpenTerminal : undefined}
                  isBeingDragged={task.id === activeTaskId}
                />
              ))
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center py-12 text-muted-foreground/50 text-sm"
              >
                {config.emptyText}
              </motion.div>
            )}
          </AnimatePresence>
        </SortableContext>
      </div>
    </Panel>
  );
}
