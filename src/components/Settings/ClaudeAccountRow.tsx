'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import type { ClaudeAccountState, ClaudeAccountWindow } from '@/types/electron';
import { accountFolder, accountWord, formatReset, isThreshold, meterTone, whoLine, type AccountNote, type MeterTone } from '@/lib/claude-accounts';
import { Toggle } from './Toggle';

const WORD_INK = { idle: 'text-muted-foreground', running: 'text-status-running', waiting: 'text-status-waiting' } as const;
const NOTE_INK: Record<AccountNote['tone'], string> = {
  muted: 'text-muted-foreground',
  secondary: 'text-text-secondary',
  waiting: 'text-status-waiting',
  error: 'text-status-error',
};
const BAR_INK: Record<MeterTone, string> = { normal: 'bg-primary', near: 'bg-status-waiting', full: 'bg-status-error' };
const VALUE_INK: Record<MeterTone, string> = { normal: 'text-text-secondary', near: 'text-status-waiting', full: 'text-status-error' };

/**
 * One window of an account's use: 5 h or the week. The bar is its use, the tick
 * its threshold; past the tick the bar takes the waiting colour, at the limit
 * the error colour. Frames: `Settings · Claude accounts · states`.
 */
export function UsageMeter({ label, window, threshold }: { label: string; window: ClaudeAccountWindow; threshold: number }) {
  const pct = Math.round(window.usedPercentage);
  const tone = meterTone(window.usedPercentage, threshold);
  return (
    <div className="flex items-center gap-2">
      <span className="w-[30px] shrink-0 font-mono text-[10.5px] text-muted-foreground">{label}</span>
      <span className="relative w-[190px] h-[9px] shrink-0">
        <span className="absolute inset-x-0 top-[2px] h-[5px] bg-secondary" />
        <span data-meter="used" className={`absolute left-0 top-[2px] h-[5px] ${BAR_INK[tone]}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        <span data-meter="threshold" className="absolute top-0 h-[9px] w-px bg-muted-foreground" style={{ left: `${threshold}%` }} />
      </span>
      <span className={`font-mono text-[10.5px] whitespace-nowrap ${VALUE_INK[tone]}`}>{`${pct}% · resets ${formatReset(window.resetsAt, new Date())}`}</span>
    </div>
  );
}

interface ClaudeAccountRowProps {
  account: ClaudeAccountState;
  /** 1 for the first row. */
  position: number;
  first: boolean;
  last: boolean;
  fiveHourThreshold: number;
  weeklyThreshold: number;
  /** What the page has to say about it: why it takes no agent, or where they go. */
  note: AccountNote | null;
  onMove: (delta: -1 | 1) => void;
  onToggle: () => void;
  onRename: (label: string) => void;
  /** Absent on account 1: Claude Code's own folder stays. */
  onRemove?: () => void;
  onSignIn: () => void;
}

/**
 * One Claude account in Settings > Claude accounts: its place, what Claude
 * Code says about it, its two windows of use, and its controls. Four columns,
 * so not a `SettingsRow`, which has two; it keeps that row's padding and hooks.
 */
export function ClaudeAccountRow({
  account, position, first, last, fiveHourThreshold, weeklyThreshold, note,
  onMove, onToggle, onRename, onRemove, onSignIn,
}: ClaudeAccountRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const { word, tone } = accountWord(account);
  const who = whoLine(account);
  const measured = account.signedIn === true && (account.fiveHour !== null || account.sevenDay !== null);

  const startRename = () => { setDraft(account.label); setRenaming(true); };
  // An empty label, or the one it has, sends nothing: main would refuse the
  // first and has the second already.
  const finishRename = (keep: boolean) => {
    const label = draft.trim();
    setRenaming(false);
    if (keep && label && label !== account.label) onRename(label);
  };

  return (
    <div data-settings-row data-account-row={account.id} className="min-h-[57px] py-[11px] shrink-0 px-4 flex items-center gap-4">
      <span className="w-2.5 shrink-0 font-mono text-[11px] text-muted-foreground">{position}</span>

      <div className="w-[250px] shrink-0 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 min-w-0">
          {renaming ? (
            <span className="w-[150px] shrink-0">
              <Input
                compact
                autoFocus
                maxLength={40}
                aria-label={`Name of ${account.label}`}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => finishRename(true)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
                  if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
                }}
              />
            </span>
          ) : (
            // The name itself, edited in place: plain text that says so on hover.
            <button
              type="button"
              aria-label={`Rename ${account.label}`}
              title="Rename"
              className="min-w-0 truncate text-left text-[12.5px] text-foreground cursor-text hover:underline decoration-dotted underline-offset-2"
              onClick={startRename}
            >
              {account.label}
            </button>
          )}
          <span className={`shrink-0 font-mono text-[10.5px] ${WORD_INK[tone]}`}>{word}</span>
        </div>
        {who && <p className="font-mono text-[10.5px] text-muted-foreground truncate" title={who}>{who}</p>}
        <p className="font-mono text-[10.5px] text-muted-foreground truncate">{accountFolder(account)}</p>
        {account.error && <p className="text-[11px] leading-snug text-status-error">{account.error}</p>}
      </div>

      <div className="w-[380px] shrink-0 flex flex-col gap-1.5">
        {measured && account.fiveHour && <UsageMeter label="5 h" window={account.fiveHour} threshold={fiveHourThreshold} />}
        {measured && account.sevenDay && <UsageMeter label="week" window={account.sevenDay} threshold={weeklyThreshold} />}
        {note && <p className={`text-[11px] leading-snug ${NOTE_INK[note.tone]}`}>{note.text}</p>}
        {account.signedIn === false && (
          <div>
            <Button size="sm" className="font-mono lowercase" onClick={onSignIn}>sign in</Button>
          </div>
        )}
      </div>

      <div className="flex-1" />

      <div className="shrink-0 flex items-center gap-2">
        <Button variant="ghost" size="sm" aria-label={`Move ${account.label} up`} disabled={first} onClick={() => onMove(-1)}>
          <ArrowUp className="w-3 h-3" />
        </Button>
        <Button variant="ghost" size="sm" aria-label={`Move ${account.label} down`} disabled={last} onClick={() => onMove(1)}>
          <ArrowDown className="w-3 h-3" />
        </Button>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[10.5px] text-muted-foreground">use</span>
          {/* Off can always be chosen; on only once Claude Code says it is signed in. */}
          <Toggle label={`Use ${account.label}`} enabled={account.enabled} onChange={onToggle} disabled={!account.enabled && account.signedIn !== true} />
        </span>
        {onRemove
          ? <Button size="sm" className="w-16 font-mono lowercase" onClick={onRemove}>remove</Button>
          : <span className="w-16" aria-hidden />}
      </div>
    </div>
  );
}

/**
 * The two thresholds, each a whole percentage from 50 to 100. A value main
 * would refuse is put back at once and said, never sent.
 */
export function ThresholdFields({ fiveHour, weekly, onSave }: { fiveHour: number; weekly: number; onSave: (p: { fiveHour: number; weekly: number }) => void }) {
  const [five, setFive] = useState(String(fiveHour));
  const [week, setWeek] = useState(String(weekly));
  const [refused, setRefused] = useState(false);
  const sent = useRef({ fiveHour, weekly });

  // Main's values win whenever they change, from another window or a refusal.
  // Its answer to what was just sent changes nothing on screen: whatever was
  // typed since is newer, and its own blur decides it.
  useEffect(() => {
    if (fiveHour === sent.current.fiveHour && weekly === sent.current.weekly) return;
    setFive(String(fiveHour));
    setWeek(String(weekly));
    sent.current = { fiveHour, weekly };
  }, [fiveHour, weekly]);

  const commit = () => {
    const next = { fiveHour: Number(five), weekly: Number(week) };
    if (!isThreshold(next.fiveHour) || !isThreshold(next.weekly)) {
      setFive(String(sent.current.fiveHour));
      setWeek(String(sent.current.weekly));
      setRefused(true);
      return;
    }
    setRefused(false);
    if (next.fiveHour === sent.current.fiveHour && next.weekly === sent.current.weekly) return;
    sent.current = next;
    onSave(next);
  };
  const field = (label: string, name: string, value: string, set: (v: string) => void) => (
    <label className="flex items-center gap-1.5">
      <span className="font-mono text-[11px] text-text-secondary">{label}</span>
      <span className="w-16">
        <Input
          compact
          mono
          inputMode="numeric"
          aria-label={name}
          value={value}
          onChange={e => set(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        />
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">%</span>
    </label>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {field('5 h', '5 h threshold', five, setFive)}
        {field('week', 'Weekly threshold', week, setWeek)}
      </div>
      {refused && <p className="text-[11px] text-status-error">A threshold is a whole percentage from 50 to 100.</p>}
    </div>
  );
}
