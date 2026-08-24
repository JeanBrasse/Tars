'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Input, Select, Dropdown } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { AppSettings } from './types';

interface TasmaniaSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

interface ServerStatus {
  status: 'stopped' | 'starting' | 'running' | 'error';
  backend: string | null;
  port: number | null;
  modelName: string | null;
  modelPath: string | null;
  endpoint: string | null;
  startedAt: number | null;
  error?: string;
}

interface LocalModel {
  name: string;
  filename: string;
  path: string;
  sizeBytes: number;
  repo: string | null;
  quantization: string | null;
  parameters: string | null;
  architecture: string | null;
}

/** Row actions are words, never glyphs: 26px bordered lowercase mono. */
const ACTION = 'font-mono lowercase';

/** A readout, not a control: the state of something Tars only reports on. */
const READOUT = 'font-mono text-[11px] text-muted-foreground';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(startedAt: number | null): string {
  if (!startedAt) return '-';
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export const TasmaniaSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings }: TasmaniaSectionProps) => {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [stoppingModel, setStoppingModel] = useState(false);
  const [mcpConfigured, setMcpConfigured] = useState(false);
  const [settingUpMcp, setSettingUpMcp] = useState(false);

  // Guard against overlapping status polls (each request has a 5s timeout)
  const statusFetchingRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (statusFetchingRef.current) return;
    if (!window.electronAPI?.tasmania?.getStatus) return;
    statusFetchingRef.current = true;
    try {
      const status = await window.electronAPI.tasmania.getStatus();
      setServerStatus(status);
    } catch {
      setServerStatus(null);
    } finally {
      statusFetchingRef.current = false;
    }
  }, []);

  const fetchModels = useCallback(async () => {
    if (!window.electronAPI?.tasmania?.getModels) return;
    setLoadingModels(true);
    try {
      const result = await window.electronAPI.tasmania.getModels();
      setModels(result.models || []);
    } catch {
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const fetchMcpStatus = useCallback(async () => {
    if (!window.electronAPI?.tasmania?.getMcpStatus) return;
    try {
      const result = await window.electronAPI.tasmania.getMcpStatus();
      setMcpConfigured(result.configured);
    } catch {
      setMcpConfigured(false);
    }
  }, []);

  // Only fetch data and start polling when Tasmania is enabled
  useEffect(() => {
    if (!appSettings.tasmaniaEnabled) return;

    fetchStatus();
    fetchModels();
    fetchMcpStatus();

    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [appSettings.tasmaniaEnabled, fetchStatus, fetchModels, fetchMcpStatus]);

  const handleTestConnection = async () => {
    if (!window.electronAPI?.tasmania?.test) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.tasmania.test();
      if (result.success) {
        setTestResult({ success: true, message: 'MCP server found and Control API is reachable.' });
      } else {
        const parts: string[] = [];
        if (!result.serverExists) parts.push('MCP server.js not found');
        if (!result.apiReachable) parts.push('Control API not reachable (is Tasmania running?)');
        setTestResult({ success: false, message: parts.join('. ') || 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ success: false, message: `Test failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  const handleLoadModel = async (modelPath: string) => {
    if (!window.electronAPI?.tasmania?.loadModel) return;
    setLoadingModel(modelPath);
    try {
      await window.electronAPI.tasmania.loadModel(modelPath);
      // Refresh status after a brief delay
      setTimeout(fetchStatus, 1000);
    } catch {
      // Error handled by status polling
    } finally {
      setLoadingModel(null);
    }
  };

  const handleStopModel = async () => {
    if (!window.electronAPI?.tasmania?.stopModel) return;
    setStoppingModel(true);
    try {
      await window.electronAPI.tasmania.stopModel();
      setTimeout(fetchStatus, 1000);
    } catch {
      // Error handled by status polling
    } finally {
      setStoppingModel(false);
    }
  };

  const handleToggleEnabled = async () => {
    const newEnabled = !appSettings.tasmaniaEnabled;
    onSaveAppSettings({ tasmaniaEnabled: newEnabled });

    if (newEnabled) {
      // Setup MCP
      setSettingUpMcp(true);
      try {
        if (window.electronAPI?.tasmania?.setup) {
          await window.electronAPI.tasmania.setup();
        }
        setMcpConfigured(true);
      } catch {
        // Ignore
      } finally {
        setSettingUpMcp(false);
      }
    } else {
      // Remove MCP
      try {
        if (window.electronAPI?.tasmania?.remove) {
          await window.electronAPI.tasmania.remove();
        }
        setMcpConfigured(false);
      } catch {
        // Ignore
      }
    }
  };

  // Picking a model loads it; picking the empty option stops the server. The
  // select is the loaded-model state, so there is nothing else to press.
  const handleModelChange = (modelPath: string) => {
    if (modelPath) {
      handleLoadModel(modelPath);
    } else {
      handleStopModel();
    }
  };

  const enableDescription = settingUpMcp
    ? 'Registering the MCP server with Claude Code…'
    : mcpConfigured
      ? 'Registered with Claude Code. Every agent can reach the local model.'
      : 'Registers Tasmania as an MCP server so agents can run a local model.';

  // The test tells the whole story of the path, so it takes the row's one line.
  const pathDescription = testResult ? (
    <span className={testResult.success ? 'text-status-running' : 'text-status-error'}>{testResult.message}</span>
  ) : (
    'Where the Tasmania MCP server lives on disk.'
  );

  // Raw status vocabulary, and the server's own words when it errors.
  const modelsDescription = !appSettings.tasmaniaEnabled
    ? 'Enable Tasmania to read the GGUF models on disk.'
    : !serverStatus
      ? 'Tasmania is not answering. Make sure the app is running.'
      : serverStatus.status === 'running'
        ? `running · ${serverStatus.modelName ?? 'model loaded'} · ${serverStatus.endpoint ?? ''} · ${formatUptime(serverStatus.startedAt)}`
        : serverStatus.status === 'starting'
          ? 'starting'
          : serverStatus.status === 'error'
            ? serverStatus.error || 'error'
            : 'idle · nothing loaded';

  return (
    <>
      <SettingsRow
        label="Enable Tasmania"
        description={enableDescription}
        control={
          <Toggle
            enabled={appSettings.tasmaniaEnabled}
            onChange={handleToggleEnabled}
          />
        }
      />

      <SettingsRow
        label="Server path"
        description={pathDescription}
        control={
          <div className="flex w-full items-center justify-end gap-2">
            <Input
              mono
              className="min-w-0 flex-1"
              value={appSettings.tasmaniaServerPath}
              onChange={(e) => onUpdateLocalSettings({ tasmaniaServerPath: e.target.value })}
              onBlur={() => {
                if (appSettings.tasmaniaServerPath) {
                  onSaveAppSettings({ tasmaniaServerPath: appSettings.tasmaniaServerPath });
                }
              }}
              placeholder="/path/to/tasmania/src/main/mcp/server.ts"
            />
            <Button size="sm" className={ACTION} onClick={handleTestConnection} disabled={testing}>
              {testing ? 'testing' : 'test'}
            </Button>
          </div>
        }
      />

      <SettingsRow
        label="Installed models"
        description={modelsDescription}
        control={
          models.length === 0 ? (
            <span className={READOUT}>{loadingModels ? 'looking…' : 'none detected'}</span>
          ) : (
            <Dropdown
              className="w-[300px]"
              ariaLabel="Loaded model"
              searchable={models.length > 8}
              value={serverStatus?.modelPath ?? ''}
              onChange={handleModelChange}
              options={[
                { value: '', label: 'none loaded' },
                ...models.map((model) => ({
                  value: model.path,
                  label: model.name,
                  hint: `${formatBytes(model.sizeBytes)}${model.quantization ? ` · ${model.quantization}` : ''}`,
                })),
              ]}
            />
          )
        }
      />

      <SettingsRow
        label="Metering"
        description="Inference runs on this machine, so nothing is billed and nothing is counted."
        control={<span className={READOUT}>no cost tracking</span>}
      />
    </>
  );
};
