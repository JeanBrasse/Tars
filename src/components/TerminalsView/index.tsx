'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { isElectron } from '@/hooks/useElectron';
import { DndContext } from '@dnd-kit/core';
import { useElectronAgents, useElectronFS, useElectronSkills } from '@/hooks/useElectron';
import { useMultiTerminal } from './hooks/useMultiTerminal';
import { useTerminalGrid } from './hooks/useTerminalGrid';
import { useTabManager } from './hooks/useTabManager';
import { useBroadcast } from './hooks/useBroadcast';
import { useTerminalKeyboard } from './hooks/useTerminalKeyboard';
import { useTerminalSearch } from './hooks/useTerminalSearch';
import { useTerminalContextMenu } from './hooks/useTerminalContextMenu';
import { useTerminalDnd } from './hooks/useTerminalDnd';
import { getAutoLayout } from './constants';
import type { LayoutPreset } from './types';
import TerminalGrid from './components/TerminalGrid';
import ProjectTabBar from './components/ProjectTabBar';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import BroadcastIndicator from './components/BroadcastIndicator';
import ContextMenu from './components/ContextMenu';
import 'xterm/css/xterm.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// Lazy-load NewChatModal only when needed
import dynamic from 'next/dynamic';
const NewChatModal = dynamic(() => import('@/components/NewChatModal'), { ssr: false });

/** Set once per window: this is what makes autostart a launch event rather
 *  than a navigation one. */
const LAUNCH_AUTOSTART_KEY = 'tars-launch-autostart-done';

