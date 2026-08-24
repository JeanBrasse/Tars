'use client';

import { useCallback, useEffect, useState } from 'react';
import { Dropdown } from '@/components/ui';
import type { DropdownOption } from '@/components/ui';
import type { OverseerModelProvider, OverseerSettings } from '@/types/electron';

/**
 * The three things about the overseer that used to be constants: which model
 * answers, whose model it is, and how often it looks at the fleet.
 *
 * The provider list is asked of the Hermes gateway rather than compiled in,
 * because which providers have credentials is a property of that install. It is
 * also why provider and model are two controls and not one: a gateway can offer
 * a hundred models under a single provider, and a combined list would run to
 * several hundred rows.
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
  const models = providers.find(p => p.slug === effectiveProvider)?.models ?? [];

  const providerOptions: DropdownOption[] = providers.map(p => ({
    value: p.slug,
    label: p.name || p.slug,
    hint: p.models.length ? `${p.models.length} models` : 'no models',
    disabled: p.models.length === 0,
  }));

  const modelOptions: DropdownOption[] = models.map(m => ({ value: m, label: m }));

  const handleProvider = (slug: string) => {
    // The model belongs to the old provider, so it is cleared rather than
    // carried over: sending a model a provider does not have fails the run.
    const first = providers.find(p => p.slug === slug)?.models[0] ?? '';
    onChange({ provider: slug, model: first });
  };

  return (
    <>
      {/* When the gateway cannot be asked which models it has, the pickers are
          simply not offered. The page already carries a banner saying why, and
          repeating it here as a bordered box beside the send button put an
          error message where a control belongs. The cadence stays: it is Tars's
          own setting and works with no gateway at all. */}
      {optionsError ? null : (
        <>
          <Dropdown
            size="sm"
            mono
            quiet
            align="left"
            drop="up"
            searchable={providerOptions.length > 8}
            ariaLabel="Overseer provider"
            placeholder="provider"
            value={effectiveProvider}
            options={providerOptions}
            onChange={handleProvider}
            className="w-[118px]"
          />
          <Dropdown
            size="sm"
            mono
            quiet
            align="left"
            drop="up"
            searchable={modelOptions.length > 8}
            ariaLabel="Overseer model"
            title="Sets the model your Hermes gateway answers on, for everything that uses it, not only this chat"
            placeholder="model"
            value={effectiveModel}
            options={modelOptions}
            onChange={model => onChange({ model })}
            className="w-[160px]"
          />
        </>
      )}
      {/* Beside the model because it modifies it. Like the model, it is the
          gateway's setting rather than Tars's, and it is per gateway rather
          than per message: the gateway has no per-turn effort to offer. */}
      {effort && effortOptions.length > 0 && (
        <Dropdown
          size="sm"
          mono
          quiet
          align="left"
          drop="up"
          ariaLabel="Reasoning effort"
          title="Sets the reasoning effort your Hermes gateway runs at, for everything that uses it, not only this chat"
          value={effort}
          options={effortOptions.map(o => ({ value: o, label: `effort ${o}` }))}
          onChange={handleEffort}
          className="w-[124px]"
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
