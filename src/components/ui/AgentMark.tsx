'use client';

import { agentMarkCells } from '@/lib/agent-mark';

/**
 * The box and its squares at each size, in whole pixels so the grid lands
 * on the pixel grid: 16 is squares of 3 with gaps of 1, 24 squares of 5.
 */
const SIZES = {
  16: 'w-4 h-4 grid-cols-[repeat(4,3px)] grid-rows-[repeat(4,3px)]',
  24: 'w-6 h-6 grid-cols-[repeat(4,5px)] grid-rows-[repeat(4,5px)]',
} as const;

/**
 * An agent's mark: the 4x4 grid of squares its name draws
 * (`agentMarkCells`), lit in text-secondary, or in the accent for the
 * orchestrator, unlit in surface-raised. It leads every row that names an
 * agent and stands for the name beside it, so assistive tech is sent to the
 * name and skips the mark. Frame: `Agent mark` in design/tars-redesign.pen.
 */
export function AgentMark({ name, orchestrator = false, size = 16, className = '' }: {
  name: string;
  /** The agent holds its project's orchestrator role: the one orange mark. */
  orchestrator?: boolean;
  size?: 16 | 24;
  className?: string;
}) {
  const lit = orchestrator ? 'bg-primary' : 'bg-text-secondary';
  return (
    <span
      aria-hidden
      data-agent-mark={orchestrator ? 'orchestrator' : 'agent'}
      className={`inline-grid gap-px place-content-center shrink-0 ${SIZES[size]} ${className}`}
    >
      {agentMarkCells(name).map((on, i) => (
        <span key={i} className={on ? lit : 'bg-bg-tertiary'} />
      ))}
    </span>
  );
}
