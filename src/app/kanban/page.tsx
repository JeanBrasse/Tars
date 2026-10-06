'use client';

import HermesBoard from '@/components/KanbanBoard/HermesBoard';

/**
 * Kanban is the Hermes board, full stop.
 *
 * The failure this replaces: the page offered a Hermes/Local segmented control
 * and remembered the pick in localStorage, so a user who only wants Hermes was
 * still asked every time, and a stale 'local' pick silently opened a different
 * board. Hermes owns the task harness, so there is nothing to choose.
 *
 * The local board itself was removed on 2026-10-06 (#332): no page mounted it,
 * and the bundled mcp-kanban server talks to the Hermes board through /api/kanban.
 */
export default function KanbanPage() {
  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      {/* HermesBoard draws the header, so "New task" sits beside the title
          rather than on a row of its own underneath it. */}
      <div className="flex-1 min-h-0">
        <HermesBoard subtitle="The Hermes board. Hermes owns the tasks, the workers and the runs." />
      </div>
    </div>
  );
}
