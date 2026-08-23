'use client';

import { useState } from 'react';
import { Button, PasswordInput } from '@/components/ui';
import { Toggle } from './Toggle';
import { SettingsRow } from './SettingsRow';
import type { AppSettings } from './types';

interface SocialDataSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

export const SocialDataSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings }: SocialDataSectionProps) => {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testingX, setTestingX] = useState(false);
  const [testXResult, setTestXResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTestConnection = async () => {
    if (!window.electronAPI?.socialData?.test) return;
    setTesting(true);
    setTestResult(null);
    try {
      onSaveAppSettings({
        socialDataApiKey: appSettings.socialDataApiKey,
      });
      await new Promise(r => setTimeout(r, 300));

      const result = await window.electronAPI.socialData.test();
      if (result.success) {
        setTestResult({ success: true, message: 'API key is valid! Connected to SocialData.' });
      } else {
        setTestResult({ success: false, message: result.error || 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ success: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  const handleTestXConnection = async () => {
    setTestingX(true);
    setTestXResult(null);
    try {
      // Save credentials first so the main process has them
      onSaveAppSettings({
        xApiKey: appSettings.xApiKey,
        xApiSecret: appSettings.xApiSecret,
        xAccessToken: appSettings.xAccessToken,
        xAccessTokenSecret: appSettings.xAccessTokenSecret,
      });
      await new Promise(r => setTimeout(r, 500));

      if (!window.electronAPI?.xApi?.test) {
        setTestXResult({ success: false, message: 'X API bridge not available. Please restart the app.' });
        return;
      }

      const result = await window.electronAPI.xApi.test();
      if (result.success) {
        setTestXResult({ success: true, message: result.username ? `Authenticated as @${result.username}` : 'X API credentials are valid!' });
      } else {
        setTestXResult({ success: false, message: result.error || 'Connection failed' });
      }
    } catch (err) {
      setTestXResult({ success: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTestingX(false);
    }
  };

  const canEnable = !!appSettings.socialDataApiKey;
  const canEnableXPosting = !!(appSettings.xApiKey && appSettings.xApiSecret && appSettings.xAccessToken && appSettings.xAccessTokenSecret);

  // Four rows, no cards of our own: the bordered surface comes from the
  // `<SettingsCard>` in `settings/page.tsx`, and the page name is in the header.
  // The tool catalogue and the two setup guides are gone - where a credential
  // comes from is one line on the row that asks for it. The four X credentials
  // pair up two to a row, so the whole OAuth handshake reads as two lines.
  return (
    <>
      <SettingsRow
        label="Read access"
        description={
          testResult ? (
            <span className={testResult.success ? 'text-status-running' : 'text-status-error'}>
              {testResult.message}
            </span>
          ) : (
            <>Search and analyse X through SocialData. Key from socialdata.tools.</>
          )
        }
        control={
          <div className="flex w-full items-center gap-2">
            <PasswordInput
              className="min-w-0 flex-1"
              value={appSettings.socialDataApiKey}
              onChange={(e) => onUpdateLocalSettings({ socialDataApiKey: e.target.value })}
              onBlur={() => {
                if (appSettings.socialDataApiKey) {
                  onSaveAppSettings({ socialDataApiKey: appSettings.socialDataApiKey });
                }
              }}
              placeholder="sd_..."
            />
            <Button
              size="sm"
              variant="ghost"
              className="font-mono"
              onClick={handleTestConnection}
              disabled={!canEnable || testing}
            >
              test
            </Button>
          </div>
        }
        secondaryControl={
          <Toggle
            enabled={appSettings.socialDataEnabled}
            onChange={() => onSaveAppSettings({ socialDataEnabled: !appSettings.socialDataEnabled })}
            disabled={!canEnable}
          />
        }
      />

      <SettingsRow
        label="Posting"
        description={
          testXResult ? (
            <span className={testXResult.success ? 'text-status-running' : 'text-status-error'}>
              {testXResult.message}
            </span>
          ) : (
            <>Post, reply and delete on your behalf. OAuth 1.0a, from the X developer portal.</>
          )
        }
        control={
          <Button
            size="sm"
            variant="ghost"
            className="font-mono"
            onClick={handleTestXConnection}
            disabled={!canEnableXPosting || testingX}
          >
            test
          </Button>
        }
        secondaryControl={
          <Toggle
            enabled={appSettings.xPostingEnabled}
            onChange={() => onSaveAppSettings({ xPostingEnabled: !appSettings.xPostingEnabled })}
            disabled={!canEnableXPosting}
          />
        }
      />

      <SettingsRow
        label="API key + secret"
        description="Consumer key and consumer secret of the X app."
        control={
          // Two halves of the 300px column, so the pair ends on the same
          // trailing edge as every single field on this page.
          <div className="grid w-full grid-cols-2 gap-2">
            <PasswordInput
              value={appSettings.xApiKey}
              onChange={(e) => onUpdateLocalSettings({ xApiKey: e.target.value })}
              onBlur={() => {
                if (appSettings.xApiKey) {
                  onSaveAppSettings({ xApiKey: appSettings.xApiKey });
                }
              }}
              placeholder="key"
            />
            <PasswordInput
              value={appSettings.xApiSecret}
              onChange={(e) => onUpdateLocalSettings({ xApiSecret: e.target.value })}
              onBlur={() => {
                if (appSettings.xApiSecret) {
                  onSaveAppSettings({ xApiSecret: appSettings.xApiSecret });
                }
              }}
              placeholder="secret"
            />
          </div>
        }
      />

      <SettingsRow
        label="Access token + secret"
        description="Needs Read and Write permissions, or posting fails at the API."
        control={
          <div className="grid w-full grid-cols-2 gap-2">
            <PasswordInput
              value={appSettings.xAccessToken}
              onChange={(e) => onUpdateLocalSettings({ xAccessToken: e.target.value })}
              onBlur={() => {
                if (appSettings.xAccessToken) {
                  onSaveAppSettings({ xAccessToken: appSettings.xAccessToken });
                }
              }}
              placeholder="token"
            />
            <PasswordInput
              value={appSettings.xAccessTokenSecret}
              onChange={(e) => onUpdateLocalSettings({ xAccessTokenSecret: e.target.value })}
              onBlur={() => {
                if (appSettings.xAccessTokenSecret) {
                  onSaveAppSettings({ xAccessTokenSecret: appSettings.xAccessTokenSecret });
                }
              }}
              placeholder="secret"
            />
          </div>
        }
      />
    </>
  );
};
