'use client';

import { StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import type { OverseerFleetAgent, OverseerFleetSnapshot } from '@/types/electron';

/** Raw fleet status vocabulary folded onto the four the app draws everywhere. */
function tone(status: string): StatusTone {
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'waiting';
  if (status === 'error') return 'error';
  return 'idle';
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h${rem ? ` ${rem}m` : ''}`;
}

/** The last path segment, so a full worktree path reads as a project name
 *  the way the rest of the fleet listing does. */
function projectLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function statusLine(agent: OverseerFleetAgent): string {
  switch (agent.status) {
    case 'running': return `running ${formatDuration(agent.statusDurationMs)}`;
    case 'waiting': return `waiting ${formatDuration(agent.statusDurationMs)}`;
    case 'error': return 'error';
    case 'completed': return 'finished';
    default: return 'idle';
  }
}

function whatItsOn(agent: OverseerFleetAgent): string {
  const base = statusLine(agent);
  const firstLine = agent.recentOutput.split('\n').map(l => l.trim()).find(Boolean);
  return firstLine ? `${base} · ${firstLine}` : base;
}

function FleetRow({ agent }: { agent: OverseerFleetAgent }) {
  return (
    <div className="flex items-start gap-2 px-2.5 py-[9px] border-b border-border">
      <StatusSquare tone={tone(agent.status)} className="mt-1.5" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11.5px] text-foreground truncate">{agent.name}</span>
          <span className="font-mono text-[9.5px] text-muted-foreground truncate">
            {projectLabel(agent.projectPath)}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground truncate">{whatItsOn(agent)}</p>
      </div>
    </div>
  );
}

function ReachRow({ mode, children }: { mode: 'read' | 'write'; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-[6px] border-b border-border last:border-b-0">
      <span className={`w-8 shrink-0 font-mono text-[9.5px] ${mode === 'write' ? 'text-primary' : 'text-muted-foreground'}`}>
        {mode}
      </span>
      <span className="flex-1 min-w-0 text-[10.5px] text-text-secondary truncate">{children}</span>
    </div>
  );
}

/**
 * The right rail: every agent Hermes is watching, and the exact, fixed set
 * of things it can read or write. The write list is one line - "one agent,
 * named, after you confirm" - on purpose: that is the entire write surface
 * this feature has, not a sample of a larger one.
 */
export function FleetRail({ fleet }: { fleet: OverseerFleetSnapshot | null }) {
  const agents = fleet?.agents ?? [];

  return (
    <div className="w-[332px] shrink-0 flex flex-col gap-2.5 min-h-0">
      <div className="border border-border bg-card flex flex-col min-h-0" style={{ flex: '1 1 60%' }}>
        <div className="flex items-center justify-between px-2.5 h-8 border-b border-border shrink-0">
          <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">the fleet</span>
          <span className="font-mono text-[10px] text-muted-foreground">{agents.length} agents</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {agents.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground">No agents running in any project.</p>
          ) : (
            agents.map(a => <FleetRow key={a.id} agent={a} />)
          )}
        </div>
      </div>

      <div className="border border-border bg-card flex flex-col shrink-0">
        <div className="flex items-center px-2.5 h-8 border-b border-border">
          <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">what it can reach</span>
        </div>
        <div>
          <ReachRow mode="read">every agent&apos;s recent output, across projects</ReachRow>
          <ReachRow mode="read">git status and branch, per project</ReachRow>
          <ReachRow mode="write">one agent, named, after you confirm</ReachRow>
        </div>
      </div>
    </div>
  );
}
