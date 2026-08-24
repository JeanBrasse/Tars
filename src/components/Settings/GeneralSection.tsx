import { useState, useEffect } from 'react';
import { Select, Dropdown } from '@/components/ui';
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
      window.electronAPI?.ollama?.test(),
    ]).then(([paths, settings, ollama]) => {
      if (paths || settings) {
        setInstalledProviders(computeProviderAvailability(
          paths as Record<string, string | undefined> | undefined,
          settings,
          ollama?.reachable,
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
        label="Start agents when Tars opens"
        description="Resumes the agents you left idle, once, at launch. Navigating back to the dashboard never starts anything."
        control={
          <Toggle
            enabled={appSettings.autoStartAgentsOnLaunch !== false}
            onChange={() => onSaveAppSettings({ autoStartAgentsOnLaunch: appSettings.autoStartAgentsOnLaunch === false })}
          />
        }
      />

      <SettingsRow
        label="Default provider"
        description="Used for Telegram-spawned agents and webhook dispatches."
        control={
          <Dropdown
            className="w-[300px]"
            ariaLabel="Default provider"
            searchable
            value={appSettings.defaultProvider || 'claude'}
            onChange={(v) => onSaveAppSettings({ defaultProvider: v })}
            options={PROVIDER_REGISTRY
              .filter(p => p.id !== 'opencode' && p.id !== 'pi')
              .map(({ id, label, requiresCli }) => {
                const notAvailable = installedProviders[id] !== true;
                return {
                  value: id,
                  label,
                  hint: notAvailable
                    ? requiresCli ? 'not installed' : 'add an API key first'
                    : undefined,
                  disabled: notAvailable,
                };
              })}
          />
        }
      />
    </SettingsCard>
  );
};
