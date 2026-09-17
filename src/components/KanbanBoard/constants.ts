import type { KanbanColumn } from '@/types/kanban';

export const COLUMN_CONFIG: Record<KanbanColumn, {
  title: string;
  emptyText: string;
}> = {
  backlog: {
    title: 'TODO',
    emptyText: 'No tasks yet',
  },
  planned: {
    title: 'PLANNED',
    emptyText: 'Drop tasks here',
  },
  ongoing: {
    title: 'IN WORK',
    emptyText: 'No tasks in progress',
  },
  done: {
    title: 'COMPLETED',
    emptyText: 'No completed tasks',
  },
};

export const COLUMN_ORDER: KanbanColumn[] = ['backlog', 'planned', 'ongoing', 'done'];
