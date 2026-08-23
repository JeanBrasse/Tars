import { useState, useEffect } from 'react';
import { Button, Input } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import type { AppSettings, CLIPaths } from './types';

interface CLIPathsSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (settings: Partial<AppSettings>) => void;
  /** Kept for the call site; the provider toggles that used it now live on Providers. */
  onUpdateLocalSettings?: (settings: Partial<AppSettings>) => void;
}

type BinaryKey = keyof Omit<CLIPaths, 'additionalPaths'>;

type DetectedPaths = Record<BinaryKey, string>;

// Row actions are words, not glyphs (R7): 26px lowercase mono.
const ROW_ACTION = 'font-mono lowercase';

// One row per binary, in the order the tools get reached for.
const BINARIES: { key: BinaryKey; label: string }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'grok', label: 'Grok' },
  { key: 'qwencode', label: 'Qwen Code' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'pi', label: 'Pi Terminal' },
  { key: 'gws', label: 'Google Workspace (gws)' },
  { key: 'gcloud', label: 'Google Cloud SDK (gcloud)' },
  { key: 'gh', label: 'GitHub CLI (gh)' },
  { key: 'node', label: 'Node.js' },
  { key: 'minimax', label: 'MiniMax' },
];

const EMPTY_CLI_PATHS: CLIPaths = {
  claude: '', codex: '', gemini: '', grok: '', qwencode: '', opencode: '',
  pi: '', gws: '', gcloud: '', gh: '', node: '', minimax: '', additionalPaths: [],
};

export const CLIPathsSection = ({ appSettings, onSaveAppSettings }: CLIPathsSectionProps) => {
  const [detecting, setDetecting] = useState(false);
  const [detectedPaths, setDetectedPaths] = useState<DetectedPaths | null>(null);
  const [localPaths, setLocalPaths] = useState<CLIPaths>(appSettings.cliPaths || EMPTY_CLI_PATHS);
  // The extra directories are one PATH string in the row, so the text has to
  // survive a trailing separator the parsed array would drop.
  const [additionalText, setAdditionalText] = useState(
    (appSettings.cliPaths?.additionalPaths || []).join(':')
  );

  useEffect(() => {
    setLocalPaths(appSettings.cliPaths || EMPTY_CLI_PATHS);
    setAdditionalText((appSettings.cliPaths?.additionalPaths || []).join(':'));
  }, [appSettings.cliPaths]);

  const handleDetectPaths = async () => {
    setDetecting(true);
    try {
      const rawPaths = await window.electronAPI?.cliPaths?.detect();
      const paths = rawPaths as DetectedPaths | undefined;
      if (paths) {
        setDetectedPaths(paths);
        // Auto-fill empty fields with detected values
        const updatedPaths = { ...localPaths };
        for (const { key } of BINARIES) {
          if (!updatedPaths[key] && paths[key]) updatedPaths[key] = paths[key];
        }
        setLocalPaths(updatedPaths);
      }
    } catch (error) {
      console.error('Failed to detect paths:', error);
    }
    setDetecting(false);
  };

  const handlePathChange = (key: BinaryKey, value: string) => {
    setLocalPaths(prev => ({ ...prev, [key]: value }));
  };

  const handleAdditionalChange = (value: string) => {
    setAdditionalText(value);
    setLocalPaths(prev => ({
      ...prev,
      additionalPaths: value.split(':').map(p => p.trim()).filter(Boolean),
    }));
  };

  const handleSave = () => {
    onSaveAppSettings({ cliPaths: localPaths });
  };

  const hasChanges = JSON.stringify(localPaths) !== JSON.stringify(appSettings.cliPaths || EMPTY_CLI_PATHS);

  return (
    <>
      <SettingsRow
        label="Auto-detect"
        description="Looks in the usual places and fills in every path you have left empty."
        control={
          <Button
            size="sm"
            variant="ghost"
            className={ROW_ACTION}
            onClick={handleDetectPaths}
            disabled={detecting}
          >
            {detecting ? 'detecting' : 'detect now'}
          </Button>
        }
      />

      {BINARIES.map(({ key, label }) => {
        const detected = detectedPaths?.[key];
        const current = localPaths[key];
        // The row's second line is the path that will actually run.
        const resolved = current || detected || '';
        return (
          <SettingsRow
            key={key}
            label={label}
            description={
              resolved
                ? <span className="font-mono">{resolved}</span>
                : 'not detected on this machine'
            }
            control={
              <Input
                mono
                width="control"
                value={current}
                onChange={(e) => handlePathChange(key, e.target.value)}
                placeholder={detected ? 'detected' : 'set path…'}
              />
            }
          />
        );
      })}

      <SettingsRow
        label="Additional PATH"
        description="Extra directories agents get on their PATH, separated by colons. /opt/homebrew/bin, /usr/local/bin and ~/.nvm are always included."
        control={
          <Input
            mono
            width="control"
            value={additionalText}
            onChange={(e) => handleAdditionalChange(e.target.value)}
            placeholder="/path/to/directory"
          />
        }
      />

      <SettingsRow
        label="Save CLI paths"
        description="Nothing here takes effect until you save."
        control={
          <Button variant="primary" size="md" onClick={handleSave} disabled={!hasChanges}>
            Save
          </Button>
        }
      />
    </>
  );
};
