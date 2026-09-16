import * as pty from 'node-pty';
import { managedCliEnv } from '../providers/cli-provider';
import { API_PORT } from '../constants';

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
 * The claim this comment used to make, that a third spawn site would have to
 * come through here to exist, was wrong twice over. Switching an agent to the
 * local provider recreated its pty with a direct pty.spawn, and creating an
 * agent from the renderer spawned one too. Both predate all of this, both put
 * CLAUDE_AGENT_ID in the environment through getPtyEnvVars, and neither had
 * the API address, so both posted their hooks to whichever Tars owned 31415.
 * Five sites now, all through here. The fifth is the kanban automation in
 * main.ts, creating agents of its own under a comment saying it duplicates the
 * agent:create handler, which it did, defect included. What deliberately does not are the shells that run no
 * agent: the quick terminal, the skill and plugin runners, and the npx
 * installer. They carry no CLAUDE_AGENT_ID, so a hook fired from one of them
 * has no agent to name and is refused. Anything that spawns an agent belongs
 * here.
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
      // Which Tars this CLI answers to: its hooks, its bundled MCP servers and
      // anything else that calls back. It is set here, after the caller's env,
      // for the reason this module exists. initAgentPty set it and
      // spawnAgentSession never did, so every agent started through the API,
      // which is /start, /dispatch, /message and delegation, ran with no port
      // at all and fell back to 31415. A sandbox on 31499 therefore wrote its
      // statuses into whichever Tars owned 31415, which is the live one.
      //
      // After opts.env on purpose: an agent spawned by an agent inherits the
      // parent's value, and the app that spawns a CLI is the app that CLI must
      // report to.
      CLAUDE_MGR_API_URL: `http://127.0.0.1:${API_PORT}`,
      ...managedCliEnv(opts.binaryName),
    } as { [key: string]: string },
  });
}
