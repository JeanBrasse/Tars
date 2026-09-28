'use client';

import { useEffect, useState } from 'react';
import { Button, DialogShell, StatusSquare } from '@/components/ui';
import type { ClaudeAccountState } from '@/types/electron';
import { useClaudeAccounts } from '@/hooks/useClaudeAccounts';
import { DEFAULT_ACCOUNT_ID, MAX_ACCOUNTS, accountNote, allAtLimit, isThreshold, moveInOrder } from '@/lib/claude-accounts';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import { ClaudeAccountRow, ThresholdFields } from './ClaudeAccountRow';
import { ClaudeAccountLoginModal } from './ClaudeAccountLoginModal';

/** One line above the rows, in its tone: main's refusal, or every account at its limit. */
const notice = (tone: 'error' | 'waiting', text: string) => (
  <div data-settings-row className="px-4 py-[11px] shrink-0">
    <div className="flex items-center gap-2 px-2.5 py-2 bg-secondary border border-border">
      <StatusSquare tone={tone} />
      <span className={`text-[11.5px] leading-snug ${tone === 'error' ? 'text-status-error' : 'text-foreground'}`}>{text}</span>
    </div>
  </div>
);

/**
 * Settings > AI & Providers > Claude accounts: several Claude subscriptions,
 * each a Claude Code folder signed in by Claude Code itself, and the two
 * thresholds that move agents between them. Off by default. On #263's
 * channels (DESIGN-COMPTES-CLAUDE.md, B6). Frames: `Settings · Claude
 * accounts`, `Settings · Claude accounts · states`, and their light copies.
 */
export const ClaudeAccountsSection = () => {
  const { view, error, actions } = useClaudeAccounts();
  const [login, setLogin] = useState<{ accountId?: string } | null>(null);
  const [removing, setRemoving] = useState<ClaudeAccountState | null>(null);
  // The notes say times ("at its limit until 21:40"): read again every half minute.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const on = view?.settings.enabled === true;
  const accounts = view?.accounts ?? [];
  const ids = accounts.map(a => a.id);
  const full = accounts.length >= MAX_ACCOUNTS;
  const limit = on && view ? allAtLimit(view, now) : null;

  return (
    <SettingsCard>
      {error && notice('error', error)}

      <SettingsRow
        wrap
        label="Use several Claude subscriptions"
        description={
          <>
            <span className="block">Runs your Claude agents on up to five subscriptions, and moves an agent to another account when its own runs short.</span>
            <span className="block">Each account signs in through Claude Code itself, in a terminal Tars opens. Tars never sees the sign-in.</span>
            <span className="block">{"Each account must be your own, and its limits are Anthropic's."}</span>
          </>
        }
        control={
          <Toggle
            label="Use several Claude subscriptions"
            enabled={on}
            disabled={!view}
            onChange={() => { if (view) void actions.setEnabled(!on); }}
          />
        }
      />

      {on && view && (
        <>
          {limit && notice('waiting', `Every account is at its limit. Agents resume at ${limit.at} when ${limit.label} resets.`)}

          <SettingsRow
            wrap
            label="Accounts"
            description={full
              ? 'Five accounts, the most Tars runs at once.'
              : `Agents go where the most room is left, and this order breaks ties. ${accounts.length} of 5.`}
            control={
              <Button size="sm" className="font-mono lowercase" disabled={full} onClick={() => setLogin({})}>
                add an account
              </Button>
            }
          />

          {accounts.map((a, i) => (
            <ClaudeAccountRow
              key={a.id}
              account={a}
              position={i + 1}
              first={i === 0}
              last={i === accounts.length - 1}
              fiveHourThreshold={view.settings.fiveHourThreshold}
              weeklyThreshold={view.settings.weeklyThreshold}
              note={accountNote(a, view, now)}
              onMove={delta => { void actions.reorder(moveInOrder(ids, i, delta)); }}
              onToggle={() => { void actions.setAccountEnabled({ id: a.id, enabled: !a.enabled }); }}
              onRename={label => { void actions.rename({ id: a.id, label }); }}
              onRemove={a.id === DEFAULT_ACCOUNT_ID ? undefined : () => setRemoving(a)}
              onSignIn={() => setLogin({ accountId: a.id })}
            />
          ))}

          <SettingsRow
            wrap
            label="Move agents at"
            description="Tars keeps agents on accounts below both thresholds, each from 50 to 100 percent. When every account is at its limit, agents wait for the first reset."
            control={
              <ThresholdFields
                fiveHour={view.settings.fiveHourThreshold}
                weekly={view.settings.weeklyThreshold}
                onSave={p => { if (isThreshold(p.fiveHour) && isThreshold(p.weekly)) void actions.setThresholds(p); }}
              />
            }
          />
        </>
      )}

      {login && <ClaudeAccountLoginModal accountId={login.accountId} onClose={() => setLogin(null)} />}

      {removing && (
        <DialogShell
          onClose={() => setRemoving(null)}
          width={460}
          title={`Remove ${removing.label}?`}
          subtitle="Claude Code signs its folder out, and Tars moves the folder to the Trash. Its agents move to another account as their turns end."
          footerRight={
            <>
              <Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const id = removing.id;
                  setRemoving(null);
                  void actions.remove(id);
                }}
              >
                {`Remove ${removing.label}`}
              </Button>
            </>
          }
        />
      )}
    </SettingsCard>
  );
};
