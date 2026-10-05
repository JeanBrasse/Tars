import { spawn, type ChildProcess } from 'child_process';
import { refuseWhileQuitting } from './quit-state';

/**
 * `<binary> --version`, run so that the quit ends it.
 *
 * Settings asks each CLI for its version (`shell:version`: amp, gemini, codex
 * and the rest) and Settings > System asks claude, with an 8 s timeout. Those
 * were plain execFile calls the quit knew nothing of: amp, started just before
 * a quit, kept writing into the home after Tars was gone (the Audit's gate of
 * #298, measured by QA's bench). Each probe now runs in a process group of its
 * own, so what it starts ends with it, and the quit's first pass ends every
 * group still running (endVersionProbes, main.ts). One asked for during the
 * quit is refused.
 */

const running = new Set<ChildProcess>();

/** The probe's whole group, then the probe itself should it have left it. */
function end(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

export function probeVersion(
  binary: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    refuseWhileQuitting('version probe');
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    // detached: a group of its own, which end() can signal whole; a timeout on
    // the binary alone would leave what it started running.
    const child = spawn(binary, ['--version'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += String(d); });
    child.stderr?.on('data', d => { stderr += String(d); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; end(child); }, timeoutMs);
    const settle = (err: Error | null) => {
      clearTimeout(timer);
      if (!running.delete(child) && !err) err = new Error(`${binary} --version was ended by the quit`);
      end(child);
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };
    child.on('error', err => settle(err));
    child.on('close', (code, signal) => {
      if (timedOut) settle(new Error(`${binary} --version did not answer in ${timeoutMs} ms`));
      else if (code === 0) settle(null);
      else settle(new Error(`${binary} --version ${signal ? `was ended by ${signal}` : `exited with ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/** Ends every probe still running and what it started. For the quit. */
export function endVersionProbes(): void {
  for (const child of running) end(child);
  running.clear();
}
