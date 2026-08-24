'use client';

import { useEffect, useRef, useState } from 'react';
import { GripVertical, ShieldOff, Bot, Shield, Gauge } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';

interface TerminalPanelHeaderProps {
  agent: AgentStatus;
  isFullscreen: boolean;
  isBroadcasting: boolean;
  tabType: 'custom' | 'project';
  onStart: () => void;
  onStop: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  onClear: () => void;
  onRemove: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/** `completed` is a real runtime status but not part of the design vocabulary. It reads as idle. */
function statusTone(status: AgentStatus['status']): StatusTone {
  return status === 'completed' ? 'idle' : status;
}

export default function TerminalPanelHeader({
  agent,
  isFullscreen,
  isBroadcasting,
  tabType,
  onStart,
  onStop,
  onFullscreen,
  onExitFullscreen,
  onClear,
  onRemove,
  onContextMenu,
}: TerminalPanelHeaderProps) {
  const name = agent.name || `Agent ${agent.id.slice(0, 6)}`;
  const branch = agent.branchName || '';
  // Local (Tasmania) agents carry their model under localModel instead.
  const model = agent.model || agent.localModel || '';
  const isLive = agent.status === 'running' || agent.status === 'waiting';

  const showDragHandle = tabType === 'custom';
  // Neither kind of tab deletes anything from here any more. A custom tab
  // takes the agent off its own membership list; a project board hides the
  // panel and the tab strip puts it back. Deleting for good is its own item
  // below, with its own wording, because it also destroys the worktree.
  const removeLabel = tabType === 'custom' ? 'remove from tab' : 'hide from this board';

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // The same row as every other menu panel in the app: the hidden-agents list
  // on the tab strip and the Dropdown panel both use this. It used to be a
  // 26px mono lowercase row in a 140px box, which was its own idiom and too
  // narrow for a label like "hide from this board".
  const menuItemClass =
    'w-full px-2.5 py-1.5 flex items-center text-left text-xs whitespace-nowrap text-text-secondary hover:bg-secondary hover:text-foreground transition-colors';

  const run = (action: () => void) => () => { setMenuOpen(false); action(); };

  return (
    <div
      className={`${showDragHandle ? 'terminal-drag-handle' : ''} window-no-drag flex items-center gap-2 h-8 px-3 bg-card border-b border-border select-none`}
      onContextMenu={onContextMenu}
    >
      {/* Drag handle grip - custom tabs only */}
      {showDragHandle && (
        <GripVertical className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
      )}

      {/* Agent identity: status square, name, git branch */}
      <StatusSquare tone={statusTone(agent.status)} />
      <span className="text-[11.5px] font-semibold text-foreground truncate max-w-[140px]">{name}</span>
      {branch && (
        <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[120px]">
          {branch}
        </span>
      )}

      {/* Broadcast indicator */}
      {isBroadcasting && (
        <span className="text-[10px] px-1.5 py-0.5 bg-accent-dim text-primary font-medium">
          BROADCAST
        </span>
      )}

      {/* Permission mode indicator */}
      {(agent.permissionMode === 'auto' || (!agent.permissionMode && agent.skipPermissions)) && (
        <span title="Auto mode - runs autonomously">
          <Bot className="w-3 h-3 text-warning" />
        </span>
      )}
      {agent.permissionMode === 'bypass' && (
        <span title="Bypass mode - all permissions skipped">
          <ShieldOff className="w-3 h-3 text-danger" />
        </span>
      )}
      {agent.permissionMode === 'normal' && (
        <span title="Normal mode - asks for permissions">
          <Shield className="w-3 h-3 text-primary" />
        </span>
      )}

      {/* Effort indicator */}
      {agent.effort === 'high' && (
        <span title="High effort - extended thinking">
          <Gauge className="w-3 h-3 text-primary" />
        </span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Which CLI, then which model. The provider was only ever implied by the
          model string, so an agent left on its provider default showed nothing
          at all and you could not tell what would launch. */}
      {agent.provider && (
        <span className="text-[10px] font-mono text-foreground/80 truncate max-w-[70px]">
          {agent.provider}
        </span>
      )}
      {model && (
        <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[90px]">
          {model}
        </span>
      )}

      {/* Start / stop. The panel's primary action, so it is a button you can
          see and hit - not a row inside the overflow menu. A grid of terminals
          with no visible way to launch the CLI is a grid of empty shells. */}
      <button
        type="button"
        onMouseDown={e => e.stopPropagation()}
        onClick={isLive ? onStop : onStart}
        // A bordered 26px row action, like every other action in the app. The
        // first version was accent-filled, which put a solid orange block in
        // every pane header at once - the accent is for one primary action on
        // a screen, not for six of them in a row.
        className={`h-[26px] px-2 text-[11px] font-mono lowercase border transition-colors cursor-pointer ${
          isLive
            ? 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
            : 'border-border-accent text-foreground hover:border-primary hover:text-primary'
        }`}
        title={isLive ? 'Stop this agent' : `Start ${agent.provider ?? 'the CLI'} in this terminal`}
      >
        {isLive ? 'stop' : 'start'}
      </button>

      {/* Overflow menu: clear, fullscreen and remove */}
      <div
        ref={menuRef}
        className="relative [&_button]:cursor-pointer"
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          className={`h-[26px] px-1.5 leading-none text-sm transition-colors ${
            menuOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
          // `title` loses to the visible glyph when a screen reader computes the
          // accessible name, so this button announced itself as "middle dot
          // middle dot middle dot". aria-label wins, and the two menu states are
          // now distinguishable.
          aria-label="Panel actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Panel actions"
        >
          <span aria-hidden>···</span>
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-[90] min-w-[190px] bg-card border border-border">
            <button type="button" onClick={run(onClear)} className={menuItemClass}>clear</button>

            <button
              type="button"
              onClick={run(isFullscreen ? onExitFullscreen : onFullscreen)}
              className={menuItemClass}
            >
              {isFullscreen ? 'exit fullscreen' : 'fullscreen'}
            </button>

            {/* Taking a panel off a board and destroying an agent are two
                different intentions, so they are two different items. */}
            {!isFullscreen && (
              <button type="button" onClick={run(onRemove)} className={menuItemClass}>{removeLabel}</button>
            )}
            {/* No "delete for good" here. Destroying an agent and its worktree
                is not a thing to offer beside "clear" on a board; it lives on
                the Agents page, where the agent itself is managed. */}
          </div>
        )}
      </div>
    </div>
  );
}
