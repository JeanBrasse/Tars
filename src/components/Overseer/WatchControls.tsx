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
  { value: '60000', label: 'every 1 min', hint: 'costs a Hermes run each time' },
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
      {optionsError ? (
        <div className="h-[26px] flex items-center border border-border px-2.5">
          <span className="font-mono text-[10.5px] text-muted-foreground truncate max-w-[220px]">
            {optionsError}
          </span>
        </div>
      ) : (
        <>
          <Dropdown
            size="sm"
            mono
            align="left"
            drop="up"
            searchable={providerOptions.length > 8}
            ariaLabel="Overseer provider"
            placeholder="provider"
            value={effectiveProvider}
            options={providerOptions}
            onChange={handleProvider}
            className="w-[124px]"
          />
          <Dropdown
            size="sm"
            mono
            align="left"
            drop="up"
            searchable={modelOptions.length > 8}
            ariaLabel="Overseer model"
            placeholder="model"
            value={effectiveModel}
            options={modelOptions}
            onChange={model => onChange({ model })}
            className="w-[168px]"
          />
        </>
      )}
      <Dropdown
        size="sm"
        mono
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
        className="w-[140px]"
      />
    </>
  );
}
