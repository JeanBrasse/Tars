import { Select } from '@/components/ui';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import type { AppSettings } from './types';

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 11;

const FONT_SIZES = Array.from(
  { length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 },
  (_, i) => MIN_FONT_SIZE + i
);

interface TerminalSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
}

export const TerminalSection = ({ appSettings, onSaveAppSettings }: TerminalSectionProps) => {
  const currentTheme = appSettings.terminalTheme || 'dark';
  const currentFontSize = appSettings.terminalFontSize || DEFAULT_FONT_SIZE;

  return (
    <SettingsCard>
      <SettingsRow
        label="Theme"
        description="Applies to every agent terminal — Claude, Codex, Gemini and every CLI provider."
        control={
          <Select
            width="control"
            value={currentTheme}
            onChange={(e) => onSaveAppSettings({ terminalTheme: e.target.value as 'dark' | 'light' })}
          >
            <option value="dark">dark</option>
            <option value="light">light</option>
          </Select>
        }
      />

      <SettingsRow
        label="Font size"
        description="Controls font size on the Terminals page. Persisted across sessions."
        control={
          <Select
            width="control"
            value={currentFontSize}
            onChange={(e) => onSaveAppSettings({ terminalFontSize: Number(e.target.value) })}
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        }
      />
    </SettingsCard>
  );
};
