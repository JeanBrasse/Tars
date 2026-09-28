'use client';

import type { AgentStatus } from '@/types/electron';
import { Dropdown } from '@/components/ui';
import { useClaudeAccounts } from '@/hooks/useClaudeAccounts';
import { AUTOMATIC, controlLabel, controlTitle, menuOptions, showsAccountControl, type AccountMenuOption } from '@/lib/claude-accounts';

const HINT_INK: Record<AccountMenuOption['hintTone'], string | undefined> = {
  muted: undefined,
  waiting: 'text-status-waiting',
  error: 'text-status-error',
};

/**
 * The Claude account an agent runs on, small, and the menu that pins it to one.
 * On the agent's card in Agents, its pane header on the Dashboard and its
 * window. Frames: `Agent · Claude account` (and its light copy). Nothing shows
 * with the option off, with a single account, or on an agent that does not run
 * Claude on a subscription.
 */
export function AgentAccountControl({
  agent,
  className = '',
  stopMouseDown = false,
}: {
  agent: Pick<AgentStatus, 'id' | 'name' | 'provider' | 'claudeAccountId' | 'claudeAccountPin'>;
  className?: string;
  /** In a pane header, a press on the control must not start dragging the pane. */
  stopMouseDown?: boolean;
}) {
  const { view, actions } = useClaudeAccounts();
  if (!showsAccountControl(view, agent)) return null;

  const options = menuOptions(view, agent, new Date()).map(({ hintTone, ...o }) => ({ ...o, hintClassName: HINT_INK[hintTone] }));
  const control = (
    <Dropdown
      size="sm"
      quiet
      mono="trigger"
      panelMinWidth={280}
      align="right"
      className={className}
      value={agent.claudeAccountPin ?? AUTOMATIC}
      options={options}
      triggerLabel={controlLabel(view, agent)}
      title={controlTitle(view, agent)}
      ariaLabel={`Claude account of ${agent.name || 'this agent'}`}
      caption="Run this agent on"
      footer="Automatic lets Tars choose the account and move the agent. Pinned, it stays on that account past its thresholds, and waits at its limit."
      onChange={value => { void actions.setAgentAccount({ agentId: agent.id, accountId: value === AUTOMATIC ? null : value }); }}
    />
  );
  return stopMouseDown ? <div className="shrink-0" onMouseDown={e => e.stopPropagation()}>{control}</div> : control;
}
