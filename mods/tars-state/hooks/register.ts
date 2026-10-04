/**
 * Tars's state mod: this agent's state, reported to the Tars that started it
 * from inside Claude Code (electron/services/state-mod.ts says the rest).
 *
 * It posts what the four shell hooks post, from the same classic events and
 * with the same inputs (SessionStart's registration, UserPromptSubmit's
 * running, Stop's output and idle, StopFailure's error), marked `via: 'mod'`,
 * and a heartbeat every 15 s from this process's own event loop, naming the
 * tool in flight. Every hook hands the event on unchanged (`next(e)`): the
 * agent does exactly what it did without the mod, and the shell hooks still
 * run, Tars setting their four posts aside for a session the mod registered.
 *
 * Its token is sent only to a Tars that proves it is the one that started this
 * CLI, as the shell hooks do (hooks/tars-hook.sh): sha256 of
 * "<TARS_INSTANCE_ID>:<challenge>" from /api/health. Without that proof the
 * mod says nothing, and the shell hooks report as they did.
 */

const BEAT_MS = 15_000;
const OUTPUT_CAP = 4000;
const TASK_CAP = 200;

type Tars = { agentId: string; api: string; token: string };

/** undefined: not asked yet; null: not under a Tars that proved itself. */
let tars: Tars | null | undefined;
let sessionId: string | null = null;
let beating = false;
const inFlight: string[] = [];
/** One post at a time, in the order the events came: a Stop's idle never lands before its turn's running. */
let queue: Promise<unknown> = Promise.resolve();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function proven($: any): Promise<Tars | null> {
  if (tars !== undefined) return tars;
  const agentId = await $.env.get('CLAUDE_AGENT_ID');
  const api = await $.env.get('CLAUDE_MGR_API_URL');
  const token = await $.env.get('CLAUDE_MGR_API_TOKEN');
  const instance = await $.env.get('TARS_INSTANCE_ID');
  if (!agentId || !api || !token || !instance) {
    tars = null;
    return tars;
  }
  const challenge = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  try {
    const answer = await $.http.fetch(`${api}/api/health?challenge=${challenge}`);
    const proof = JSON.parse(answer.text || '{}').proof;
    const expected = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${instance}:${challenge}`)));
    tars = proof === expected ? { agentId, api, token } : null;
  } catch {
    tars = null;
  }
  return tars;
}

function report($: any, route: string, body: Record<string, unknown>): void {
  queue = queue.then(async () => {
    const to = await proven($);
    if (!to) return;
    await $.http.fetch(`${to.api}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${to.token}` },
      body: JSON.stringify({ agent_id: to.agentId, ...body, via: 'mod' }),
    });
  }).catch(() => undefined);
}

function beat($: any): void {
  if (!sessionId) return;
  report($, '/api/hooks/mod-beat', { session_id: sessionId, tool: inFlight[inFlight.length - 1] ?? null });
}

export function register(on: any) {
  on('classic.SessionStart', ($: any, e: any, next: any) => {
    sessionId = e.session_id;
    report($, '/api/hooks/status', { session_id: e.session_id, status: 'idle', source: e.source });
    if (!beating) {
      beating = true;
      $.clock.every(BEAT_MS, () => beat($));
    }
    return next(e);
  });

  on('classic.UserPromptSubmit', ($: any, e: any, next: any) => {
    report($, '/api/hooks/status', {
      session_id: e.session_id, status: 'running', event: 'UserPromptSubmit',
      current_task: typeof e.prompt === 'string' ? e.prompt.slice(0, TASK_CAP) : '',
    });
    return next(e);
  });

  on('classic.Stop', ($: any, e: any, next: any) => {
    if (e.stop_hook_active !== true) {
      if (typeof e.last_assistant_message === 'string' && e.last_assistant_message) {
        report($, '/api/hooks/output', { session_id: e.session_id, output: e.last_assistant_message.slice(0, OUTPUT_CAP) });
      }
      report($, '/api/hooks/status', { session_id: e.session_id, status: 'idle' });
      report($, '/api/hooks/agent-stopped', { session_id: e.session_id });
    }
    return next(e);
  });

  on('classic.StopFailure', ($: any, e: any, next: any) => {
    report($, '/api/hooks/status', {
      session_id: e.session_id, status: 'error', event: 'StopFailure',
      error_kind: typeof e.error === 'string' ? e.error : '',
      error_message: typeof e.last_assistant_message === 'string' ? e.last_assistant_message : '',
    });
    return next(e);
  });

  // The tool in flight, for the heartbeat: a long Bash, an MCP wait or a subagent.
  on('tool.call', async ($: any, e: any, next: any) => {
    inFlight.push(e.tool);
    try {
      return await next(e);
    } finally {
      const at = inFlight.lastIndexOf(e.tool);
      if (at >= 0) inFlight.splice(at, 1);
    }
  });
}
