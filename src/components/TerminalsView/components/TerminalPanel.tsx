'use client';

import { memo, useRef, useEffect, useCallback, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { AgentStatus } from '@/types/electron';
import TerminalPanelHeader from './TerminalPanelHeader';

interface TerminalPanelProps {
  agent: AgentStatus;
  isFullscreen: boolean;
  isBroadcasting: boolean;
  isFocused: boolean;
  tabType: 'custom' | 'project';
  onRegisterContainer: (agentId: string, container: HTMLDivElement | null) => void;
  onStart: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onClear: (agentId: string) => void;
  onFullscreen: (agentId: string) => void;
  onExitFullscreen: () => void;
  onFocus: (agentId: string) => void;
  onContextMenu: (e: React.MouseEvent, agentId: string) => void;
}

// Boards with many panels re-render this on every agents:tick otherwise: the
// parent (TerminalsView/TerminalGrid) re-renders on any agent's status
// change, board-wide, and with no memo here every panel re-ran its render
// body - including the xterm-hosting one - even for agents nothing about
// changed. Default (shallow, per-prop Object.is) comparison is enough
// because `agent` is only ever a new object when that specific agent's own
// data changed (see useElectronAgents' onTick reducer and the filteredAgents
// bail-out in TerminalsView/index.tsx), and every callback prop is a stable
// useCallback/useMemo by the time it reaches here.
function TerminalPanel({
  agent,
  isFullscreen,
  isBroadcasting,
  isFocused,
  tabType,
  onRegisterContainer,
  onStart,
  onStop,
  onRemove,
  onClear,
  onFullscreen,
  onExitFullscreen,
  onFocus,
  onContextMenu,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onRegisterRef = useRef(onRegisterContainer);
  onRegisterRef.current = onRegisterContainer;

  // Make this panel a drop target for skills. `data` has to be referentially
  // stable across renders where agent.id hasn't changed: dnd-kit stores it
  // straight into DndContext's own droppable registry, which every other
  // useDroppable/useDraggable in the tree reads from - a fresh object literal
  // here changed that registry, and its context value, on every render of
  // this one panel, so a single agent's tick re-rendered every OTHER panel
  // via dnd-kit's context regardless of the memo above.
  const dropData = useMemo(() => ({ type: 'terminal-panel' as const, agentId: agent.id }), [agent.id]);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `panel-${agent.id}`, data: dropData });

  // Register container for xterm mounting - only on mount or agent ID change.
  // Uses a ref for the callback to avoid re-registering when the parent
  // re-creates the callback (e.g. on agents poll or font size change).
  //
  // The cleanup is load-bearing: this effect used to return nothing, so an
  // unmounted panel left its xterm alive in useMultiTerminal's map with
  // disposed:false. Going fullscreen (TerminalGrid swaps ReactGridLayout for a
  // plain div) or switching project tabs unmounts every other panel, and those
  // detached emulators kept parsing every PTY chunk into a 10k-line scrollback
  // and kept receiving broadcast-mode keystrokes meant for the visible set.
  // Passing null unregisters + disposes (registerContainer treats a null
  // container as "this panel is gone").
  useEffect(() => {
    const agentId = agent.id;
    if (containerRef.current) {
      onRegisterRef.current(agentId, containerRef.current);
    }
    return () => {
      onRegisterRef.current(agentId, null);
    };
  }, [agent.id]);

  const handleClick = useCallback(() => {
    onFocus(agent.id);
  }, [agent.id, onFocus]);

  const handleStart = useCallback(() => onStart(agent.id), [agent.id, onStart]);
  const handleStop = useCallback(() => onStop(agent.id), [agent.id, onStop]);
  const handleRemove = useCallback(() => onRemove(agent.id), [agent.id, onRemove]);
  const handleClear = useCallback(() => onClear(agent.id), [agent.id, onClear]);
  const handleFullscreen = useCallback(() => onFullscreen(agent.id), [agent.id, onFullscreen]);
  const handleContextMenu = useCallback((e: React.MouseEvent) => onContextMenu(e, agent.id), [agent.id, onContextMenu]);

  return (
    <div
      ref={setDropRef}
      className={`
        flex flex-col overflow-hidden h-full bg-background border transition-colors
        ${isOver ? 'border-primary' : isFocused ? 'border-border-accent' : 'border-border'}
        ${isFullscreen ? 'fixed inset-0 z-[80] window-no-drag pt-7' : ''}
      `}
      onClick={handleClick}
    >
      {/* Header */}
      <TerminalPanelHeader
        agent={agent}
        isFullscreen={isFullscreen}
        isBroadcasting={isBroadcasting}
        tabType={tabType}
        onStart={handleStart}
        onStop={handleStop}
        onFullscreen={handleFullscreen}
        onExitFullscreen={onExitFullscreen}
        onClear={handleClear}
        onRemove={handleRemove}
        onContextMenu={handleContextMenu}
      />

      {/* Terminal body */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden relative bg-background"
      />
    </div>
  );
}

export default memo(TerminalPanel);
