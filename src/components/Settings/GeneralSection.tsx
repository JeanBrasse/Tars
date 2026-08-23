import { useState, useEffect } from 'react';
import { Select } from '@/components/ui';
import { Toggle } from './Toggle';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import type { ClaudeInfo, AppSettings } from './types';
import { PROVIDER_REGISTRY, computeProviderAvailability } from '@/lib/providers';

interface GeneralSectionProps {
  info: ClaudeInfo | null;
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
}

export const GeneralSection = ({ appSettings, onSaveAppSettings }: GeneralSectionProps) => {
  const [installedProviders, setInstalledProviders] = useState<Record<string, boolean>>({ claude: true, codex: true, gemini: true });

  useEffect(() => {
    Promise.all([
      window.electronAPI?.cliPaths?.detect(),
      window.electronAPI?.appSettings?.get(),
    ]).then(([paths, settings]) => {
      if (paths || settings) {
        setInstalledProviders(computeProviderAvailability(
          paths as Record<string, string | undefined> | undefined,
          settings,
        ));
      }
    });
  }, []);

  // The Tars identity card and the whole update checker (check button, release
  // notes, download progress, restart-to-apply) now live in SystemSection - the
  // version and its updates are one story, and it is that page's story. What
  // stays here is the preference itself.
  return (
    <SettingsCard>
      <SettingsRow
        label="Check for updates"
        description="Looks at the fork's releases, never upstream."
        control={
          <Toggle
            enabled={appSettings.autoCheckUpdates !== false}
            onChange={() => onSaveAppSettings({ autoCheckUpdates: !appSettings.autoCheckUpdates })}
          />
        }
      />

      <SettingsRow
        label="Default provider"
        description="Used for Telegram-spawned agents and webhook dispatches."
        control={
          <Select
            width="control"
            value={appSettings.defaultProvider || 'claude'}
            onChange={(e) => onSaveAppSettings({ defaultProvider: e.target.value })}
          >
            {PROVIDER_REGISTRY.filter(p => p.id !== 'opencode' && p.id !== 'pi').map(({ id, label, requiresCli }) => {
              const notAvailable = installedProviders[id] !== true;
              const reason = notAvailable
                ? requiresCli ? ' (not installed)' : ' (add API key in Settings)'
                : '';
              return (
                <option key={id} value={id} disabled={notAvailable}>
                  {label}{reason}
                </option>
              );
            })}
          </Select>
        }
      />
    </SettingsCard>
  );
};
