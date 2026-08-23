'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Input, PanelCaption, PasswordInput, StatusBadge } from '@/components/ui';
import { SettingsRow } from './SettingsRow';

interface McpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface EditState {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The page is one flat list now, so the provider tab strip is gone. Every call
 * still names its provider, so the IPC contract is unchanged and a provider
 * control can come back later without touching a single handler.
 */
const MCP_PROVIDER = 'claude';

/** `stdio · npx pencil-mcp` - the whole transport on the row's second line. */
const transportLine = (server: McpServer) =>
  `stdio · ${[server.command, ...server.args].join(' ')}`.trim();

export function McpSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [editStates, setEditStates] = useState<Record<string, EditState>>({});
  const [savingServer, setSavingServer] = useState<string | null>(null);
  const [savedServer, setSavedServer] = useState<string | null>(null);
  const [deletingServer, setDeletingServer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.mcp?.list({ provider: MCP_PROVIDER });
      if (result?.error) {
        setError(result.error);
        setServers([]);
      } else {
        setServers(result?.servers || []);
        // Initialize edit states
        const states: Record<string, EditState> = {};
        for (const s of result?.servers || []) {
          states[s.name] = { command: s.command, args: [...s.args], env: { ...s.env } };
        }
        setEditStates(states);
      }
    } catch (err) {
      setError(String(err));
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
    setExpandedServer(null);
  }, [loadServers]);

  const getEditState = (name: string): EditState => {
    return editStates[name] || { command: '', args: [], env: {} };
  };

  const updateEditState = (name: string, updates: Partial<EditState>) => {
    setEditStates(prev => ({
      ...prev,
      [name]: { ...getEditState(name), ...updates },
    }));
  };

  const handleSave = async (name: string) => {
    const state = getEditState(name);
    setSavingServer(name);
    try {
      const result = await window.electronAPI?.mcp?.update({
        provider: MCP_PROVIDER,
        name,
        command: state.command,
        args: state.args,
        env: state.env,
      });
      if (result?.success) {
        setSavedServer(name);
        setTimeout(() => setSavedServer(null), 2000);
      } else {
        setError(result?.error || 'Failed to save');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSavingServer(null);
    }
  };

  const handleDelete = async (name: string) => {
    setDeletingServer(name);
    try {
      const result = await window.electronAPI?.mcp?.delete({ provider: MCP_PROVIDER, name });
      if (result?.success) {
        setServers(prev => prev.filter(s => s.name !== name));
        const newStates = { ...editStates };
        delete newStates[name];
        setEditStates(newStates);
        if (expandedServer === name) setExpandedServer(null);
      } else {
        setError(result?.error || 'Failed to delete');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingServer(null);
    }
  };

  // ── Arg helpers ──

  const addArg = (name: string) => {
    const state = getEditState(name);
    updateEditState(name, { args: [...state.args, ''] });
  };

  const updateArg = (name: string, idx: number, value: string) => {
    const state = getEditState(name);
    const newArgs = [...state.args];
    newArgs[idx] = value;
    updateEditState(name, { args: newArgs });
  };

  const removeArg = (name: string, idx: number) => {
    const state = getEditState(name);
    updateEditState(name, { args: state.args.filter((_, i) => i !== idx) });
  };

  // ── Env helpers ──

  const addEnvVar = (name: string) => {
    const state = getEditState(name);
    updateEditState(name, { env: { ...state.env, '': '' } });
  };

  const updateEnvKey = (serverName: string, oldKey: string, newKey: string) => {
    const state = getEditState(serverName);
    const entries = Object.entries(state.env);
    const newEnv: Record<string, string> = {};
    for (const [k, v] of entries) {
      newEnv[k === oldKey ? newKey : k] = v;
    }
    updateEditState(serverName, { env: newEnv });
  };

  const updateEnvValue = (serverName: string, key: string, value: string) => {
    const state = getEditState(serverName);
    updateEditState(serverName, { env: { ...state.env, [key]: value } });
  };

  const removeEnvVar = (serverName: string, key: string) => {
    const state = getEditState(serverName);
    const newEnv = { ...state.env };
    delete newEnv[key];
    updateEditState(serverName, { env: newEnv });
  };

  return (
    <>
      {error && (
        <div className="px-4 py-3 flex items-center gap-3 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <Button size="sm" variant="ghost" className="font-mono shrink-0" onClick={() => setError(null)}>
            dismiss
          </Button>
        </div>
      )}

      {loading && servers.length === 0 && <SettingsRow label="Loading servers…" />}

      {!loading && servers.length === 0 && (
        <SettingsRow
          label="No custom MCP servers"
          description="Servers you registered yourself show up here. The ones Tars installs stay hidden."
        />
      )}

      {servers.map(server => {
        const isExpanded = expandedServer === server.name;
        const state = getEditState(server.name);
        const isSaving = savingServer === server.name;
        const isSaved = savedServer === server.name;
        const isDeleting = deletingServer === server.name;

        return (
          <div key={server.name}>
            {/* The server itself: a row like every other row on this page. */}
            <SettingsRow
              label={server.name}
              description={<span className="font-mono">{transportLine(server)}</span>}
              control={
                <div className="flex items-center gap-2">
                  <StatusBadge tone="running" className="font-mono">registered</StatusBadge>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="font-mono"
                    active={isExpanded}
                    onClick={() => setExpandedServer(isExpanded ? null : server.name)}
                  >
                    edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="font-mono"
                    disabled={isDeleting}
                    onClick={() => handleDelete(server.name)}
                  >
                    {isDeleting ? 'removing' : 'remove'}
                  </Button>
                </div>
              }
            />

            {/* The editor opens under its own row, on the row's inset. */}
            {isExpanded && (
              <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
                <div className="space-y-2">
                  <PanelCaption>Command</PanelCaption>
                  <Input
                    mono
                    value={state.command}
                    onChange={e => updateEditState(server.name, { command: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <PanelCaption>Arguments</PanelCaption>
                    <Button size="sm" variant="ghost" className="font-mono" onClick={() => addArg(server.name)}>
                      add
                    </Button>
                  </div>
                  {state.args.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">No arguments.</p>
                  )}
                  {state.args.map((arg, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Input
                          mono
                          value={arg}
                          onChange={e => updateArg(server.name, idx, e.target.value)}
                          placeholder={`arg ${idx}`}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="font-mono shrink-0"
                        onClick={() => removeArg(server.name, idx)}
                      >
                        remove
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <PanelCaption>Environment</PanelCaption>
                    <Button size="sm" variant="ghost" className="font-mono" onClick={() => addEnvVar(server.name)}>
                      add
                    </Button>
                  </div>
                  {Object.keys(state.env).length === 0 && (
                    <p className="text-[11px] text-muted-foreground">No environment variables.</p>
                  )}
                  {/* Keyed by position, not by name: the key itself is editable, and
                      the value is a secret whose reveal state must survive a rename. */}
                  {Object.entries(state.env).map(([key, value], idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="w-[40%] shrink-0">
                        <Input
                          mono
                          value={key}
                          onChange={e => updateEnvKey(server.name, key, e.target.value)}
                          placeholder="KEY"
                        />
                      </div>
                      <PasswordInput
                        className="min-w-0 flex-1"
                        value={value}
                        onChange={e => updateEnvValue(server.name, key, e.target.value)}
                        placeholder="value"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="font-mono shrink-0"
                        onClick={() => removeEnvVar(server.name, key)}
                      >
                        remove
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-end">
                  <Button
                    size="sm"
                    variant="primary"
                    className="font-mono"
                    disabled={isSaving}
                    onClick={() => handleSave(server.name)}
                  >
                    {isSaving ? 'saving' : isSaved ? 'saved' : 'save'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
