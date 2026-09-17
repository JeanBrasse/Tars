import * as path from 'path';
import * as pty from 'node-pty';
import { managedCliEnv } from '../providers/cli-provider';
import { mintAgentToken } from './agent-tokens';
import { API_PORT } from '../constants';

/** The shell each agent PTY was started with, by name, as the process table shows it. */
const shellOf = new WeakMap<pty.IPty, string>();

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
  // Whose process this is. Set by the callers through getPtyEnvVars, and read
  // back here rather than taken as a parameter so that a caller cannot spawn
  // an agent pty with one identity in the environment and another in the
  // token. The shells that run no agent carry no id, and are meant to get no
  // token: the quick terminal, the skill and plugin runners, the installer.
  const agentId = opts.env.CLAUDE_AGENT_ID;

  const spawned = pty.spawn(opts.shell, opts.args, {
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
      // What this CLI is, provably. CLAUDE_AGENT_ID travels in the same
      // environment and says who the agent is, but anything that can read an
      // environment can repeat it, so it was a claim and not a proof. This
      // cannot be guessed, and the API resolves the caller from it.
      //
      // Here for the same reason as the address above: five spawn sites, and
      // a secret that has to reach every agent process cannot depend on each
      // of them remembering. Minted per spawn, so a restart invalidates the
      // token the previous process ran with.
      ...(agentId ? { CLAUDE_MGR_API_TOKEN: mintAgentToken(agentId) } : {}),
      ...managedCliEnv(opts.binaryName),
    } as { [key: string]: string },
  });
  shellOf.set(spawned, path.basename(opts.shell));
  return spawned;
}

/**
 * Whether a program runs in an agent's PTY rather than the shell Tars types
 * commands into.
 *
 * Read from the terminal itself, not from the agent's status: a CLI outlives
 * the statuses that say it stopped. A turn that fails leaves claude at its
 * prompt, and an agent marked done or idle keeps its session open, so the
 * status said "not running" while a start typed `cd '...' && claude ...` into
 * a live claude.
 *
 * node-pty names the leader of the terminal's foreground process group
 * (tcgetpgrp, then its p_comm). Measured with the real node-pty and Claude Code
 * 2.1.273 in `/bin/bash -l`: `bash` at the prompt; `2.1.273` while claude runs,
 * at its prompt and during a turn, because the native binary is named after its
 * version, which is why this compares against the shell and never against a
 * CLI's name; `bash` again within 300 ms of `/exit`; `sleep` for a plain
 * command, which counts too, since typing into it is just as wrong. Between the
 * fork and the exec of a command, about 200 ms, the new group's leader is still
 * named bash and this reads false.
 */
export function cliRunningIn(ptyProcess: pty.IPty | undefined): boolean {
  if (!ptyProcess) return false;
  const shell = shellOf.get(ptyProcess);
  if (!shell) return false;
  let foreground: string | undefined;
  try {
    foreground = ptyProcess.process;
  } catch {
    // The terminal is gone: nothing runs in it.
    return false;
  }
  return !!foreground && foreground !== shell;
}
