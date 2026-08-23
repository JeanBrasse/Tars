'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { Button, LoadingState, PageHeader, StatusSquare } from '@/components/ui';

// Row actions are words, not glyphs (R7): 26px bordered lowercase-mono
// buttons, 8px apart, in the same order on every row.
const ROW_ACTION = 'font-mono lowercase';

/**
 * Hermes schedules. Tars does not own a scheduler: the jobs, their timers and
 * their runs live in the gateway, and this page drives them over its API.
 */

interface CronJob {
  id: string;
  name?: string;
  title?: string;
  schedule?: string;
  schedule_human?: string;
  enabled?: boolean;
  paused?: boolean;
  status?: string;
  next_run?: string;
  next_run_at?: string;
  last_run?: string;
  last_status?: string;
  command?: string;
  prompt?: string;
  profile?: string;
  profile_name?: string;
}

function asJobs(payload: unknown): CronJob[] {
  if (Array.isArray(payload)) return payload as CronJob[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['jobs', 'items', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as CronJob[];
    }
  }
  return [];
}

export default function CronsPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.electronAPI?.hermes?.crons();
      if (!r) { setError('Electron API unavailable'); return; }
      if (!r.success) {
        setError(r.error || 'Could not read Hermes schedules');
        setNeedsSignIn(!!r.needsSignIn);
        return;
      }
      setNeedsSignIn(false);
      setJobs(asJobs(r.jobs));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll only while the window is visible: Hermes has no cron websocket.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const id = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  async function act(job: CronJob, action: 'pause' | 'resume' | 'trigger') {
    setBusyId(job.id);
    try {
      await window.electronAPI?.hermes?.cronAction({ action, jobId: job.id, profile: job.profile });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(job: CronJob) {
    if (!confirm(`Delete the schedule "${job.name || job.title || job.id}" in Hermes?`)) return;
    setBusyId(job.id);
    try {
      await window.electronAPI?.hermes?.cronDelete({ jobId: job.id, profile: job.profile });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col">
      <PageHeader
        title="Schedules"
        subtitle="Recurring jobs running in your Hermes gateway."
        actions={<Button size="md" onClick={load}>Refresh</Button>}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && jobs.length === 0 && (
          <LoadingState
            loading
            rows={4}
            what="Still reading the Hermes gateway…"
            detail="waiting on /api/cron/jobs"
          />
        )}

        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <AlertCircle className="w-6 h-6 text-warning" />
            <p className="text-sm text-foreground max-w-md">{error}</p>
            <div className="flex items-center gap-2">
              <Link
                href="/settings?section=hermes"
                className="inline-flex items-center justify-center h-8 px-3 text-sm font-medium border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {needsSignIn ? 'Sign in to Hermes' : 'Open Hermes settings'}
              </Link>
              <Button size="md" onClick={load}>Retry</Button>
            </div>
          </div>
        )}

        {!error && !loading && jobs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-sm text-muted-foreground">No schedule in this gateway yet.</p>
            <p className="text-xs text-muted-foreground">Create one in Hermes and it shows up here.</p>
          </div>
        )}

        <div className="space-y-2">
          {jobs.map(job => {
            const paused = job.paused === true || job.enabled === false || job.status === 'paused';
            const next = job.next_run_at || job.next_run;
            return (
              <div key={job.id} className="border border-border bg-card px-4 py-3 flex items-start gap-4">
                <StatusSquare tone={paused ? 'idle' : 'running'} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{job.name || job.title || job.id}</span>
                    {job.profile_name && (
                      <span className="text-[10px] font-mono px-1 bg-secondary text-muted-foreground">{job.profile_name}</span>
                    )}
                    {paused && <span className="text-[10px] font-mono text-muted-foreground">paused</span>}
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-0.5 truncate">
                    {job.schedule_human || job.schedule || 'no schedule'}
                    {next ? ` · next ${new Date(next).toLocaleString()}` : ''}
                    {job.last_status ? ` · last ${job.last_status}` : ''}
                  </p>
                  {(job.prompt || job.command) && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">{job.prompt || job.command}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    className={ROW_ACTION}
                    onClick={() => act(job, 'trigger')}
                    disabled={busyId === job.id}
                  >
                    run now
                  </Button>
                  <Button
                    size="sm"
                    className={ROW_ACTION}
                    onClick={() => act(job, paused ? 'resume' : 'pause')}
                    disabled={busyId === job.id}
                  >
                    {paused ? 'resume' : 'pause'}
                  </Button>
                  <Button
                    size="sm"
                    className={ROW_ACTION}
                    onClick={() => remove(job)}
                    disabled={busyId === job.id}
                  >
                    delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
