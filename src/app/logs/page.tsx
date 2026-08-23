'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Terminal } from 'lucide-react';
import { SquarePulse } from '@/components/Splash';
import { PageHeader, Panel, PanelCaption } from '@/components/ui';
import type { FleetEntry, LogLine } from '@/types/electron';

/**
 * One search box for the whole fleet.
 *
 * Each agent's output lived only in its own terminal, so finding which agent
 * hit an error meant opening every one of them. A plain substring works, and
 * /regex/ is honoured when the query is delimited.
 */

const STATUS_TONE: Record<string, string> = {
  running: 'text-status-running',
  waiting: 'text-status-waiting',
  error: 'text-status-error',
  idle: 'text-status-idle',
};

export default function LogsPage() {
  const [query, setQuery] = useState('');
  const [fleet, setFleet] = useState<FleetEntry[]>([]);
  const [results, setResults] = useState<LogLine[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [tail, setTail] = useState<{ lines: string[]; agentName: string } | null>(null);
  const debounce = useRef<NodeJS.Timeout | null>(null);
  // Bumped on every search kicked off; a resolving search whose id no longer
  // matches is stale and must not overwrite a newer one's results.
  const searchSeq = useRef(0);

  const loadFleet = useCallback(async () => {
    const res = await window.electronAPI?.logs?.fleet();
    setFleet(res?.agents ?? []);
  }, []);

  useEffect(() => {
    void loadFleet();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void loadFleet();
    }, 10_000);
    return () => clearInterval(id);
  }, [loadFleet]);

  const runSearch = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await window.electronAPI?.logs?.search(q, { limit: 300 });
      if (seq !== searchSeq.current) return; // a newer search or an agent click superseded this one
      setResults(res?.lines ?? []);
      setScanned(res?.scannedAgents ?? 0);
      setTruncated(!!res?.truncated);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runSearch(query), 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, runSearch]);

  const openAgent = useCallback(async (agentId: string) => {
    // Invalidate any in-flight/pending search so it can't clobber the tail
    // view we're about to show, and drop out of the results branch so the
    // render actually switches to the tail (results !== null wins otherwise).
    searchSeq.current++;
    setSearching(false);
    setResults(null);
    setFocused(agentId);
    const res = await window.electronAPI?.logs?.tail(agentId, 300);
    setTail(res ?? null);
  }, []);

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <PageHeader
        title="Logs"
        subtitle="Search every agent's output at once. Wrap the query in slashes for a regex."
      />

      {/* The query and what it found share one row: the count is about the
          search, so it reads at the end of the thing it counts. */}
      <div className="relative mb-3 shrink-0">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="error, ECONNREFUSED, /TypeError.*undefined/"
          className="w-full h-8 pl-8 pr-56 bg-secondary border border-border text-[15px] focus:border-primary/40 focus:outline-none"
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {searching && <SquarePulse count={3} size={4} />}
          {results !== null && (
            <span className="text-[11px] text-muted-foreground truncate">
              {results.length} match{results.length === 1 ? '' : 'es'} across {scanned} agent
              {scanned === 1 ? '' : 's'}
              {truncated ? ' (showing the first 300)' : ''}
            </span>
          )}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex gap-3">
        {/* Fleet */}
        <Panel fill className="w-[250px] shrink-0">
          <PanelCaption>
            {fleet.length} agent{fleet.length === 1 ? '' : 's'}
          </PanelCaption>
          <div className="flex-1 min-h-0 overflow-y-auto mt-2 space-y-2">
            {fleet.map(a => (
              <button
                key={a.agentId}
                onClick={() => openAgent(a.agentId)}
                className={`w-full text-left h-[52px] px-2.5 flex flex-col justify-center gap-1 border transition-colors ${
                  a.agentId === focused
                    ? 'bg-secondary border-border-accent'
                    : 'bg-card border-border hover:border-border-accent'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xs text-foreground truncate">{a.agentName}</span>
                  <span className={`text-[10px] shrink-0 ${STATUS_TONE[a.status] ?? 'text-muted-foreground'}`}>
                    {a.status}
                  </span>
                </span>
                <span className="block text-[10px] text-muted-foreground truncate font-mono">
                  {a.branch || a.projectPath.split('/').pop()} · {a.lines} chunks
                </span>
              </button>
            ))}
            {fleet.length === 0 && (
              <p className="text-xs text-muted-foreground">No agent has produced output yet.</p>
            )}
          </div>
        </Panel>

        {/* Results or tail */}
        <Panel fill padded={false} className="flex-1 min-w-0">
          <div className="flex-1 min-h-0 overflow-auto p-4">
            {results !== null ? (
              <div className="space-y-1">
                {results.map((line, i) => (
                  <button
                    key={`${line.agentId}-${line.position}-${i}`}
                    onClick={() => openAgent(line.agentId)}
                    className="w-full text-left px-2 py-1 hover:bg-secondary/60 transition-colors"
                  >
                    <span className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] text-primary">{line.agentName}</span>
                      <span className="text-[10px] text-muted-foreground font-mono truncate">
                        {line.branch || line.projectPath.split('/').pop()}
                      </span>
                    </span>
                    <span className="block text-[11px] font-mono text-foreground break-all">{line.line}</span>
                  </button>
                ))}
                {results.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Nothing matched. Only what agents have produced this session is searchable.
                  </p>
                )}
              </div>
            ) : tail ? (
              <>
                <p className="text-xs font-mono text-foreground mb-2">{tail.agentName}: last {tail.lines.length} lines</p>
                <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap break-all">
                  {tail.lines.join('\n')}
                </pre>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                <Terminal className="w-6 h-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">Search, or pick an agent to read its tail.</p>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
