'use client';

import type { ReactNode } from 'react';
import { Input, PasswordInput } from '@/components/ui';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { AppSettings } from './types';

interface MemorySectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

interface BackendRowsProps {
  title: string;
  description: ReactNode;
  docUrl: string;
  enabled: boolean;
  url: string;
  urlPlaceholder: string;
  token: string;
  tokenLabel: string;
  onToggle: (enabled: boolean) => void;
  /** `persist` is false while typing and true on blur - see the note below. */
  onUrlChange: (url: string, persist: boolean) => void;
  onTokenChange: (token: string, persist: boolean) => void;
}

/**
 * A backend is three rows, never a card: the switch, its endpoint and its
 * secret. The endpoint and the secret stay on screen whether or not the backend
 * is on - you configure it first, then turn it on.
 *
 * There is no per-backend Save button any more. Typing updates the settings in
 * place and leaving a field writes them, so the header's single action is free
 * to be `Check`.
 */
function BackendRows({
  title,
  description,
  docUrl,
  enabled,
  url,
  urlPlaceholder,
  token,
  tokenLabel,
  onToggle,
  onUrlChange,
  onTokenChange,
}: BackendRowsProps) {
  return (
    <>
      <SettingsRow
        label={title}
        description={
          <>
            {description}{' '}
            <a href={docUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              Docs
            </a>
          </>
        }
        control={<Toggle enabled={enabled} onChange={() => onToggle(!enabled)} />}
      />

      <SettingsRow
        label="MCP endpoint URL"
        control={
          <Input
            mono
            width="control"
            value={url}
            onChange={e => onUrlChange(e.target.value, false)}
            onBlur={e => onUrlChange(e.target.value.trim(), true)}
            placeholder={urlPlaceholder}
          />
        }
      />

      <SettingsRow
        label={tokenLabel}
        control={
          <PasswordInput
            width="control"
            value={token}
            onChange={e => onTokenChange(e.target.value, false)}
            onBlur={e => onTokenChange(e.target.value.trim(), true)}
            placeholder="Optional - sent as Authorization: Bearer …"
          />
        }
      />
    </>
  );
}

export const MemorySection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings }: MemorySectionProps) => {
  const write = (updates: Partial<AppSettings>, persist: boolean) =>
    (persist ? onSaveAppSettings : onUpdateLocalSettings)(updates);

  return (
    <SettingsCard>
      <BackendRows
        title="gbrain"
        description="Shared semantic memory (vector + knowledge graph)."
        docUrl="https://github.com/garrytan/gbrain"
        enabled={!!appSettings.memoryGbrainEnabled}
        url={appSettings.memoryGbrainMcpUrl || ''}
        urlPlaceholder="https://gbrain.example.com/mcp"
        token={appSettings.memoryGbrainAuthToken || ''}
        tokenLabel="Auth token"
        onToggle={enabled => onSaveAppSettings({ memoryGbrainEnabled: enabled })}
        onUrlChange={(url, persist) => write({ memoryGbrainMcpUrl: url }, persist)}
        onTokenChange={(token, persist) => write({ memoryGbrainAuthToken: token }, persist)}
      />

      <BackendRows
        title="Honcho"
        description="Plastic Labs' memory layer (peers, sessions, working representations)."
        docUrl="https://honcho.dev/docs/v3/guides/integrations/mcp"
        enabled={!!appSettings.memoryHonchoEnabled}
        url={appSettings.memoryHonchoMcpUrl || 'https://mcp.honcho.dev'}
        urlPlaceholder="https://mcp.honcho.dev"
        token={appSettings.memoryHonchoApiKey || ''}
        tokenLabel="API key"
        onToggle={enabled => onSaveAppSettings({ memoryHonchoEnabled: enabled })}
        onUrlChange={(url, persist) => write({ memoryHonchoMcpUrl: url }, persist)}
        onTokenChange={(token, persist) => write({ memoryHonchoApiKey: token }, persist)}
      />
    </SettingsCard>
  );
};
