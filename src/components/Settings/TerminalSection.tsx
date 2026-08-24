import { Select, Dropdown } from '@/components/ui';
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
        description="Applies to every agent terminal: Claude, Codex, Gemini and every CLI provider."
        control={
          <Dropdown
            className="w-[300px]"
            ariaLabel="Terminal theme"
            value={currentTheme}
            onChange={(v) => onSaveAppSettings({ terminalTheme: v as 'dark' | 'light' })}
            options={[
              { value: 'dark', label: 'dark' },
              { value: 'light', label: 'light' },
            ]}
          />
        }
      />

      <SettingsRow
        label="Font size"
        description="Controls font size on the Terminals page. Persisted across sessions."
        control={
          <Dropdown
            className="w-[300px]"
            ariaLabel="Terminal font size"
            value={String(currentFontSize)}
            onChange={(v) => onSaveAppSettings({ terminalFontSize: Number(v) })}
            options={FONT_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
          />
        }
      />
    </SettingsCard>
  );
};
