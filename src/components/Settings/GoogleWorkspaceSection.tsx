'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import { Button, StatusBadge } from '@/components/ui';
import TerminalDialog from '@/components/TerminalDialog';
import type { AppSettings } from './types';

interface GoogleWorkspaceSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

type ServiceAccess = 'none' | 'read' | 'write';

interface AuthStatus {
  authenticated: boolean;
  user: string | null;
  tokenValid: boolean;
  scopes: string[];
  authMethod: string;
  services: Record<string, ServiceAccess>;
}

// Names only. The per-service Google brand colours and lucide glyphs are gone:
// the scopes row is one mono line, not a grid of coloured tiles.
const SERVICE_LABELS: Record<string, string> = {
  gmail: 'gmail',
  drive: 'drive',
  sheets: 'sheets',
  calendar: 'calendar',
  docs: 'docs',
  slides: 'slides',
  tasks: 'tasks',
  chat: 'chat',
  people: 'people',
  forms: 'forms',
  keep: 'keep',
};

const SERVICE_COUNT = Object.keys(SERVICE_LABELS).length;

export const GoogleWorkspaceSection = ({ appSettings, onSaveAppSettings }: GoogleWorkspaceSectionProps) => {
  const [gwsPath, setGwsPath] = useState<string>('');
  const [gcloudPath, setGcloudPath] = useState<string>('');
  const [detecting, setDetecting] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [mcpConfigured, setMcpConfigured] = useState(false);
  const [settingUpMcp, setSettingUpMcp] = useState(false);
  const [showInstallTerminal, setShowInstallTerminal] = useState(false);
  const [installCommand, setInstallCommand] = useState('');
  const [installTitle, setInstallTitle] = useState('');
  const [installType, setInstallType] = useState<'cli' | 'gcloud' | 'skills' | 'auth-setup' | 'auth-login'>('cli');
  const [gwsSkills, setGwsSkills] = useState<string[]>([]);

  // Stable ref so fetchSkills doesn't depend on onSaveAppSettings identity
  const onSaveRef = useRef(onSaveAppSettings);
  onSaveRef.current = onSaveAppSettings;

  const fetchSkills = useCallback(async () => {
    if (!window.electronAPI?.gws?.listSkills) return;
    try {
      const skills = await window.electronAPI.gws.listSkills();
      setGwsSkills(skills);
      if (skills.length > 0) {
        onSaveRef.current({ gwsSkillsInstalled: true });
      }
    } catch {
      setGwsSkills([]);
    }
  }, []);

  const detectAll = useCallback(async () => {
    setDetecting(true);
    try {
      // Use centralized CLI paths detection
      const paths = await window.electronAPI?.cliPaths?.detect();
      if (paths) {
        setGwsPath(paths.gws || '');
        setGcloudPath(paths.gcloud || '');
      }
    } catch {
      setGwsPath('');
      setGcloudPath('');
    } finally {
      setDetecting(false);
    }
  }, []);

  const checkAuthStatus = useCallback(async () => {
    if (!window.electronAPI?.gws?.authStatus) return;
    setCheckingAuth(true);
    try {
      const status = await window.electronAPI.gws.authStatus();
      setAuthStatus(status);
    } catch {
      setAuthStatus(null);
    } finally {
      setCheckingAuth(false);
    }
  }, []);

  const fetchMcpStatus = useCallback(async () => {
    if (!window.electronAPI?.gws?.getMcpStatus) return;
    try {
      const result = await window.electronAPI.gws.getMcpStatus();
      setMcpConfigured(result.configured);
    } catch {
      setMcpConfigured(false);
    }
  }, []);

  useEffect(() => {
    detectAll();
    fetchMcpStatus();
    fetchSkills();
  }, [detectAll, fetchMcpStatus, fetchSkills]);

  useEffect(() => {
    if (gwsPath) {
      checkAuthStatus();
    }
  }, [gwsPath, checkAuthStatus]);

  // Build a command with gcloud's bin dir on PATH so gws can find it
  const gwsCommandWithPath = (args: string) => {
    const parts: string[] = [];
    // Prepend gcloud's directory to PATH if detected at a non-standard location
    if (gcloudPath) {
      const gcloudDir = gcloudPath.replace(/\/gcloud$/, '');
      parts.push(`export PATH="${gcloudDir}:$PATH"`);
    }
    // Use full gws path if detected
    const gws = gwsPath || 'gws';
    parts.push(`"${gws}" ${args}`);
    return parts.join(' && ');
  };

  const handleAuthSetup = () => {
    setInstallType('auth-setup');
    setInstallTitle('Google Workspace Auth Setup');
    setInstallCommand(gwsCommandWithPath('auth setup'));
    setShowInstallTerminal(true);
  };

  const handleAuthLogin = () => {
    setInstallType('auth-login');
    setInstallTitle('Google Workspace Auth Login');
    setInstallCommand(gwsCommandWithPath('auth login'));
    setShowInstallTerminal(true);
  };

  const handleInstallGcloud = () => {
    setInstallType('gcloud');
    setInstallTitle('Installing Google Cloud SDK');
    setInstallCommand('brew install google-cloud-sdk');
    setShowInstallTerminal(true);
  };

  const handleInstallCli = () => {
    setInstallType('cli');
    setInstallTitle('Installing gws CLI');
    setInstallCommand('npm install -g @googleworkspace/cli');
    setShowInstallTerminal(true);
  };

  const handleInstallSkills = () => {
    setInstallType('skills');
    setInstallTitle('Installing Agent Skills');
    setInstallCommand('npx skills add https://github.com/googleworkspace/cli');
    setShowInstallTerminal(true);
  };

  const handleInstallComplete = async () => {
    await detectAll();
    if (installType === 'skills') {
      await fetchSkills();
    }
    if (installType === 'auth-setup' || installType === 'auth-login') {
      await checkAuthStatus();
    }
  };

  const handleToggleEnabled = async () => {
    const newEnabled = !appSettings.gwsEnabled;
    onSaveAppSettings({ gwsEnabled: newEnabled });

    if (newEnabled) {
      setSettingUpMcp(true);
      try {
        if (window.electronAPI?.gws?.setup) {
          await window.electronAPI.gws.setup();
        }
        setMcpConfigured(true);
      } catch {
        // Ignore
      } finally {
        setSettingUpMcp(false);
      }
    } else {
      try {
        if (window.electronAPI?.gws?.remove) {
          await window.electronAPI.gws.remove();
        }
        setMcpConfigured(false);
      } catch {
        // Ignore
      }
    }
  };

  const authenticated = authStatus?.authenticated ?? false;

  // Every granted scope on one line: `gmail write · drive read`. What used to be
  // an eleven-tile grid with R/W badges is the Scopes row's description now.
  const grantedScopes = authStatus
    ? Object.entries(authStatus.services)
        .filter(([, access]) => access !== 'none')
        .map(([key, access]) => `${SERVICE_LABELS[key] ?? key} ${access}`)
    : [];

  const accountDescription = detecting
    ? 'looking for the gws CLI'
    : !gwsPath
      ? 'gws not installed — npm install -g @googleworkspace/cli'
      : authenticated
        ? `${authStatus?.user || 'unknown account'} · token ${authStatus?.tokenValid ? 'valid' : 'expired'}`
        : !gcloudPath
          ? 'gcloud missing — auth setup needs it to create the OAuth client'
          : checkingAuth
            ? 'checking authentication'
            : 'not signed in — auth setup creates the Google Cloud project first';

  // One chain, most blocking step first: install the CLI, install gcloud, set up
  // the OAuth client, sign in. Once signed in it becomes recheck + re-consent.
  const accountControl = detecting ? (
    <span className="font-mono text-[11px] text-muted-foreground">detecting</span>
  ) : !gwsPath ? (
    <Button size="sm" className="font-mono" onClick={handleInstallCli}>install gws</Button>
  ) : authenticated ? (
    <>
      <Button size="sm" className="font-mono" onClick={checkAuthStatus} disabled={checkingAuth}>
        {checkingAuth ? 'checking' : 'recheck'}
      </Button>
      <Button size="sm" className="font-mono" onClick={handleAuthLogin}>update access</Button>
    </>
  ) : !gcloudPath ? (
    <Button size="sm" className="font-mono" onClick={handleInstallGcloud}>install gcloud</Button>
  ) : (
    <>
      <Button size="sm" className="font-mono" onClick={handleAuthSetup}>auth setup</Button>
      <Button size="sm" className="font-mono" onClick={handleAuthLogin}>sign in with google</Button>
    </>
  );

  return (
    <>
      <SettingsRow
        label="Enable Google Workspace MCP"
        description="Runs gws mcp -s drive,gmail,calendar,sheets,docs over stdio."
        control={
          settingUpMcp ? (
            <span className="font-mono text-[11px] text-muted-foreground">registering</span>
          ) : (
            <StatusBadge tone={mcpConfigured ? 'running' : 'idle'} className="font-mono">
              {mcpConfigured ? 'registered' : 'not registered'}
            </StatusBadge>
          )
        }
        secondaryControl={
          <Toggle
            enabled={appSettings.gwsEnabled}
            onChange={handleToggleEnabled}
          />
        }
      />

      <SettingsRow
        label="Account"
        description={accountDescription}
        control={<div className="flex items-center gap-2">{accountControl}</div>}
      />

      <SettingsRow
        label="Scopes"
        description={
          grantedScopes.length > 0
            ? grantedScopes.join(' · ')
            : 'nothing granted yet — they come from the account you sign in with'
        }
        control={
          <span className="font-mono text-[11px] text-muted-foreground">
            {grantedScopes.length} of {SERVICE_COUNT} services
          </span>
        }
      />

      <SettingsRow
        label="Skills"
        description={
          gwsSkills.length > 0
            ? gwsSkills.map((skill) => skill.replace(/^gws-/, '')).join(' · ')
            : 'agent skills for Gmail, Drive, Sheets, Docs and Calendar'
        }
        control={
          <div className="flex items-center gap-2">
            {gwsSkills.length > 0 ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {gwsSkills.length} installed
              </span>
            ) : (
              <StatusBadge tone="idle" className="font-mono">not installed</StatusBadge>
            )}
            <Button size="sm" className="font-mono" onClick={handleInstallSkills}>
              {gwsSkills.length > 0 ? 'install more' : 'install'}
            </Button>
          </div>
        }
      />

      {/* Install Dialog - reuses TerminalDialog in command mode */}
      <TerminalDialog
        open={showInstallTerminal}
        repo=""
        title={installTitle}
        command={installCommand}
        onClose={(success) => {
          setShowInstallTerminal(false);
          if (success) handleInstallComplete();
        }}
      />
    </>
  );
};
