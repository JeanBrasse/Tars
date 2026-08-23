'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { AppSettings } from './types';

interface PiTerminalSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

/**
 * Rows, not a brochure.
 *
 * This used to stack four cards: an enable card, a test card, a numbered setup
 * guide and a bulleted feature list with two external links - none of which are
 * settings. What is left is the state Tars actually keeps for Pi: whether the
 * provider is offered, and which binary answers when it is.
 *
 * This file is the single owner of `piEnabled`; CLI Paths no longer writes it.
 */
export const PiTerminalSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings }: PiTerminalSectionProps) => {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; version?: string; error?: string } | null>(null);

  const enabled = (appSettings as unknown as Record<string, unknown>).piEnabled === true;
  const piPath = appSettings.cliPaths?.pi || 'pi';

  const handleToggle = () => {
    const newValue = !enabled;
    onUpdateLocalSettings({ piEnabled: newValue } as Partial<AppSettings>);
    onSaveAppSettings({ piEnabled: newValue } as Partial<AppSettings>);
  };

  const handleTestCli = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI?.shell?.version(piPath);
      if (result?.success && result.output) {
        setTestResult({ success: true, version: result.output.trim() });
      } else {
        setTestResult({ success: false, error: result?.output || result?.error || 'Pi CLI not found' });
      }
    } catch (error) {
      setTestResult({ success: false, error: String(error) });
    }
    setTesting(false);
  };

  // The result of the last test is this row's description line - a status word
  // in the status colour, no banner and no icon.
  const testDescription = testResult
    ? testResult.success
      ? <span className="font-mono text-status-running">{testResult.version}</span>
      : <span className="text-status-error">{testResult.error}</span>
    : 'Runs the binary once and reads back its version.';

  return (
    <>
      <SettingsRow
        label="Enable Pi Terminal"
        description="Offers Pi as an agent provider — a minimal terminal harness that speaks to 15+ AI providers."
        control={<Toggle enabled={enabled} onChange={handleToggle} />}
      />

      <SettingsRow
        label="Pi CLI"
        description={testDescription}
        control={
          <Button size="sm" className="font-mono" onClick={handleTestCli} disabled={testing}>
            {testing ? 'testing' : 'test cli'}
          </Button>
        }
      />

      <SettingsRow
        label="Binary"
        description="The path Tars runs. Change it in CLI Paths."
        control={<span className="font-mono text-[12.5px] text-muted-foreground truncate">{piPath}</span>}
      />
    </>
  );
};
