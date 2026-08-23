'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { AgentStatus } from '@/types/electron';
import { BrandSpinner, DialogShell, SegmentedControl } from '@/components/ui';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import 'xterm/css/xterm.css';

import type { AgentTerminalDialogProps, PanelType } from './AgentDialogTypes';
import { isSuperAgent } from './AgentDialogTypes';
import { AgentDialogHeader } from './AgentDialogHeader';
import { AgentDialogFooter } from './AgentDialogFooter';
import { AgentDialogSidebar } from './AgentDialogSidebar';
import { AgentDialogSuperAgentSidebar } from './AgentDialogSuperAgentSidebar';
import { useAgentDialogTerminal } from './useAgentDialogTerminal';
import { useQuickTerminal } from './useQuickTerminal';

/** Width of the permanent right rail. The design does not let it collapse. */
const RAIL_WIDTH = 312;

/**
 * The rail's three tabs. Each one still points at one of the sidebar's
 * accordion panels, so the strip drives the existing content until
 * `AgentDialogSidebar` consumes the tab directly.
 */
const RAIL_TABS = [
  { value: 'git', label: 'Git', panel: 'git' },
  { value: 'memory', label: 'Memory', panel: 'context' },
  { value: 'skills', label: 'Skills', panel: 'settings' },
] as const satisfies readonly { value: string; label: string; panel: PanelType }[];

type RailTab = (typeof RAIL_TABS)[number]['value'];

