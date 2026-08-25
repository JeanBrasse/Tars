import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, XCircle } from 'lucide-react';
import { BrandSpinner } from '@/components/ui';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import '@xterm/xterm/css/xterm.css';

interface SkillInstallTerminalProps {
  show: boolean;
  installingSkill: { name: string; repo: string } | null;
  installComplete: boolean;
  installExitCode: number | null;
  terminalRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export default function SkillInstallTerminal({
  show,
  installingSkill,
  installComplete,
  installExitCode,
  terminalRef,
  onClose,
}: SkillInstallTerminalProps) {
  return (
    <AnimatePresence>
      {show && installingSkill && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-scrim backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl bg-bg-secondary border border-border-primary rounded-none overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-none flex items-center justify-center ${
                  installComplete
                    ? installExitCode === 0
                      ? 'bg-accent-green/20'
                      : 'bg-accent-red/20'
                    : 'bg-primary/20'
                }`}>
                  {installComplete ? (
                    installExitCode === 0 ? (
                      <CheckCircle className="w-4 h-4 text-accent-green" />
                    ) : (
                      <XCircle className="w-4 h-4 text-accent-red" />
                    )
                  ) : (
                    <BrandSpinner size={14} />
                  )}
                </div>
                <div>
                  <h3 className="font-semibold">
                    {installComplete
                      ? installExitCode === 0
                        ? 'Installation Complete'
                        : 'Installation Failed'
                      : `Installing ${installingSkill.name}`}
                  </h3>
                  <p className="text-xs text-text-muted font-mono">
                    {installingSkill.repo}/{installingSkill.name}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-bg-tertiary rounded-none"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4">
              <p className="text-xs text-text-muted mb-3">
                Interactive terminal - type your responses and press Enter when prompted.
              </p>
              <div
                ref={terminalRef}
                className={`${TERMINAL_SURFACE_CLASS} rounded-none overflow-hidden`}
                style={{ height: '350px' }}
              />
            </div>

            <div className="px-5 py-4 border-t border-border-primary flex items-center justify-between">
              <p className="text-xs text-text-muted">
                {installComplete
                  ? `Exited with code ${installExitCode}`
                  : 'Waiting for installation to complete...'}
              </p>
              <button
                onClick={onClose}
                className={`px-4 py-2 rounded-none font-medium ${
                  installComplete
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-accent-red/20 text-accent-red hover:bg-accent-red/30'
                }`}
              >
                {installComplete ? 'Done' : 'Cancel'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
