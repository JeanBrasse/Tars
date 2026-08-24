import { useState, useEffect } from 'react';
import { Toggle } from '@/components/Settings/Toggle';
import { isElectron } from '@/hooks/useElectron';
import { OPTION_ROW } from './OptionsRow';

// Module-level cache: avoids re-running the slow IPC call every time the step mounts
let cachedStatus: 'configured' | 'not-configured' | 'error' | null = null;
let cachedError: string | null = null;

interface OrchestratorModeToggleProps {
  isOrchestrator: boolean;
  onToggle: (enabled: boolean) => void;
}

export default function OrchestratorModeToggle({
  isOrchestrator,
  onToggle,
}: OrchestratorModeToggleProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'configured' | 'not-configured' | 'error'>(
    cachedStatus ?? 'idle'
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(cachedError);
  const [isSettingUp, setIsSettingUp] = useState(false);

  useEffect(() => {
    // Use cached result if available - instant, no IPC call
    if (cachedStatus) {
      setStatus(cachedStatus);
      setErrorMessage(cachedError);
      return;
    }

    const checkStatus = async () => {
      if (!window.electronAPI?.orchestrator?.getStatus) {
        cachedStatus = 'error';
        cachedError = 'Orchestrator API not available';
        setStatus('error');
        setErrorMessage(cachedError);
        return;
      }

      setStatus('loading');
      try {
        const result = await window.electronAPI.orchestrator.getStatus();
        if (result.error) {
          cachedStatus = 'error';
          cachedError = result.error;
          setStatus('error');
          setErrorMessage(result.error);
        } else if (result.configured) {
          cachedStatus = 'configured';
          cachedError = null;
          setStatus('configured');
        } else {
          cachedStatus = 'not-configured';
          cachedError = null;
          setStatus('not-configured');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        cachedStatus = 'error';
        cachedError = msg;
        setStatus('error');
        setErrorMessage(msg);
      }
    };

    checkStatus();
  }, []);

  /**
   * The MCP config is no longer a separate Enable/Remove pair: switching the
   * toggle on is what installs it. Switching off only drops the flag on this
   * agent - the server stays configured for the others.
   */
  const handleToggle = async () => {
    if (isOrchestrator) {
      onToggle(false);
      return;
    }

    if (status === 'configured') {
      onToggle(true);
      return;
    }

    if (!window.electronAPI?.orchestrator?.setup) return;

    setIsSettingUp(true);
    setErrorMessage(null);

    try {
      const result = await window.electronAPI.orchestrator.setup();
      if (result.success) {
        cachedStatus = 'configured';
        cachedError = null;
        setStatus('configured');
        onToggle(true);
      } else {
        setErrorMessage(result.error || 'Setup failed');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSettingUp(false);
    }
  };

  if (!isElectron()) {
    return null;
  }

  const busy = status === 'loading' || isSettingUp;

  // The same row rule as every other option, not a copy of it: this one is not
  // an OptionRow only because its hint doubles as the error message.
  return (
    <div className={OPTION_ROW}>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">Orchestrator mode</p>
        <p className={`text-[11px] ${errorMessage ? 'text-danger' : 'text-muted-foreground'}`}>
          {errorMessage || 'It hands work to other agents and cannot write files itself.'}
        </p>
      </div>
      <div className="shrink-0">
        <Toggle
          enabled={isOrchestrator && status === 'configured'}
          onChange={handleToggle}
          disabled={busy}
        />
      </div>
    </div>
  );
}
