'use client';

import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createXtermOptions, useTerminalTheme, TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import { attachMouseHandling } from '@/lib/terminal';

interface TerminalProps {
  ptyId?: string;
  onData?: (data: string) => void;
  className?: string;
}

export default function Terminal({ ptyId, onData, className = '' }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Follows the app theme; applied to the live terminal below instead of at
  // init, so a theme flip never tears down the PTY-attached instance.
  const terminalTheme = useTerminalTheme();

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const term = new XTerm({
      ...createXtermOptions(),
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    });

    attachMouseHandling(term);

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle terminal input
    term.onData((data) => {
      const cleaned = data.replace(/\x1b\[(?:I|O)/g, '');
      if (!cleaned) return;
      onData?.(cleaned);

      // If we have a PTY, send input to it
      if (ptyId && window.electronAPI?.pty) {
        window.electronAPI.pty.write({ id: ptyId, data: cleaned });
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ptyId && window.electronAPI?.pty) {
        window.electronAPI.pty.resize({
          id: ptyId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [ptyId, onData]);

  useEffect(() => {
    const cleanup = initTerminal();
    return cleanup;
  }, [initTerminal]);

  // Repaint on app theme change
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  // Listen for PTY data
  useEffect(() => {
    if (!ptyId || !window.electronAPI?.pty) return;

    const unsubscribe = window.electronAPI.pty.onData(({ id, data }) => {
      if (id === ptyId && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    return unsubscribe;
  }, [ptyId]);

  // Public method to write to terminal
  const write = useCallback((data: string) => {
    xtermRef.current?.write(data);
  }, []);

  // Expose write method via ref
  useEffect(() => {
    if (terminalRef.current) {
      (terminalRef.current as HTMLDivElement & { terminalWrite?: (data: string) => void }).terminalWrite = write;
    }
  }, [write]);

  return (
    <div
      ref={terminalRef}
      className={`${TERMINAL_SURFACE_CLASS} rounded-none overflow-hidden ${className}`}
      style={{ minHeight: '200px' }}
    />
  );
}

// Hook for using terminal imperatively
export function useTerminalWriter(terminalRef: React.RefObject<HTMLDivElement>) {
  const write = useCallback((data: string) => {
    const el = terminalRef.current as HTMLDivElement & { terminalWrite?: (data: string) => void };
    el?.terminalWrite?.(data);
  }, [terminalRef]);

  return { write };
}
