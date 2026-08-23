import { useState, useEffect } from 'react';
import { Button, StatusBadge } from '@/components/ui';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import type { ClaudeInfo, AppSettings } from './types';

/** Strip HTML tags and collapse whitespace so release notes render as plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  hasUpdate: boolean;
  downloadUrl?: string;
  releaseUrl?: string;
}

type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'downloading' | 'downloaded' | 'error';

interface SystemSectionProps {
  info: ClaudeInfo | null;
  appSettings: AppSettings;
  onSaveAppSettings: (settings: Partial<AppSettings>) => void;
}

/**
 * What this machine is running. The per-CLI version table used to live here and
 * now belongs to Providers - a binary's version is part of that provider's row,
 * not a separate inventory. What arrived instead is the Tars version and its
 * update checker, moved out of General: the version and its updates are one
 * story, and it is this page's story. General keeps only the preference.
 */
export const SystemSection = ({ info }: SystemSectionProps) => {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [downloadPercent, setDownloadPercent] = useState(0);

  useEffect(() => {
    window.electronAPI?.app?.getVersion().then(r => setAppVersion(r?.version ?? null)).catch(() => {});
  }, []);

  // Listen for download progress, completion, and error events
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.updates) return;
    const unsubs: (() => void)[] = [];

    if (window.electronAPI.updates.onDownloadProgress) {
      unsubs.push(window.electronAPI.updates.onDownloadProgress((progress) => {
        setDownloadPercent(progress.percent);
      }));
    }

    if (window.electronAPI.updates.onUpdateDownloaded) {
      unsubs.push(window.electronAPI.updates.onUpdateDownloaded(() => {
        setUpdateState('downloaded');
      }));
    }

    if (window.electronAPI.updates.onUpdateError) {
      unsubs.push(window.electronAPI.updates.onUpdateError((err) => {
        setUpdateState('error');
        setUpdateError(err);
      }));
    }

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Listen for update-available and update-not-available events
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.updates) return;
    const unsubs: (() => void)[] = [];

    if (window.electronAPI.updates.onUpdateAvailable) {
      unsubs.push(window.electronAPI.updates.onUpdateAvailable((available) => {
        if (available.hasUpdate) {
          setUpdateInfo(available);
          setUpdateState('update-available');
        }
      }));
    }

    if (window.electronAPI.updates.onUpdateNotAvailable) {
      unsubs.push(window.electronAPI.updates.onUpdateNotAvailable((available) => {
        setUpdateInfo({
          currentVersion: available.currentVersion,
          latestVersion: available.latestVersion,
          releaseNotes: '',
          hasUpdate: false,
        });
        setUpdateState('up-to-date');
      }));
    }

    return () => unsubs.forEach((fn) => fn());
  }, []);

  const handleCheckForUpdates = async () => {
    if (!window.electronAPI?.updates) return;

    setUpdateState('checking');
    setUpdateError(null);

    try {
      const result = await window.electronAPI.updates.check();
      if (result?.devMode) {
        // Dev mode - electron-updater can't check unpacked apps
        setUpdateState('error');
        setUpdateError('Update check is only available in the production build.');
      }
      // Otherwise, wait for update-available / update-not-available / error events
    } catch (err) {
      setUpdateState('error');
      setUpdateError(err instanceof Error ? err.message : 'Failed to check for updates');
    }
  };

  const isFallbackUpdate = !!(updateInfo?.downloadUrl);

  const handleDownloadUpdate = () => {
    if (isFallbackUpdate && updateInfo?.downloadUrl) {
      // Fallback mode: open browser (no in-app download for old releases)
      window.electronAPI?.updates?.openExternal(updateInfo.downloadUrl);
    } else {
      if (!window.electronAPI?.updates?.download) return;
      setUpdateState('downloading');
      setDownloadPercent(0);
      window.electronAPI.updates.download();
    }
  };

  const handleQuitAndInstall = () => {
    window.electronAPI?.updates?.quitAndInstall();
  };

  const handleRevealConfigFolder = () => {
    if (info?.configPath) window.electronAPI?.shell?.reveal(info.configPath);
  };

  const handleOpenConfigFolder = () => {
    if (info?.configPath) window.electronAPI?.shell?.openTerminal({ cwd: info.configPath });
  };

  const version = appVersion || updateInfo?.currentVersion || '...';

  // The state used to be four coloured cards under the button. It is one line
  // under the label now, and the button itself says what happens next.
  const versionLine = (() => {
    switch (updateState) {
      case 'checking':
        return 'checking the fork’s releases';
      case 'up-to-date':
        return 'up to date';
      case 'update-available':
        return `${updateInfo?.latestVersion} available`;
      case 'downloading':
        return `downloading ${downloadPercent.toFixed(0)}%`;
      case 'downloaded':
        return 'downloaded';
      case 'error':
        return <span className="text-status-error">{updateError || 'update check failed'}</span>;
      default:
        return null;
    }
  })();

  const updateButton = (() => {
    switch (updateState) {
      case 'checking':
        return <Button size="sm" variant="ghost" className="font-mono" disabled>checking</Button>;
      case 'update-available':
        return (
          <Button size="sm" variant="ghost" className="font-mono" onClick={handleDownloadUpdate}>
            {isFallbackUpdate ? 'open release' : 'download'}
          </Button>
        );
      case 'downloading':
        return <Button size="sm" variant="ghost" className="font-mono" disabled>downloading</Button>;
      case 'downloaded':
        return <Button size="sm" variant="ghost" className="font-mono" onClick={handleQuitAndInstall}>restart to apply</Button>;
      default:
        return <Button size="sm" variant="ghost" className="font-mono" onClick={handleCheckForUpdates}>check for updates</Button>;
    }
  })();

  return (
    <SettingsCard>
      <SettingsRow
        label="Tars"
        description={
          <>
            Version {version}
            {versionLine && <> &middot; {versionLine}</>}
          </>
        }
        control={updateButton}
      />

      {updateState === 'update-available' && updateInfo?.releaseNotes && (
        <div className="px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Release notes</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-foreground whitespace-pre-wrap line-clamp-4">
            {stripHtml(updateInfo.releaseNotes).slice(0, 300)}
            {updateInfo.releaseNotes.length > 300 ? '...' : ''}
          </p>
        </div>
      )}

      {info && (
        <>
          <SettingsRow
            label="Electron / Node"
            description={`${info.electronVersion} · Node ${info.nodeVersion} · ${info.platform} ${info.arch}`}
          />

          <SettingsRow
            label="Claude Code"
            description={`${info.claudeVersion} · ${info.settingsPath}`}
            control={
              info.claudeVersion
                ? <StatusBadge tone="running">ready</StatusBadge>
                : <StatusBadge tone="idle">not installed</StatusBadge>
            }
          />

          <SettingsRow
            label="Data directory"
            description={info.configPath}
            control={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" className="font-mono" onClick={handleRevealConfigFolder}>reveal</Button>
                <Button size="sm" variant="ghost" className="font-mono" onClick={handleOpenConfigFolder}>open</Button>
              </div>
            }
          />
        </>
      )}
    </SettingsCard>
  );
};
