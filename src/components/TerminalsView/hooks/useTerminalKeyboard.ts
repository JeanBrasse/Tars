'use client';

import { useEffect, useCallback } from 'react';
import { panelShortcutIndex, rendererPlatform } from '@/lib/terminal-keys';

interface UseTerminalKeyboardOptions {
  panelAgentIds: string[];
  onFocusPanel: (agentId: string) => void;
  onToggleFullscreen: () => void;
  onToggleBroadcast: () => void;
  onToggleSidebar: () => void;
  onNewAgent: () => void;
  onExitFullscreen: () => void;
  onCycleTab: (direction: 'next' | 'prev') => void;
  isFullscreen: boolean;
}

export function useTerminalKeyboard({
  panelAgentIds,
  onFocusPanel,
  onToggleFullscreen,
  onToggleBroadcast,
  onToggleSidebar,
  onNewAgent,
  onExitFullscreen,
  onCycleTab,
  isFullscreen,
}: UseTerminalKeyboardOptions) {
  const platform = rendererPlatform();
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ctrl+Tab / Ctrl+Shift+Tab: Cycle through custom tabs (browser-style)
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      onCycleTab(e.shiftKey ? 'prev' : 'next');
      return;
    }

    // Ctrl+1-9 (Alt+1-9 on Windows, where Ctrl+digit is the page): focus
    // terminal by index
    const index = panelShortcutIndex(e, platform);
    if (index !== null) {
      if (index < panelAgentIds.length) {
        e.preventDefault();
        onFocusPanel(panelAgentIds[index]);
      }
      return;
    }

    // Ctrl+Shift shortcuts
    if (e.ctrlKey && e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          onNewAgent();
          break;
        case 'f':
          e.preventDefault();
          onToggleFullscreen();
          break;
        case 'b':
          e.preventDefault();
          onToggleBroadcast();
          break;
        case 's':
          e.preventDefault();
          onToggleSidebar();
          break;
      }
      return;
    }

    // Escape: exit fullscreen
    if (e.key === 'Escape' && isFullscreen) {
      e.preventDefault();
      onExitFullscreen();
    }
  }, [panelAgentIds, onFocusPanel, onToggleFullscreen, onToggleBroadcast, onToggleSidebar, onNewAgent, onExitFullscreen, onCycleTab, isFullscreen, platform]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
