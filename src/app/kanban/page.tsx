'use client';

import { useEffect, useState } from 'react';
import KanbanBoard from '@/components/KanbanBoard';
import HermesBoard from '@/components/KanbanBoard/HermesBoard';
import { PageHeader, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';

type Source = 'hermes' | 'local';

const SOURCE_KEY = 'dorothy-kanban-source';

const SOURCES: readonly SegmentedOption<Source>[] = [
  { value: 'hermes', label: 'Hermes' },
  { value: 'local', label: 'Local' },
];

export default function KanbanPage() {
  // Hermes owns the task harness, so it is the default board; the local board
  // stays available for projects that aren't driven by a gateway.
  const [source, setSource] = useState<Source>('hermes');

  useEffect(() => {
    const saved = localStorage.getItem(SOURCE_KEY);
    if (saved === 'local' || saved === 'hermes') setSource(saved);
  }, []);

  function pick(next: Source) {
    setSource(next);
    localStorage.setItem(SOURCE_KEY, next);
  }

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col">
      <PageHeader
        title="Kanban"
        subtitle="Task board. Hermes runs the work; the local board is for projects without a gateway."
        actions={
          <SegmentedControl
            options={SOURCES}
            value={source}
            onChange={pick}
            ariaLabel="Board source"
          />
        }
      />

      <div className="flex-1 min-h-0">
        {source === 'hermes' ? <HermesBoard /> : <KanbanBoard />}
      </div>
    </div>
  );
}
