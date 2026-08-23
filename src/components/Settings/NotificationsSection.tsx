import { Button } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { AppSettings } from './types';

interface NotificationsSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
}

type SoundKey = 'waiting' | 'complete' | 'stop' | 'error';

/**
 * The sound picker for one event. It used to render on a second line under the
 * row; it now lives in the row's own control column, left of the toggle, so
 * every row stays 57px whether a sound is set or not.
 */
function SoundPicker({
  soundKey,
  appSettings,
  onSaveAppSettings,
}: {
  soundKey: SoundKey;
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
}) {
  const currentPath = appSettings.notificationSounds?.[soundKey];
  const fileName = currentPath ? currentPath.split('/').pop() : null;

  const handlePick = async () => {
    if (!window.electronAPI?.dialog?.openAudio) return;
    const filePath = await window.electronAPI.dialog.openAudio();
    if (filePath) {
      onSaveAppSettings({
        notificationSounds: {
          ...appSettings.notificationSounds,
          [soundKey]: filePath,
        },
      });
    }
  };

  const handleClear = () => {
    const updated = { ...appSettings.notificationSounds };
    delete updated[soundKey];
    onSaveAppSettings({ notificationSounds: updated });
  };

  return (
    <div className="flex items-center gap-2 min-w-0">
      <Button variant="secondary" onClick={handlePick} className="min-w-0 max-w-[200px] font-mono text-xs">
        <span className="truncate">{fileName ?? 'choose sound'}</span>
      </Button>
      {fileName && (
        <Button variant="ghost" onClick={handleClear} className="font-mono text-xs">
          clear
        </Button>
      )}
    </div>
  );
}

export const NotificationsSection = ({ appSettings, onSaveAppSettings }: NotificationsSectionProps) => {
  // Everything below the master toggle dims together when notifications are off.
  // The dimming is per-row rather than on a wrapper so the card's own hairlines
  // still fall between the rows.
  const dimmed = appSettings.notificationsEnabled ? '' : 'opacity-50 pointer-events-none';

  return (
    <>
      <SettingsRow
        label="Enable notifications"
        description="Master toggle for all desktop notifications."
        secondaryControl={
          <Toggle
            enabled={appSettings.notificationsEnabled}
            onChange={() => onSaveAppSettings({ notificationsEnabled: !appSettings.notificationsEnabled })}
          />
        }
      />

      <SettingsRow
        className={dimmed}
        label="Waiting for input"
        description="A permission dialog appeared, or the agent asked for something. PermissionRequest and Notification hooks."
        control={<SoundPicker soundKey="waiting" appSettings={appSettings} onSaveAppSettings={onSaveAppSettings} />}
        secondaryControl={
          <Toggle
            enabled={appSettings.notifyOnWaiting}
            onChange={() => onSaveAppSettings({ notifyOnWaiting: !appSettings.notifyOnWaiting })}
          />
        }
      />

      <SettingsRow
        className={dimmed}
        label="Response finished"
        description="Every time an agent finishes responding. Stop hook (noisy if you run a lot of agents)."
        control={<SoundPicker soundKey="stop" appSettings={appSettings} onSaveAppSettings={onSaveAppSettings} />}
        secondaryControl={
          <Toggle
            enabled={appSettings.notifyOnStop}
            onChange={() => onSaveAppSettings({ notifyOnStop: !appSettings.notifyOnStop })}
          />
        }
      />

      <SettingsRow
        className={dimmed}
        label="Task complete"
        description="An agent explicitly marked a task as done. TaskCompleted hook."
        control={<SoundPicker soundKey="complete" appSettings={appSettings} onSaveAppSettings={onSaveAppSettings} />}
        secondaryControl={
          <Toggle
            enabled={appSettings.notifyOnComplete}
            onChange={() => onSaveAppSettings({ notifyOnComplete: !appSettings.notifyOnComplete })}
          />
        }
      />

      <SettingsRow
        className={dimmed}
        label="Error alerts"
        description="An agent process crashed or exited non-zero. Fires from the PTY exit handler."
        control={<SoundPicker soundKey="error" appSettings={appSettings} onSaveAppSettings={onSaveAppSettings} />}
        secondaryControl={
          <Toggle
            enabled={appSettings.notifyOnError}
            onChange={() => onSaveAppSettings({ notifyOnError: !appSettings.notifyOnError })}
          />
        }
      />
    </>
  );
};
