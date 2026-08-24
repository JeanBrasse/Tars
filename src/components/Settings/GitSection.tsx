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
      description="Claude Code adds a Co-Authored-By: Claude trailer to commits it makes. This is its own setting, kept in ~/.claude/settings.json, so it does not reach Codex, Gemini, Grok, OpenCode or Pi."
      control={
        <Toggle
          enabled={settings?.includeCoAuthoredBy ?? false}
          onChange={() => onUpdateSettings({ includeCoAuthoredBy: !settings?.includeCoAuthoredBy })}
        />
      }
    />
  );
};
