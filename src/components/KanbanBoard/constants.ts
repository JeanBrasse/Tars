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

export const PRIORITY_CONFIG: Record<string, {
  label: string;
  textColor: string;
  bgColor: string;
}> = {
  low: {
    label: 'Low',
    textColor: 'text-zinc-600 dark:text-zinc-400',
    bgColor: 'bg-zinc-100 dark:bg-zinc-800',
  },
  medium: {
    label: 'Medium',
    textColor: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-50 dark:bg-amber-900/30',
  },
  high: {
    label: 'High',
    textColor: 'text-red-600 dark:text-red-400',
    bgColor: 'bg-red-50 dark:bg-red-900/30',
  },
};
