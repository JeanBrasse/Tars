'use client';

import { useState } from 'react';
import { Button, Input, PasswordInput } from '@/components/ui';
import { Toggle } from './Toggle';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import type { AppSettings } from './types';

interface SlackSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

export const SlackSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings }: SlackSectionProps) => {
  const [testingSlack, setTestingSlack] = useState(false);
  const [slackTestResult, setSlackTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTestTokens = async () => {
    if (!window.electronAPI?.slack?.test) return;
    setTestingSlack(true);
    setSlackTestResult(null);
    try {
      const result = await window.electronAPI.slack.test();
      if (result.success) {
        setSlackTestResult({ success: true, message: `Bot @${result.botName} is valid!` });
      } else {
        setSlackTestResult({ success: false, message: result.error || 'Invalid tokens' });
      }
    } catch {
      setSlackTestResult({ success: false, message: 'Failed to test connection' });
    } finally {
      setTestingSlack(false);
    }
  };

  const handleSendTest = async () => {
    if (!window.electronAPI?.slack?.sendTest) return;
    setTestingSlack(true);
    setSlackTestResult(null);
    try {
      const result = await window.electronAPI.slack.sendTest();
      if (result.success) {
        setSlackTestResult({ success: true, message: 'Test message sent!' });
      } else {
        setSlackTestResult({ success: false, message: result.error || 'Failed to send' });
      }
    } catch {
      setSlackTestResult({ success: false, message: 'Failed to send test message' });
    } finally {
      setTestingSlack(false);
    }
  };

  // The nine-step "Setup Guide" card is gone: what a token is and where it comes
  // from is one line each, on the row that asks for it.
  return (
    <SettingsCard>
      <SettingsRow
        label="Enable"
        description="Receive notifications and drive agents from Slack."
        control={
          <Toggle
            enabled={appSettings.slackEnabled}
            onChange={() => onSaveAppSettings({ slackEnabled: !appSettings.slackEnabled })}
          />
        }
      />

      <SettingsRow
        label="Bot token"
        description="xoxb-… from OAuth & Permissions, once the app is installed to the workspace."
        control={
          <PasswordInput
            width="control"
            value={appSettings.slackBotToken}
            onChange={(e) => onUpdateLocalSettings({ slackBotToken: e.target.value })}
            onBlur={() => {
              if (appSettings.slackBotToken) {
                onSaveAppSettings({ slackBotToken: appSettings.slackBotToken });
              }
            }}
            placeholder="xoxb-..."
          />
        }
      />

      <SettingsRow
        label="App token"
        description="xapp-… Socket Mode token, scoped connections:write."
        control={
          <PasswordInput
            width="control"
            value={appSettings.slackAppToken}
            onChange={(e) => onUpdateLocalSettings({ slackAppToken: e.target.value })}
            onBlur={() => {
              if (appSettings.slackAppToken) {
                onSaveAppSettings({ slackAppToken: appSettings.slackAppToken });
              }
            }}
            placeholder="xapp-..."
          />
        }
      />

      <SettingsRow
        label="Channel"
        description="Auto-detected when you mention the bot or DM it."
        control={
          <Input
            mono
            readOnly
            width="control"
            value={appSettings.slackChannelId || ''}
            placeholder="not connected yet"
          />
        }
      />

      <SettingsRow
        label="Test"
        description={
          slackTestResult ? (
            <span className={slackTestResult.success ? 'text-status-running' : 'text-status-error'}>
              {slackTestResult.message}
            </span>
          ) : (
            'Checks the tokens, then posts a message to the detected channel.'
          )
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="font-mono"
              onClick={handleTestTokens}
              disabled={!appSettings.slackBotToken || !appSettings.slackAppToken || testingSlack}
            >
              test tokens
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="font-mono"
              onClick={handleSendTest}
              disabled={!appSettings.slackChannelId || testingSlack}
            >
              send test
            </Button>
          </div>
        }
      />
    </SettingsCard>
  );
};
