import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The lost dispatch.
 *
 * Every hook opens by asking the API whether it is there, and that probe was
 * bounded on the wrong thing. `--connect-timeout` bounds the TCP handshake
 * only. A socket that accepts and then never answers passes it and leaves curl
 * blocked on the read with no deadline at all: measured here at 25s and still
 * going when the harness gave up, never returning on its own. Something
 * half-open on 31415 is ordinary, not exotic: a port collision, an app killed
 * mid-request, a sandbox on the same port.
 *
 * The probe is the FIRST statement in session-start.sh, so the consequence is
 * not a slow start. The registration POST below it never runs, the hook is
 * killed at the 30s timeout Tars configures for it, and the session begins
 * UNREGISTERED. From there the ownership contract in hooks-routes.ts does the
 * rest: with no session on the agent, the work happens and every status,
 * output and task-completed post it produces is dropped. The order was never
 * lost. Its result was, which is indistinguishable from outside.
 *
 * So this runs the real scripts against a real server that answers /api/health
 * the way that socket does, and asserts they come back.
 */

/** The 30s Tars writes into every hook entry, in claude-provider.ts. */
const HOOK_TIMEOUT_MS = 30_000;
/** Comfortably under it, and far above the 2s the probe now allows. */
const MUST_RETURN_WITHIN_MS = 12_000;

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-health-'));

let server: http.Server;
let port: number;
/** Requests that reached a handler, i.e. everything except the dead probe. */
let posted: string[] = [];
/** Held open so the sockets are not collected while the test runs. */
const hung: http.ServerResponse[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      // Accept, read the request, answer nothing, keep it open. This is the
      // shape that was measured, and the one --connect-timeout cannot see.
      hung.push(res);
      return;
    }
    req.resume();
    req.on('end', () => {
      posted.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const res of hung) {
    try { res.destroy(); } catch { /* already gone */ }
  }
  await new Promise<void>(r => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The real script, with only its hardcoded port pointed at this server. */
function scriptUnderTest(name: string): string {
  const original = fs.readFileSync(path.join(HOOKS_DIR, name), 'utf-8');
  const occurrences = original.split('http://127.0.0.1:31415').length - 1;
  expect(occurrences, `${name} no longer names the port the way this test rewrites`).toBeGreaterThan(0);
  const out = path.join(tmp, name);
  fs.writeFileSync(out, original.replaceAll('http://127.0.0.1:31415', `http://127.0.0.1:${port}`));
  fs.chmodSync(out, 0o755);
  return out;
}

/** Run a hook the way Claude Code does, and kill it where Claude Code would. */
function runHook(name: string, stdin: unknown): Promise<{ ms: number; killed: boolean }> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn('/bin/bash', [scriptUnderTest(name)], {
      env: {
        ...process.env,
        CLAUDE_AGENT_ID: 'health-probe-agent',
        CLAUDE_PROJECT_PATH: tmp,
        HOME: tmp,
      },
    });
    // No listener means the pipe fills and the script blocks on its own writes.
    child.stdout.resume();
    child.stderr.resume();
    const killer = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS);
    let settled = false;
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      const ms = Date.now() - started;
      resolve({ ms, killed: ms >= HOOK_TIMEOUT_MS });
    });
    child.stdin.end(JSON.stringify(stdin));
  });
}

const SESSION = { session_id: 'probe-session', cwd: tmp, source: 'startup', prompt: 'go' };

describe('a half-open API does not swallow the session', () => {
  it('session-start returns instead of being killed at the hook timeout', async () => {
    posted = [];

    const { ms, killed } = await runHook('session-start.sh', SESSION);

    // Before the fix this ran the full 30s and was killed with nothing sent.
    expect(killed, `session-start.sh was killed at the ${HOOK_TIMEOUT_MS}ms hook timeout`).toBe(false);
    expect(ms).toBeLessThan(MUST_RETURN_WITHIN_MS);
  }, 60_000);

  it('user-prompt-submit returns, so a live session can still claim the agent', async () => {
    // The one post that gives a running session its ownership back. Blocked on
    // the same probe, an agent that is working cannot say so.
    const { ms, killed } = await runHook('user-prompt-submit.sh', SESSION);

    expect(killed).toBe(false);
    expect(ms).toBeLessThan(MUST_RETURN_WITHIN_MS);
  }, 60_000);

  it.each(['permission-request.sh', 'notification.sh', 'session-end.sh'])(
    '%s returns too, so the whole lifecycle survives it',
    async name => {
      const { ms, killed } = await runHook(name, SESSION);

      expect(killed).toBe(false);
      expect(ms).toBeLessThan(MUST_RETURN_WITHIN_MS);
    },
    60_000,
  );

  it('bounds the read and not just the connect, in every hook that probes', () => {
    // The property, asserted on the source: a probe with --connect-timeout and
    // no --max-time is the bug, and it is invisible against a healthy server.
    const probing = fs.readdirSync(HOOKS_DIR)
      .filter(f => f.endsWith('.sh'))
      .map(f => [f, fs.readFileSync(path.join(HOOKS_DIR, f), 'utf-8')] as const)
      .filter(([, body]) => body.includes('/api/health'));

    expect(probing.length).toBeGreaterThan(0);
    for (const [name, body] of probing) {
      for (const line of body.split('\n')) {
        if (!line.includes('curl') || !line.includes('/api/health')) continue;
        expect(line.includes('--max-time'), `${name} probes /api/health without --max-time`).toBe(true);
      }
    }
  });
});