export default function AgentTerminalDialog({
  agent,
  open,
  onClose,
  onStart,
  onStop,
  projects = [],
  agents = [],
  onBrowseFolder,
  onAgentUpdated,
  onUpdateAgent,
  initialPanel,
  skipHistoricalOutput = false,
}: AgentTerminalDialogProps) {
  const isSuperAgentMode = isSuperAgent(agent);

  // UI state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [railTab, setRailTab] = useState<RailTab>(
    () => RAIL_TABS.find(t => t.panel === initialPanel)?.value ?? 'git',
  );
  const [expandedPanels, setExpandedPanels] = useState<Set<PanelType>>(new Set());
  const [gitBranch, setGitBranch] = useState('');

  // Settings panel state
  const [editPermissionMode, setEditPermissionMode] = useState<'normal' | 'auto' | 'bypass'>('auto');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [customSecondaryPath, setCustomSecondaryPath] = useState('');

  // Track whether we've applied the initialPanel for this agent
  const appliedInitialPanelRef = useRef<string | null>(null);

  // Derived values
  const projectPath = useMemo(
    () => agent?.worktreePath || agent?.projectPath || '',
    [agent?.worktreePath, agent?.projectPath],
  );
  const character = useMemo(
    () => (agent?.name?.toLowerCase() === 'bitwonka' ? 'frog' : agent?.character || 'robot'),
    [agent?.name, agent?.character],
  );
  const hasSecondaryProject = !!agent?.secondaryProjectPath;
  const availableProjects = useMemo(
    () => (agent ? projects.filter(p => p.path !== agent.projectPath && p.path !== agent.worktreePath) : projects),
    [projects, agent?.projectPath, agent?.worktreePath], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Sync permission mode UI state when agent changes
  useEffect(() => {
    setEditPermissionMode(agent?.permissionMode ?? (agent?.skipPermissions ? 'auto' : 'normal'));
    setGitBranch('');
  }, [agent?.id, agent?.permissionMode, agent?.skipPermissions]);

  // Expand initialPanel when the dialog opens for a new agent
  useEffect(() => {
    if (open && agent && initialPanel && appliedInitialPanelRef.current !== agent.id) {
      setExpandedPanels(prev => new Set([...prev, initialPanel]));
      appliedInitialPanelRef.current = agent.id;
    }
    if (!open) appliedInitialPanelRef.current = null;
  }, [open, agent, initialPanel]);

  // Terminal hooks
  const { terminalReady, terminalRef, xtermRef, isAtBottom, scrollToBottom } = useAgentDialogTerminal({
    open,
    agent,
    isFullscreen,
    skipHistoricalOutput,
  });

  const collapseTerminalPanel = useCallback(() => {
    setExpandedPanels(prev => { const s = new Set(prev); s.delete('terminal'); return s; });
  }, []);

  const { quickTerminalReady, quickTerminalRef, quickXtermRef, hasActiveTerminal, closeQuickTerminal } =
    useQuickTerminal({
      agentId: agent?.id,
      projectPath,
      open,
      expandedPanels,
      onCollapseTerminal: collapseTerminalPanel,
    });

  // ── Callbacks ────────────────────────────────────────────────────────────────

  const handleStart = useCallback(() => {
    if (agent && prompt.trim()) {
      onStart(agent.id, prompt.trim());
      setPrompt('');
    }
  }, [agent, prompt, onStart]);

  const handleStop = useCallback(() => {
    if (agent) onStop(agent.id);
  }, [agent, onStop]);

  const handleOpenInFinder = useCallback(async () => {
    if (!projectPath || !window.electronAPI?.shell?.reveal) return;
    try {
      await window.electronAPI.shell.reveal(projectPath);
    } catch (err) {
      console.error('Failed to open Finder:', err);
    }
  }, [projectPath]);

  const togglePanel = useCallback((panel: PanelType) => {
    setExpandedPanels(prev => {
      const next = new Set(prev);
      next.has(panel) ? next.delete(panel) : next.add(panel);
      return next;
    });
  }, []);

  const handleRailTab = useCallback((tab: RailTab) => {
    setRailTab(tab);
    const { panel } = RAIL_TABS.find(t => t.value === tab)!;
    setExpandedPanels(prev => new Set(prev).add(panel));
  }, []);

  const handleSetSecondaryProject = useCallback(async (path: string | null) => {
    if (!agent) return;
    if (path && window.electronAPI?.agent?.sendInput) {
      try {
        await window.electronAPI.agent.sendInput({ id: agent.id, input: `/add-dir ${path}\r` });
      } catch (err) {
        console.error('Failed to send /add-dir command:', err);
      }
    }
    if (window.electronAPI?.agent?.setSecondaryProject) {
      try {
        const result = await window.electronAPI.agent.setSecondaryProject({ id: agent.id, secondaryProjectPath: path });
        if (result.success && result.agent && onAgentUpdated) onAgentUpdated(result.agent);
        if (result.success) setCustomSecondaryPath('');
      } catch (err) {
        console.error('Failed to set secondary project:', err);
      }
    }
  }, [agent, onAgentUpdated]);

  const handleSavePermissionMode = useCallback(async (value: 'normal' | 'auto' | 'bypass') => {
    if (!agent) return;
    setIsSavingSettings(true);
    try {
      const params = { id: agent.id, permissionMode: value };
      const result = onUpdateAgent
        ? await onUpdateAgent(params)
        : await window.electronAPI!.agent.update(params);
      if (result.success && result.agent && onAgentUpdated) onAgentUpdated(result.agent as AgentStatus);
      setEditPermissionMode(value);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setIsSavingSettings(false);
    }
  }, [agent, onUpdateAgent, onAgentUpdated]);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!open || !agent) return null;

  return (
    <DialogShell
      onClose={onClose}
      width={860}
      className="[&_button:not(:disabled)]:cursor-pointer"
    >
      {/* The dialog body is the terminal, so it cancels DialogShell's padding
          and takes a content height instead of a viewport fraction (R11). */}
      <div className="-m-4 flex flex-col h-[620px]">
        <AgentDialogHeader
          agent={agent}
          character={character}
          isFullscreen={isFullscreen}
          hasSecondaryProject={hasSecondaryProject}
          isSuperAgentMode={isSuperAgentMode}
          onStop={handleStop}
          onOpenInFinder={handleOpenInFinder}
          onToggleFullscreen={() => setIsFullscreen(v => !v)}
          onClose={onClose}
        />

        {/* Second header row: where the agent is working on the left, how the
            terminal is scrolling on the right, the rail's tabs above the rail. */}
        <div className="h-9 shrink-0 flex items-stretch border-b border-border bg-card">
          <div className="flex-1 min-w-0 flex items-center justify-between gap-3 px-4">
            <span className="font-mono text-[11px] text-muted-foreground truncate">{projectPath}</span>
            <span className="font-mono text-[11px] text-muted-foreground shrink-0">
              {isAtBottom ? 'scroll locked' : 'scrolled up'}
            </span>
          </div>
          <div
            className="shrink-0 border-l border-border flex items-center px-3"
            style={{ width: RAIL_WIDTH }}
          >
            {!isSuperAgentMode && (
              <SegmentedControl
                options={RAIL_TABS.map(({ value, label }) => ({ value, label }))}
                value={railTab}
                onChange={handleRailTab}
                ariaLabel="Rail section"
              />
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Main terminal area */}
          <div className="flex-1 min-w-0 relative">
            <div
              ref={terminalRef}
              className={`absolute inset-0 p-2 ${TERMINAL_SURFACE_CLASS}`}
              style={{ cursor: 'text' }}
              onClick={() => xtermRef.current?.focus()}
            />
            {!terminalReady && (
              <div className={`absolute inset-0 flex items-center justify-center ${TERMINAL_SURFACE_CLASS}`}>
                <BrandSpinner size={30} label="Loading terminal" />
              </div>
            )}
            {/* Scroll-to-bottom button - appears when user has scrolled up */}
            {terminalReady && !isAtBottom && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 h-[26px] px-2.5 border border-border bg-card font-mono text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors z-10"
              >
                scroll to bottom
              </button>
            )}
          </div>

          {/* Right rail - permanent */}
          <div
            className="shrink-0 border-l border-border bg-card flex flex-col overflow-hidden"
            style={{ width: RAIL_WIDTH }}
          >
            {isSuperAgentMode ? (
              <AgentDialogSuperAgentSidebar agents={agents} projects={projects} />
            ) : (
              <AgentDialogSidebar
                agent={agent}
                projectPath={projectPath}
                expandedPanels={expandedPanels}
                onTogglePanel={togglePanel}
                gitBranch={gitBranch}
                onGitBranchChange={setGitBranch}
                quickTerminalRef={quickTerminalRef}
                quickXtermRef={quickXtermRef}
                quickTerminalReady={quickTerminalReady}
                hasActiveTerminal={hasActiveTerminal}
                onCloseQuickTerminal={closeQuickTerminal}
                hasSecondaryProject={hasSecondaryProject}
                availableProjects={availableProjects}
                customSecondaryPath={customSecondaryPath}
                onCustomSecondaryPathChange={setCustomSecondaryPath}
                onSetSecondaryProject={handleSetSecondaryProject}
                onBrowseFolder={onBrowseFolder}
                editPermissionMode={editPermissionMode}
                isSavingSettings={isSavingSettings}
                onSavePermissionMode={handleSavePermissionMode}
              />
            )}
          </div>
        </div>

        <AgentDialogFooter
          agent={agent}
          prompt={prompt}
          onPromptChange={setPrompt}
          onStart={handleStart}
          onStop={handleStop}
        />
      </div>
    </DialogShell>
  );
}
