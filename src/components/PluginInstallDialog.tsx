'use client';
import { useEffect, useState, useRef } from 'react';
import { isElectron } from '@/hooks/useElectron';
import { Button, DialogShell } from '@/components/ui';
import { createXtermOptions, TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import 'xterm/css/xterm.css';

interface PluginInstallDialogProps {
  open: boolean;
  command: string;
  title: string;
  onClose: (success?: boolean) => void;
}

export default function PluginInstallDialog({ open, command, title, onClose }: PluginInstallDialogProps) {
  const [installComplete, setInstallComplete] = useState(false);
  const [installExitCode, setInstallExitCode] = useState<number | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import('xterm').Terminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Reset state when opening with new command
  useEffect(() => {
    if (open) {
      setInstallComplete(false);
      setInstallExitCode(null);
      setTerminalReady(false);
    }
  }, [open, command]);

  // Initialize xterm when dialog opens
  useEffect(() => {
    if (!open || !terminalRef.current || xtermRef.current) return;

    const initTerminal = async () => {
      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');

      const term = new Terminal({
        ...createXtermOptions(),
        fontSize: 13,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 10000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current!);
      fitAddon.fit();

      xtermRef.current = term;

      term.onData((data) => {
        const cleaned = data.replace(/\x1b\[(?:I|O)/g, '');
        if (!cleaned) return;
        if (ptyIdRef.current && window.electronAPI?.plugin?.installWrite) {
          window.electronAPI.plugin.installWrite({ id: ptyIdRef.current, data: cleaned });
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (ptyIdRef.current && window.electronAPI?.plugin?.installResize) {
          window.electronAPI.plugin.installResize({
            id: ptyIdRef.current,
            cols: term.cols,
            rows: term.rows,
          });
        }
      });
      resizeObserver.observe(terminalRef.current!);

      setTerminalReady(true);
    };

    initTerminal();

    return () => {
      if (ptyIdRef.current && window.electronAPI?.plugin?.installKill) {
        window.electronAPI.plugin.installKill({ id: ptyIdRef.current });
        ptyIdRef.current = null;
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      setTerminalReady(false);
    };
  }, [open]);

  // Start PTY only after terminal is ready
  useEffect(() => {
    if (!terminalReady || !command || !window.electronAPI?.plugin?.installStart) return;

    const startPty = async () => {
      try {
        const result = await window.electronAPI!.plugin!.installStart({ command });
        ptyIdRef.current = result.id;
      } catch (err) {
        xtermRef.current?.writeln(
          `Failed to start installation: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
        setInstallComplete(true);
        setInstallExitCode(1);
      }
    };

    startPty();
  }, [terminalReady, command]);

  // Listen for PTY data
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.plugin?.onPtyData) return;

    const unsubscribe = window.electronAPI.plugin.onPtyData(({ id, data }) => {
      if (id === ptyIdRef.current && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    return unsubscribe;
  }, []);

  // Listen for PTY exit
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.plugin?.onPtyExit) return;

    const unsubscribe = window.electronAPI.plugin.onPtyExit(({ id, exitCode }) => {
      if (id === ptyIdRef.current) {
        setInstallComplete(true);
        setInstallExitCode(exitCode);
      }
    });

    return unsubscribe;
  }, []);

  const handleClose = () => {
    if (ptyIdRef.current && !installComplete) {
      window.electronAPI?.plugin?.installKill({ id: ptyIdRef.current });
    }
    ptyIdRef.current = null;
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    onClose(installComplete && installExitCode === 0);
  };

  const handleCopyCommand = () => {
    navigator.clipboard?.writeText(command);
  };

  // `claude plugin install <plugin>@<marketplace>` — the marketplace is the one
  // part of the command worth saying in prose; the command itself is shown raw
  // above the terminal.
  const marketplace = command.match(/@([\w.-]+)/)?.[1];

  return (
    <DialogShell
      open={open}
      onClose={handleClose}
      width={860}
      title={`Install ${title}`}
      subtitle={
        marketplace
          ? `From the ${marketplace} marketplace.`
          : 'It runs in Claude Code, in a real terminal.'
      }
      footerLeft={
        installComplete ? (
          <span
            className={`font-mono text-xs ${
              installExitCode === 0 ? 'text-status-running' : 'text-status-error'
            }`}
          >
            exit {installExitCode}
          </span>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">running</span>
        )
      }
      footerRight={
        installComplete ? (
          <>
            <Button onClick={handleCopyCommand}>Copy command</Button>
            <Button variant="primary" onClick={handleClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={handleClose}>Cancel</Button>
            <Button disabled title="The install is still running.">
              Close when done
            </Button>
          </>
        )
      }
    >
      <div className="mb-3 px-3 py-2 bg-bg-tertiary font-mono text-xs leading-relaxed text-foreground break-all whitespace-pre-wrap">
        {command}
      </div>
      <div
        ref={terminalRef}
        className={`overflow-hidden ${TERMINAL_SURFACE_CLASS}`}
        style={{ height: '400px' }}
      />
    </DialogShell>
  );
}
