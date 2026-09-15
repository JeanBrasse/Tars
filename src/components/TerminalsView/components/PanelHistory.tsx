'use client';

import { Fragment, useMemo } from 'react';
import { Button } from '@/components/ui';
import type { TranscriptMessage } from '@/types/electron';
import { usePanelTranscript } from '../hooks/usePanelTranscript';

/**
 * What a row actually is, which the record's own `role` does not tell you.
 *
 * Nine `user` records in ten are a tool's answer wearing the user's role, so
 * rendering by role puts a wall of tool output on screen under the word "you".
 * `toolResult` is what says a record is a tool answering, and `toolCalls` is
 * what says the agent reached for one. Role only decides between the two kinds
 * of speech once the machinery has been taken out.
 */
type Kind = 'you' | 'agent' | 'tool';

function kindOf(message: TranscriptMessage): Kind {
  if (message.toolResult) return 'tool';
  return message.role === 'assistant' ? 'agent' : 'you';
}

/**
 * Three levels of the neutral ramp, not three colours: what a person said, what
 * the agent answered, and machinery. The accent is not spent here.
 */
const TONE: Record<Kind, string> = {
  you: 'text-muted-foreground',
  agent: 'text-foreground',
  tool: 'text-muted-foreground',
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Absolute and locale-free: a relative word would go stale on screen. */
function dayLabel(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** One line, whatever the tool wrote. A result is machinery, not an answer. */
function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim().length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

interface Row {
  key: string;
  /** A day changed above this row. */
  day?: string;
  time: string;
  tag: string;
  kind: Kind;
  text: string;
  mono?: boolean;
  error?: boolean;
  truncated?: boolean;
}

/**
 * Messages flattened into the rows the panel draws.
 *
 * A successful tool result is dropped: the call above it already names what ran
 * and on what, and the agent's next message says what came of it, so keeping
 * the body would flood a twenty four line panel with output nobody reads. A
 * failed one is kept, because a failure is news.
 */
function toRows(messages: TranscriptMessage[]): Row[] {
  const rows: Row[] = [];
  let day = '';

  for (const message of messages) {
    const stamp = message.timestamp ? new Date(message.timestamp) : null;
    const valid = stamp && !Number.isNaN(stamp.getTime());
    const time = valid ? clock(stamp) : '';
    const key = valid ? dayKey(stamp) : '';
    const dayBreak = valid && key !== day ? dayLabel(stamp) : undefined;
    if (dayBreak) day = key;

    const kind = kindOf(message);
    const speech = message.text.trim();

    if (kind === 'tool') {
      if (message.toolResult?.isError) {
        rows.push({
          key: message.id, day: dayBreak, time, tag: 'failed', kind: 'tool',
          text: firstLine(speech) || 'the tool reported an error', mono: true, error: true,
        });
      } else if (dayBreak) {
        // The day still has to break somewhere, even on a row we drop.
        const next = rows[rows.length - 1];
        if (next) next.day = next.day ?? dayBreak;
        else rows.push({ key: `${message.id}-day`, day: dayBreak, time: '', tag: '', kind: 'tool', text: '' });
      }
      continue;
    }

    if (speech) {
      rows.push({
        key: message.id, day: dayBreak, time, tag: kind === 'you' ? 'you' : 'agent',
        kind, text: speech, truncated: message.truncated,
      });
    }

    for (const call of message.toolCalls ?? []) {
      rows.push({
        key: `${message.id}-${call.id}`,
        day: speech ? undefined : dayBreak,
        time: speech ? '' : time,
        tag: 'tool', kind: 'tool',
        text: `${call.name}  ${call.summary}`.trim(), mono: true,
      });
    }
  }

  return rows;
}

function Skeleton() {
  // The real shape of a row, so nothing jumps when the messages land.
  const widths = ['62%', '84%', '48%', '71%', '38%', '79%'];
  return (
    <div className="space-y-4 px-3 py-3" aria-hidden>
      {widths.map((w, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <span className="h-2 w-8 bg-secondary shrink-0" />
          <span className="h-2 w-9 bg-secondary shrink-0" />
          <span className="h-2 bg-secondary" style={{ width: w }} />
        </div>
      ))}
    </div>
  );
}

function Centered({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2.5 px-10 py-6 text-center">
      <p className="text-xs font-medium text-foreground">{title}</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground max-w-[460px]">{body}</p>
    </div>
  );
}

/**
 * The agent's conversation, beside the live terminal rather than instead of it.
 *
 * The terminal underneath stays mounted and untouched: a full-screen CLI holds
 * the alternate screen, that view does not scroll, and this one does not try to
 * repair it. It reads the journal Claude Code writes line by line instead.
 */
export default function PanelHistory({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { loading, loadingOlder, messages, hasMore, unavailable, error, loadOlder, refresh } =
    usePanelTranscript(agentId, true);

  const rows = useMemo(() => toRows(messages), [messages]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <span className="text-[10.5px] font-mono text-muted-foreground truncate">
          {agentName} · snapshot
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10.5px] font-mono text-muted-foreground">
            {messages.length} {messages.length === 1 ? 'message' : 'messages'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="font-mono lowercase"
            onClick={refresh}
            disabled={loading}
            title="Read the transcript again. This view is a snapshot: it does not follow the agent while it works."
          >
            refresh
          </Button>
        </div>
      </div>

      {unavailable ? (
        <Centered title="No conversation to show" body={unavailable.detail} />
      ) : error ? (
        <Centered title="The transcript could not be read" body={error} />
      ) : loading && !messages.length ? (
        <Skeleton />
      ) : !rows.length ? (
        <Centered
          title="Nothing said yet"
          body="This agent has a session but has not exchanged a message in it. The live view shows what it is doing."
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">
          {hasMore && (
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingOlder}
              className="w-full h-[26px] mb-2.5 border border-border text-[11px] font-mono lowercase text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loadingOlder ? 'loading' : 'load older'}
            </button>
          )}
          {rows.map((row) => (
            <Fragment key={row.key}>
              {row.day && (
                <div className="flex items-center gap-2 pt-2 pb-1.5 first:pt-0">
                  <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground shrink-0">
                    {row.day}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              {row.text && (
                <div className="flex items-start gap-2.5 py-[3px]">
                  <span className="w-8 shrink-0 text-[10.5px] font-mono text-muted-foreground leading-relaxed">
                    {row.time}
                  </span>
                  <span
                    className={`w-10 shrink-0 text-[10.5px] font-mono leading-relaxed ${
                      row.error ? 'text-danger' : TONE[row.kind]
                    }`}
                  >
                    {row.tag}
                  </span>
                  {/* Machinery is clamped to one line: a tool's own summary can
                      be a whole shell command, and three wrapped lines of it
                      buries the answer that follows. Speech wraps freely. */}
                  <span
                    title={row.mono ? row.text : undefined}
                    className={`min-w-0 flex-1 leading-relaxed ${
                      row.mono ? 'text-[10.5px] font-mono truncate' : 'text-[11.5px] whitespace-pre-wrap break-words'
                    } ${row.error ? 'text-danger' : TONE[row.kind]}`}
                  >
                    {row.text}
                    {row.truncated && (
                      <span className="text-muted-foreground"> … cut at 4000 characters</span>
                    )}
                  </span>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