export default function TerminalsView() {
  const {
    agents,
    isLoading,
    startAgent,
    stopAgent,
    removeAgent,
    sendInput,
    createAgent,
  } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();
  const { installedSkills, refresh: refreshSkills } = useElectronSkills();

  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [viewFullscreen, setViewFullscreen] = useState(false);
  const lastCustomTabRef = useRef<{ type: 'custom'; tabId: string } | null>(null);
  const [terminalFontSize, setTerminalFontSize] = useState(11);
  const pendingStartRef = useRef<{ agentId: string; prompt: string; options?: { model?: string; provider?: import('@/types/electron').AgentProvider; localModel?: string } } | null>(null);
  const [terminalTheme, setTerminalTheme] = useState<'dark' | 'light'>('dark');
  const [terminalSettingsLoaded, setTerminalSettingsLoaded] = useState(!isElectron());
  // Remember last focused agent per custom tab so Ctrl+Tab restores focus where the user left it
  const lastFocusedByTabRef = useRef<Map<string, string>>(new Map());
  // Set by handleCycleTab; consumed by handleTerminalReady once the destination
  // tab's terminal finishes async init. Also consumed inline if the terminal is
  // already mounted (fast tab cycling).
  const pendingFocusRef = useRef<string | null>(null);
  // undefined until settings load, so the autostart effect waits rather than
  // guessing and starting agents the user has turned this off for.
  const [autoStartOnLaunch, setAutoStartOnLaunch] = useState<boolean | undefined>(undefined);

  // Load terminal settings from app settings
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.appSettings) {
      setTerminalSettingsLoaded(true);
      return;
    }
    window.electronAPI.appSettings.get().then((settings) => {
      if (settings) {
        if (settings.terminalFontSize) setTerminalFontSize(settings.terminalFontSize);
        if (settings.terminalTheme) setTerminalTheme(settings.terminalTheme);
        setAutoStartOnLaunch(settings.autoStartAgentsOnLaunch !== false);
      }
      setTerminalSettingsLoaded(true);
    });
  }, []);

  // Tab manager - core state for two-tier tab system
  const allAgentIds = useMemo(() => agents.map(a => a.id), [agents]);


  // Project folders with agents - offered as one-click boards in the tab bar
  const projectGroups = useMemo(() => {
    const byPath = new Map<string, string[]>();
    for (const a of agents) {
      if (!byPath.has(a.projectPath)) byPath.set(a.projectPath, []);
      byPath.get(a.projectPath)!.push(a.id);
    }
    return Array.from(byPath.entries()).map(([path, agentIds]) => ({
      name: path.split('/').pop() || path,
      path,
      agentIds,
    }));
  }, [agents]);
  const tabManager = useTabManager({ existingAgentIds: allAgentIds, isLoading });
  // Pull out the stable pieces: useTabManager returns a fresh object literal on
  // every render, so anything that depends on `tabManager` itself is unstable.
  const { activeTab, setActiveTab } = tabManager;

  // Project paths that currently have at least one agent. Keyed as a string so
  // the array identity survives an agents:tick that didn't change the set —
  // otherwise the effect below would re-run twice a second. NUL is the one byte
  // a filesystem path cannot contain, so the join/split round-trip is lossless.
  const agentProjectPathsKey = useMemo(
    () => Array.from(new Set(agents.map(a => a.projectPath).filter(Boolean))).join('\u0000'),
    [agents]
  );
  const agentProjectPaths = useMemo(
    () => (agentProjectPathsKey ? agentProjectPathsKey.split('\u0000') : []),
    [agentProjectPathsKey]
  );

  // The board is project-driven: land on a real project instead of the empty
  // default custom tab, and follow along when the current project loses its
  // agents.
  //
  // This used to depend on the whole `tabManager` object and to redirect
  // whenever the active tab was not a project tab. Because that object is a new
  // literal every render the effect re-ran constantly, and — worse — it bounced
  // the user off any custom tab on the very next commit. Clicking the
  // already-active project tab runs the toggle-off branch below, which selects a
  // custom tab; the effect immediately forced the project tab back, unmounting
  // and remounting every TerminalPanel, which disposes and rebuilds every xterm
  // and replays each agent's full scrollback over IPC. So: depend only on the
  // stable `setActiveTab` plus the exact values read, and redirect only when the
  // active tab is genuinely unusable — never over a deliberately chosen custom tab.
  const didLandOnProjectRef = useRef(false);
  useEffect(() => {
    if (isLoading || agentProjectPaths.length === 0) return;
    if (activeTab.type === 'project') {
      didLandOnProjectRef.current = true;
      // Follow along only if this project no longer has any agents.
      if (!agentProjectPaths.includes(activeTab.projectPath)) {
        setActiveTab({ type: 'project', projectPath: agentProjectPaths[0] });
      }
      return;
    }
    // Custom tab: take over exactly once, to replace the empty default board on
    // first load. After that the user's tab choice stands.
    if (!didLandOnProjectRef.current) {
      didLandOnProjectRef.current = true;
      setActiveTab({ type: 'project', projectPath: agentProjectPaths[0] });
    }
  }, [activeTab, agentProjectPaths, isLoading, setActiveTab]);

  // Derive agents for current active tab
  const filteredAgents = useMemo(() => {
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      // Custom tab: agents in tab order
      const idSet = new Set(tabManager.activeCustomTab.agentIds);
      const agentMap = new Map(agents.map(a => [a.id, a]));
      return tabManager.activeCustomTab.agentIds
        .map(id => agentMap.get(id))
        .filter((a): a is NonNullable<typeof a> => !!a);
    }
    if (tabManager.isProjectTabActive && tabManager.activeProjectPath) {
      // Project tab: all agents for that project
      return agents.filter(a => a.projectPath === tabManager.activeProjectPath);
    }
    return [];
  }, [agents, tabManager.isCustomTabActive, tabManager.isProjectTabActive, tabManager.activeCustomTab, tabManager.activeProjectPath]);

  // Derive grid preset and editable state. A project tab has no stored layout,
  // so it follows the agent count instead of being frozen at 3x3 (four agents
  // must read as 2x2, not three on row one plus an orphan).
  const gridPreset: LayoutPreset = tabManager.activeCustomTab?.layout ?? getAutoLayout(filteredAgents.length);
  const isEditable = tabManager.isCustomTabActive;
  const tabType: 'custom' | 'project' = tabManager.isCustomTabActive ? 'custom' : 'project';
  const tabId = tabManager.isCustomTabActive && tabManager.activeCustomTab
    ? tabManager.activeCustomTab.id
    : tabManager.activeProjectPath || 'default';

  // Agent IDs for grid
  const agentIds = useMemo(() => filteredAgents.map(a => a.id), [filteredAgents]);

  // Set after multiTerminal is created; lets handleTerminalReady consume
  // pendingFocusRef without a circular dep.
  const focusTerminalRef = useRef<((agentId: string) => void) | null>(null);

  // Called when a terminal is fully initialized - fire any deferred agent start
  // and consume any pending Ctrl+Tab focus targeting this agent.
  const handleTerminalReady = useCallback((agentId: string) => {
    const pending = pendingStartRef.current;
    if (pending && pending.agentId === agentId) {
      pendingStartRef.current = null;
      startAgent(pending.agentId, pending.prompt, pending.options as { model?: string; resume?: boolean }).catch(error => {
        console.error('Failed to start agent after creation:', error);
      });
    }
    if (pendingFocusRef.current === agentId) {
      pendingFocusRef.current = null;
      focusTerminalRef.current?.(agentId);
    }
  }, [startAgent]);

  // Broadcast must be initialized before multiTerminal so we can pass broadcastMode
  const broadcast = useBroadcast();

  // Core hooks - delay terminal init until settings are loaded to avoid wrong font size
  const multiTerminal = useMultiTerminal({
    agents: terminalSettingsLoaded ? filteredAgents : [],
    initialFontSize: terminalFontSize,
    onFontSizeChange: (size) => {
      setTerminalFontSize(size);
      if (isElectron() && window.electronAPI?.appSettings) {
        window.electronAPI.appSettings.save({ terminalFontSize: size });
      }
    },
    theme: terminalTheme,
    onTerminalReady: handleTerminalReady,
    broadcastMode: broadcast.broadcastMode,
  });
  // Expose focusTerminal to handleTerminalReady via a ref to break the cycle.
  focusTerminalRef.current = multiTerminal.focusTerminal;

  // Prune lastFocusedByTabRef entries for tabs that no longer exist (mirrors
  // the cleanup useTabManager does for stale agent IDs and tab layouts).
  useEffect(() => {
    const validIds = new Set(tabManager.customTabs.map(t => t.id));
    for (const tabId of lastFocusedByTabRef.current.keys()) {
      if (!validIds.has(tabId)) lastFocusedByTabRef.current.delete(tabId);
    }
  }, [tabManager.customTabs]);

  const grid = useTerminalGrid({ agentIds, preset: gridPreset, isEditable, tabId });
  const search = useTerminalSearch(filteredAgents);
  const contextMenu = useTerminalContextMenu();

  // Dnd hook
  const dnd = useTerminalDnd({
    onSkillDrop: async (skillName, agentId) => {
      await sendInput(agentId, `use this skill: ${skillName}\n`);
    },
  });

  // Handler callbacks
  // The main process refuses to start an agent whose folder is gone. That
  // rejection has to reach the screen: it used to be an unhandled promise, so
  // the click looked like it had worked and nothing happened.
  const [startError, setStartError] = useState<string | null>(null);
  const handleStartAgent = useCallback(async (agentId: string) => {
    setStartError(null);
    try {
      await startAgent(agentId, '', { resume: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // IPC wraps the main-process message; keep only the part worth reading.
      setStartError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    }
  }, [startAgent]);

  const handleStopAgent = useCallback(async (agentId: string) => {
    await stopAgent(agentId);
  }, [stopAgent]);

  // Remove from tab (custom tabs): stop agent + remove from tab membership
  const handleRemoveFromTab = useCallback(async (agentId: string) => {
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      await stopAgent(agentId);
      tabManager.removeAgentFromTab(tabManager.activeCustomTab.id, agentId);
    }
  }, [stopAgent, tabManager]);

  // For project tabs: full remove (backwards compat)
  const handleRemoveAgent = useCallback(async (agentId: string) => {
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      // Custom tab: remove from tab, stop agent
      await stopAgent(agentId);
      tabManager.removeAgentFromTab(tabManager.activeCustomTab.id, agentId);
    } else {
      // Project tab: actual remove
      multiTerminal.unregisterContainer(agentId);
      await removeAgent(agentId);
    }
  }, [stopAgent, removeAgent, multiTerminal, tabManager]);

  const handleFocusPanel = useCallback((agentId: string) => {
    setFocusedPanelId(agentId);
    multiTerminal.focusTerminal(agentId);
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      lastFocusedByTabRef.current.set(tabManager.activeCustomTab.id, agentId);
    }
  }, [multiTerminal, tabManager]);

  // Ctrl+Tab / Ctrl+Shift+Tab: cycle through custom tabs (browser-style),
  // restoring focus to the last focused agent in the destination tab.
  const handleCycleTab = useCallback((direction: 'next' | 'prev') => {
    const tabs = tabManager.customTabs;
    if (tabs.length < 2) return;

    const currentIdx = tabManager.isCustomTabActive && tabManager.activeCustomTab
      ? tabs.findIndex(t => t.id === tabManager.activeCustomTab!.id)
      : 0;
    const step = direction === 'next' ? 1 : tabs.length - 1;
    const nextTab = tabs[(currentIdx + step) % tabs.length];

    // Resolve the focus target: last focused agent in the destination tab if
    // it's still a member, otherwise the first agent. Empty tabs get nothing.
    const remembered = lastFocusedByTabRef.current.get(nextTab.id);
    const targetAgentId = remembered && nextTab.agentIds.includes(remembered)
      ? remembered
      : nextTab.agentIds[0];

    tabManager.setActiveTab({ type: 'custom', tabId: nextTab.id });

    if (targetAgentId) {
      setFocusedPanelId(targetAgentId);
      // Switching tabs re-mounts terminals (registerContainer disposes the old
      // one and asynchronously inits a new xterm). Stash the focus target -
      // handleTerminalReady will consume it once the new terminal is ready.
      pendingFocusRef.current = targetAgentId;
      // Also try immediately in case the terminal happens to already be live
      // (no-op if it's not yet registered).
      multiTerminal.focusTerminal(targetAgentId);
    }
  }, [tabManager, multiTerminal]);

  // Keyboard shortcuts (must come after handler declarations to avoid TDZ)
  const visibleAgentIds = useMemo(
    () => grid.visiblePanels.map(p => p.agentId),
    [grid.visiblePanels]
  );

  useTerminalKeyboard({
    panelAgentIds: visibleAgentIds,
    onFocusPanel: handleFocusPanel,
    onToggleFullscreen: () => grid.toggleFullscreen(focusedPanelId || undefined),
    onToggleBroadcast: broadcast.toggleBroadcast,
    onToggleSidebar: () => { },
    onNewAgent: () => setShowNewChatModal(true),
    onExitFullscreen: grid.exitFullscreen,
    onCycleTab: handleCycleTab,
    isFullscreen: !!grid.fullscreenPanelId,
  });

  const handleCopyOutput = useCallback(async (agentId: string) => {
    // The list no longer carries the scrollback, so ask for this one agent.
    const full = await window.electronAPI?.agent?.get(agentId);
    const output = full?.output?.join('') ?? '';
    if (output) navigator.clipboard.writeText(output).catch(() => { });
  }, []);

  const handleNewAgent = useCallback(async (
    projectPath: string,
    skills: string[],
    prompt: string,
    model?: string,
    worktree?: { enabled: boolean; branchName: string },
    character?: string,
    name?: string,
    secondaryProjectPath?: string,
    permissionMode?: 'normal' | 'auto' | 'bypass',
    provider?: import('@/types/electron').AgentProvider,
    localModel?: string,
    obsidianVaultPaths?: string[],
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    orchestratorMode?: boolean,
    cliPath?: string,
  ) => {
    const resolvedModel = (provider !== 'local' && model && model !== 'default') ? model : undefined;
    const agent = await createAgent({
      projectPath,
      skills,
      worktree,
      character: character as import('@/types/electron').AgentCharacter,
      name,
      secondaryProjectPath,
      permissionMode,
      effort,
      provider,
      model: resolvedModel,
      localModel,
      obsidianVaultPaths,
      orchestratorMode,
      cliPath,
    });
    // Auto-add to active custom tab
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      tabManager.addAgentToTab(tabManager.activeCustomTab.id, agent.id);
    }
    // Defer start until the terminal for this agent is initialized.
    // The onTerminalReady callback will fire startAgent once xterm is ready.
    if (prompt) {
      pendingStartRef.current = { agentId: agent.id, prompt, options: { model: resolvedModel, provider, localModel } };
    }
    setShowNewChatModal(false);
  }, [createAgent, tabManager]);

  // Each project starts its agents once, the first time you look at it.
  //
  // The original code resumed every idle agent on every mount, so leaving the
  // dashboard and coming back silently spawned sessions nobody asked for and
  // burned tokens - which is why it was removed wholesale. That also removed
  // what people actually want: open a project and see the CLI already running
  // instead of a bare shell with a button to press.
  //
  // The seen-set is what separates the two. A project is auto-started the first
  // time it is displayed in this window and never again, so switching tabs back
  // and forth stays inert. It is per window, so quitting and relaunching gives
  // you a running board again.
  const startedProjectsRef = useRef<Set<string>>(new Set());
  const visibleProjectPath = tabManager.activeTab.type === 'project' ? tabManager.activeTab.projectPath : null;

  useEffect(() => {
    if (isLoading) return;                           // wait for the real list
    if (autoStartOnLaunch === undefined) return;     // wait for settings
    if (!autoStartOnLaunch) return;
    if (typeof window === 'undefined') return;

    // Which agents are on screen right now: the open project, or everything on
    // a custom tab.
    const onScreen = visibleProjectPath
      ? agents.filter(a => a.projectPath === visibleProjectPath)
      : filteredAgents;
    if (onScreen.length === 0) return;

    const scope = visibleProjectPath ?? '__custom__';
    if (startedProjectsRef.current.has(scope)) return;
    startedProjectsRef.current.add(scope);

    // Only agents left with no live terminal. One already attached to a PTY is
    // mid-session and must not be resumed underneath it. A missing folder is
    // refused by the main process anyway, but skip it rather than collect an
    // error banner on every project you open.
    const toResume = onScreen.filter(a => !a.ptyId && a.status === 'idle' && !a.pathMissing);
    for (const agent of toResume) {
      startAgent(agent.id, '', { resume: true }).catch(err => {
        console.error(`[autostart] ${agent.name || agent.id}:`, err);
      });
    }
  }, [agents, filteredAgents, visibleProjectPath, isLoading, autoStartOnLaunch, startAgent]);

  // Exit view fullscreen on Escape
  useEffect(() => {
    if (!viewFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewFullscreen]);

  // Re-fit terminals when the view goes fullscreen.
  //
  // multiTerminal is a fresh object every render, so depending on it re-ran
  // this on every agents:tick — a full xterm refit of every pane, twice a
  // second. Only the fullscreen flag should trigger it.
  const fitAllRef = useRef(multiTerminal.fitAll);
  useEffect(() => {
    fitAllRef.current = multiTerminal.fitAll;
  });
  useEffect(() => {
    const timer = setTimeout(() => fitAllRef.current(), 100);
    return () => clearTimeout(timer);
  }, [viewFullscreen]);

  // Branch of the tab the board is showing - the focused agent wins, otherwise
  // the first one in the tab. Feeds the status bar's right-hand slot.
  const currentBranch = useMemo(() => {
    const focused = filteredAgents.find(a => a.id === focusedPanelId);
    return (focused ?? filteredAgents[0])?.branchName;
  }, [filteredAgents, focusedPanelId]);

  return (
    <DndContext sensors={dnd.sensors} onDragEnd={dnd.handleDragEnd}>
      <div className={`flex flex-col overflow-hidden ${viewFullscreen ? 'fixed inset-0 z-[100] bg-background window-no-drag pt-7' : 'h-full w-full relative'}`}>
        {/* Broadcast overlay */}
        <BroadcastIndicator active={broadcast.broadcastMode} />

        {/* Project tabs - the board follows your project folders. First element
            of the frame: the layout and + Terminal controls live in the page
            header now, not in a toolbar above the strip. */}
        <ProjectTabBar
          agents={agents}
          activeTab={tabManager.activeTab}
          onSelectProject={(path) => {
            if (tabManager.activeTab.type === 'project' && tabManager.activeTab.projectPath === path) {
              // Toggle off: restore last custom tab, or fallback to first
              const restore = lastCustomTabRef.current;
              const target = restore && tabManager.customTabs.find(t => t.id === restore.tabId)
                ? restore
                : tabManager.customTabs[0] ? { type: 'custom' as const, tabId: tabManager.customTabs[0].id } : null;
              if (target) tabManager.setActiveTab(target);
            } else {
              // Save current custom tab before switching to project view
              if (tabManager.activeTab.type === 'custom') {
                lastCustomTabRef.current = { type: 'custom', tabId: tabManager.activeTab.tabId };
              }
              tabManager.setActiveTab({ type: 'project', projectPath: path });
            }
          }}
        />

        {/* A start that was refused. The main process explains why - a folder
            that no longer exists is the common one - and this is the only place
            the user would ever see it. */}
        {startError && (
          <div className="mt-2 flex items-center gap-3 border border-danger/40 bg-danger-muted px-3 py-2">
            <span className="w-1.5 h-1.5 bg-danger shrink-0" />
            <p className="flex-1 text-xs text-foreground">{startError}</p>
            <button
              type="button"
              onClick={() => setStartError(null)}
              className="font-mono text-[11px] lowercase text-muted-foreground hover:text-foreground cursor-pointer"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Terminal grid - takes full space, relative for sidebar panel */}
        <div className="flex-1 min-h-0 relative mt-2">
          <TerminalGrid
            agents={filteredAgents}
            visiblePanels={grid.visiblePanels}
            rglLayout={grid.rglLayout}
            cols={grid.cols}
            rows={grid.gridDefinition.rows}
            onDragStop={grid.onDragStop}
            broadcastMode={broadcast.broadcastMode}
            focusedPanelId={focusedPanelId}
            fullscreenPanelId={grid.fullscreenPanelId}
            isLoading={isLoading}
            isEditable={isEditable}
            tabType={tabType}
            onRegisterContainer={multiTerminal.registerContainer}
            onStartAgent={handleStartAgent}
            onStopAgent={handleStopAgent}
            onRemoveAgent={handleRemoveAgent}
            onClearTerminal={multiTerminal.clearTerminal}
            onFullscreenPanel={grid.fullscreenPanel}
            onExitFullscreen={grid.exitFullscreen}
            onFocusPanel={handleFocusPanel}
            onContextMenu={contextMenu.openMenu}
            onFitAll={multiTerminal.fitAll}
          />

          {/* Sidebar panel - overlays grid from the right */}
          <Sidebar
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            agents={filteredAgents}
            focusedPanelId={focusedPanelId}
            onFocusPanel={handleFocusPanel}
            onStartAgent={handleStartAgent}
            onStopAgent={handleStopAgent}
            installedSkills={installedSkills}
          />
        </div>

        {/* Status bar - full-bleed chrome at the bottom of the frame */}
        <StatusBar agents={filteredAgents} branch={currentBranch} />

        {/* Context menu */}
        <ContextMenu
          state={contextMenu.menuState}
          agent={contextMenu.menuState.agentId ? agents.find(a => a.id === contextMenu.menuState.agentId) || null : null}
          onClose={contextMenu.closeMenu}
          onStart={handleStartAgent}
          onStop={handleStopAgent}
          onClear={multiTerminal.clearTerminal}
          onFullscreen={grid.fullscreenPanel}
          onCopyOutput={handleCopyOutput}
        />

        {/* New Chat Modal */}
        {showNewChatModal && (
          <NewChatModal
            open={showNewChatModal}
            onClose={() => setShowNewChatModal(false)}
            onSubmit={handleNewAgent}
            projects={projects}
            onBrowseFolder={openFolderDialog}
            installedSkills={installedSkills}
            onRefreshSkills={refreshSkills}
          />
        )}
      </div>
    </DndContext>
  );
}
