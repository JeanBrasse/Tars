'use client';

import { useCallback, useEffect, useState } from 'react';
import { Dropdown } from '@/components/ui';
import { ModelEffortPicker } from './ModelEffortPicker';
import type { DropdownOption } from '@/components/ui';
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

const INTERVALS: DropdownOption[] = [
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
    const r = await window.electronAPI?.overseer?.modelOptions();
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
      {/* When the gateway cannot be asked which models it has, the picker is
          simply not offered. The page already carries a banner saying why, and
          repeating it here as a bordered box beside the send button put an
          error message where a control belongs. */}
      {optionsError ? null : (
        <ModelEffortPicker
          providers={providers}
          provider={effectiveProvider}
          model={effectiveModel}
          effort={effort}
          effortOptions={effortOptions}
          onProvider={handleProvider}
          onModel={model => onChange({ model })}
          onEffort={handleEffort}
        />
      )}
      <Dropdown
        size="sm"
        mono
        quiet
        align="left"
            drop="up"
        ariaLabel="How often the overseer checks the fleet"
        value={String(settings.watchIntervalMs)}
        options={
          INTERVALS.some(o => o.value === String(settings.watchIntervalMs))
            ? INTERVALS
            : [...INTERVALS, { value: String(settings.watchIntervalMs), label: intervalLabel(settings.watchIntervalMs) }]
        }
        onChange={v => onChange({ watchIntervalMs: Number(v) })}
        className="w-[132px]"
      />
    </>
  );
}
