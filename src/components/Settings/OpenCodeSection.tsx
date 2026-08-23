'use client';

import { useState } from 'react';
import { Button, Input, StatusBadge } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { AppSettings } from './types';

interface OpenCodeSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

export const OpenCodeSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings }: OpenCodeSectionProps) => {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const opencodeEnabled = appSettings.opencodeEnabled ?? false;
  const opencodeDefaultModel = appSettings.opencodeDefaultModel ?? '';

  const handleToggleEnabled = () => {
    onSaveAppSettings({ opencodeEnabled: !opencodeEnabled });
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI?.shell?.version('opencode');
      if (result?.success && result.output) {
        setTestResult({ success: true, message: `OpenCode found: ${result.output.trim()}` });
      } else {
        setTestResult({ success: false, message: result?.error || 'OpenCode CLI not found. Make sure it is installed and in your PATH.' });
      }
    } catch (err) {
      setTestResult({ success: false, message: `Test failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      {/* This section is the single owner of `opencodeEnabled` - CLI Paths no longer writes it. */}
      <SettingsRow
        label="Enable OpenCode"
        description="Runs the OpenCode CLI as an agent provider."
        control={<Toggle enabled={opencodeEnabled} onChange={handleToggleEnabled} />}
      />

      {opencodeEnabled && (
        <SettingsRow
          label="Default model"
          description="provider/model — empty uses the one in .opencode.json"
          control={
            <Input
              mono
              width="control"
              value={opencodeDefaultModel}
              onChange={(e) => onUpdateLocalSettings({ opencodeDefaultModel: e.target.value })}
              onBlur={() => onSaveAppSettings({ opencodeDefaultModel })}
              placeholder="anthropic/claude-sonnet-4-20250514"
            />
          }
        />
      )}

      {/* The result reads as the row's own description line, coloured by status - no banner. */}
      <SettingsRow
        label="Command line"
        description={
          testResult
            ? <StatusBadge tone={testResult.success ? 'running' : 'error'} className="text-[11px]">{testResult.message}</StatusBadge>
            : 'Checks that the opencode binary is on your PATH.'
        }
        control={
          <Button size="sm" className="font-mono lowercase" onClick={handleTestConnection} disabled={testing}>
            {testing ? 'testing' : 'test cli'}
          </Button>
        }
      />
    </>
  );
};
