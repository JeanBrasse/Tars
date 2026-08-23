import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { ClaudeSettings } from './types';

interface GitSectionProps {
  settings: ClaudeSettings | null;
  onUpdateSettings: (updates: Partial<ClaudeSettings>) => void;
}

export const GitSection = ({ settings, onUpdateSettings }: GitSectionProps) => {
  return (
    <SettingsRow
      label="Co-authored-by"
      description="Commits made with AI assistance carry a co-authored-by trailer naming the active provider."
      control={
        <Toggle
          enabled={settings?.includeCoAuthoredBy ?? false}
          onChange={() => onUpdateSettings({ includeCoAuthoredBy: !settings?.includeCoAuthoredBy })}
        />
      }
    />
  );
};
