import * as pty from 'node-pty';
import { managedCliEnv } from '../providers/cli-provider';

/**
 * Spawn the PTY an agent's CLI runs in.
 *
 * There are two of these, and only two: initAgentPty for a restored or
 * renderer-started agent, and spawnAgentSession for every API-driven one
 * (delegation, /dispatch, /message, /start). They assemble their environments
 * separately and always have, which is how DISABLE_AUTOUPDATER shipped on one
 * path and not the other, and how armTaskStartWatch did the same thing a
 * change earlier. The pattern is the bug: anything Tars imposes on a CLI it
 * launched cannot live in the callers, because a caller can be added or
 * forgotten.
 *
 * So it lives here instead, applied after the caller's env and after the
 * provider's own deletions, on the one line that actually starts the process.
 * A third spawn site would have to go through this to exist.
 *
 * Its own module rather than a function in pty-manager, because five suites
 * stub pty-manager out wholesale to keep node-pty away from them. Putting the
 * spawn in there would have replaced their `pty.spawn` assertions with a stub
 * of the very thing under test, so they would have gone on passing while
 * checking nothing. Here they reach the real one and keep asserting what they
 * always did.
 */
export function spawnAgentPty(opts: {
  /** The provider's binary, which decides what Tars is allowed to impose. */
  binaryName: string;
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string | undefined>;
}): pty.IPty {
  return pty.spawn(opts.shell, opts.args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: {
      ...opts.env,
      ...managedCliEnv(opts.binaryName),
    } as { [key: string]: string },
  });
}
