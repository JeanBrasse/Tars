'use client';

import { useCallback, useEffect, useState } from 'react';
import { MenuPicker } from '@/components/ui';
import { ModelEffortPicker } from './ModelEffortPicker';
import type { MenuPickerOption } from '@/components/ui';
import type { OverseerModelProvider, OverseerSettings } from '@/types/electron';

/**
 * What the overseer runs on, and how often it looks: two controls under the
 * message box.
 *
 * What answers (provider, model, effort) is one decision and one control, in
 * `ModelEffortPicker`. How often it checks the fleet is a separate one, and it
 * is the only one here that is Tars's own setting: it works with no gateway at
 * all, which is why it survives when the pickers cannot be offered.
 *
 * The provider list is asked of the gateway rather than compiled in, because
 * which providers have credentials is a property of that install.
 */

const INTERVALS: MenuPickerOption[] = [
  { value: '60000', label: 'every 1 min' },
  { value: '300000', label: 'every 5 min' },
  { value: '900000', label: 'every 15 min' },
  { value: '1800000', label: 'every 30 min' },
  { value: '3600000', label: 'every hour' },
  { value: '10800000', label: 'every 3 hours' },
  { value: '21600000', label: 'every 6 hours' },
];

/** Matches the persisted value to a listed option, so a state file holding an
 *  interval no longer offered still shows something true rather than blank. */
function intervalLabel(ms: number): string {
  const known = INTERVALS.find(o => o.value === String(ms));
  if (known) return known.label;
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `every ${Math.round(minutes / 60)}h` : `every ${minutes} min`;
}

export function WatchControls({
  settings,
  onChange,
}: {
  settings: OverseerSettings | null;
  onChange: (patch: Partial<OverseerSettings>) => void;
}) {
  const [providers, setProviders] = useState<OverseerModelProvider[]>([]);
  const [gatewayDefault, setGatewayDefault] = useState<{ provider: string; model: string } | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  /** The gateway's `agent.reasoning_effort`, read live. Null means the gateway
   *  did not answer, and the control is then not offered rather than showing a
   *  value nothing is behind. */
  const [effort, setEffort] = useState<string | null>(null);
  const [effortOptions, setEffortOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.overseer?.effort().then(r => {
      if (cancelled || !r?.success) return;
      setEffort(r.effort ?? null);
      setEffortOptions(r.options ?? []);
    }).catch(() => { /* the banner above already says the gateway is unreachable */ });
    return () => { cancelled = true; };
  }, []);

  const handleEffort = useCallback(async (next: string) => {
    const previous = effort;
    setEffort(next); // optimistic: the write is a single small config PUT
    const r = await window.electronAPI?.overseer?.setEffort(next);
    if (!r?.success) setEffort(previous);
  }, [effort]);

  const loadOptions = useCallback(async () => {
    // The call reaches the gateway, so an unreachable one rejects rather than
    // answering `{ success: false }`. Unhandled, that rejection was an error on
    // the console of every Chat page whose gateway is down. The `effort()` call
    // above has had its own catch since it was written.
    //
    // What the catch puts in `error` is read by a human, on the control it
    // disables: the gateway's own sentence when it answered one ("Sign in to
    // Hermes to list its models", "Hermes is not configured"), and this line
    // when the call never got through. The technical text of the failure is
    // already on screen, in the banner's detail above the thread.
    const r = await window.electronAPI?.overseer?.modelOptions()
      .catch(() => ({ success: false as const, error: 'The gateway did not list its models.' }));
    if (!r) return;
    if (r.success) {
      setProviders(r.providers);
      setGatewayDefault({ provider: r.provider, model: r.model });
      setOptionsError(null);
    } else {
      setOptionsError(r.error);
    }
  }, []);

  useEffect(() => { void loadOptions(); }, [loadOptions]);

  if (!settings) return null;

  // An empty stored provider means "whatever the gateway is set to", so the
  // control shows the gateway's own choice rather than an empty box.
  const effectiveProvider = settings.provider || gatewayDefault?.provider || '';
  const effectiveModel = settings.model || gatewayDefault?.model || '';

  const handleProvider = (slug: string) => {
    // The model belongs to the old provider, so it is cleared rather than
    // carried over: sending a model a provider does not have fails the run.
    const first = providers.find(p => p.slug === slug)?.models[0] ?? '';
    onChange({ provider: slug, model: first });
  };

  return (
    <>
      {/* When the gateway cannot be asked which models it has, the control
          stays where it is, greyed, and says why on hover. Hiding it took a
          control off the row without a word, which is the one thing a disabled
          control in this app never does; and writing the reason as a bordered
          box beside the send button put an error message where a control
          belongs. The banner above already carries the gateway's state and the
          failure's own text, so this line is short and says something else. */}
      <ModelEffortPicker
        providers={providers}
        provider={effectiveProvider}
        model={effectiveModel}
        effort={effort}
        effortOptions={effortOptions}
        onProvider={handleProvider}
        onModel={model => onChange({ model })}
        onEffort={handleEffort}
        disabledReason={optionsError ?? undefined}
      />
      <MenuPicker
        ariaLabel="How often the overseer checks the fleet"
        value={String(settings.watchIntervalMs)}
        options={
          INTERVALS.some(o => o.value === String(settings.watchIntervalMs))
            ? INTERVALS
            : [...INTERVALS, { value: String(settings.watchIntervalMs), label: intervalLabel(settings.watchIntervalMs) }]
        }
        onChange={v => onChange({ watchIntervalMs: Number(v) })}
      />
    </>
  );
}
