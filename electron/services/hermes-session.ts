import { HermesConnection, resolveHermesBaseUrl } from '../types/hermes';
import { hermesRequest } from './hermes-client';

/**
 * A live Hermes conversation, instead of a cron job.
 *
 * The overseer used to talk to Hermes by rewriting a cron job's prompt,
 * triggering it, and polling for the run: about thirty seconds per turn, for a
 * transport whose whole purpose was to carry one sentence. The gateway has a
 * real conversation and always did, but it is not in the REST surface, which
 * is why it was missed: `/api/sessions/*` only reads and deletes. The live path
 * is two WebSockets, and it is what the gateway's own dashboard uses.
 *
 *   1. POST /api/auth/ws-ticket           single-use, 30 seconds
 *   2. ws /api/ws?ticket=                 JSON-RPC 2.0 control channel
 *      - `session.create` -> { session_id, stored_session_id, info }
 *      - pushes `session.info` events carrying the model and the effort
 *   3. ws /api/pty?channel=<session_id>&attach=<hex>&ticket=
 *      - raw terminal bytes, not JSON
 *
 * Two things about the PTY that look like bugs and are not:
 *
 * - **It is lazy.** Nothing at all arrives until the first keystroke, and then
 *   the agent's whole TUI paints at once. A silent socket is not a dead one.
 * - **It is a TUI, not a stream.** The output redraws itself continuously, so
 *   there is no "the reply ends here" in the bytes, and the gateway publishes
 *   no turn-completed event either (the events feed carries `sessions.changed`
 *   and `session.info`, nothing per turn). Completion is therefore taken from
 *   the content: the overseer prompt already asks for a JSON envelope, so the
 *   turn is over when a complete one has been printed. That is a property of
 *   the protocol rather than a guess about the screen.
 */

/** Wide enough that a long JSON envelope is never wrapped by the terminal.
 *  A wrapped line puts hard breaks inside the JSON and it stops parsing. */
const COLS = 400;
const ROWS = 50;

/** The PTY paints nothing until it is touched, so it gets touched, and then
 *  given a moment to finish painting before anything is typed into it. */
const WAKE_MS = 2_500;

/** How long a single turn may take before the caller is told it did not
 *  finish. Hermes turns are slow: a fleet question runs tools. */
const TURN_TIMEOUT_MS = 180_000;

/** After the envelope parses, the agent may still be painting. Nothing waits
 *  on that: the answer is already complete. */
const SETTLE_AFTER_ENVELOPE_MS = 150;

export interface LiveSession {
  sessionId: string;
  storedSessionId: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  cwd?: string;
  branch?: string;
}

/** Terminal escape sequences, so the accumulated buffer is text a parser can
 *  look at. Deliberately narrow: this strips the sequences the agent's TUI
 *  actually emits rather than trying to be a terminal emulator. */
export function stripAnsi(raw: string): string {
  return raw
    // OSC (window title and friends), terminated by BEL or ST.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Character set selection.
    .replace(/\x1b[()][AB0-2]/g, '')
    // Single-character escapes left over.
    .replace(/\x1b[=>]/g, '');
}

/**
 * The first complete JSON object in the text, or null.
 *
 * Brace-counting rather than a regular expression, and string-aware, because
 * the envelope contains agent output that itself contains braces and quotes.
 */
export function firstCompleteJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function mintTicket(conn: HermesConnection): Promise<string> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/auth/ws-ticket', {
    method: 'POST',
    token: conn.token,
    body: {},
  });
  if (status >= 300) throw new Error(`the gateway refused a WebSocket ticket (HTTP ${status})`);
  const ticket = (body as { ticket?: unknown })?.ticket;
  if (typeof ticket !== 'string' || !ticket) throw new Error('the gateway returned no WebSocket ticket');
  return ticket;
}

function wsBase(conn: HermesConnection): string {
  return resolveHermesBaseUrl(conn).replace(/^http/, 'ws');
}

/** Sixteen random bytes, the shape the dashboard uses to identify a viewer. */
function attachToken(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Whether this process can open a WebSocket at all. Node 22 and Electron's
 *  main process both have one globally; if some future runtime does not, the
 *  caller falls back to the cron transport rather than failing. */
export function liveTransportAvailable(): boolean {
  return typeof WebSocket !== 'undefined';
}

/**
 * Open a conversation and keep the control channel for as long as it lives.
 *
 * `close_on_disconnect: false` so a dropped socket does not destroy the
 * session: Tars reconnects to the same `session_id` and the conversation is
 * still there.
 */
export async function createLiveSession(
  conn: HermesConnection,
  opts: { profile?: string } = {},
): Promise<{ session: LiveSession; control: WebSocket }> {
  const ticket = await mintTicket(conn);
  const control = new WebSocket(`${wsBase(conn)}/api/ws?ticket=${encodeURIComponent(ticket)}`);

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the gateway did not answer session.create')), 20_000);
    control.onopen = () => control.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.create',
      params: { close_on_disconnect: false, source: 'tool', ...(opts.profile ? { profile: opts.profile } : {}) },
    }));
    control.onerror = () => { clearTimeout(timer); reject(new Error('could not reach the gateway control channel')); };
    control.onclose = () => { clearTimeout(timer); reject(new Error('the gateway closed the control channel')); };
    control.onmessage = (event: MessageEvent) => {
      let msg: { id?: unknown; error?: { message?: string }; result?: Record<string, unknown> };
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'session.create failed'));
      else resolve(msg.result ?? {});
    };
  });

  const info = (result.info ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

  return {
    control,
    session: {
      sessionId: String(result.session_id ?? ''),
      storedSessionId: String(result.stored_session_id ?? ''),
      model: str(info.model),
      provider: str(info.provider),
      reasoningEffort: str(info.reasoning_effort),
      cwd: str(info.cwd),
      branch: str(info.branch),
    },
  };
}

/**
 * Type one message into the session and wait for the envelope.
 *
 * Multi-line prompts go inside a bracketed paste: without it every newline is
 * a submit, and the overseer's prompt is a page long, so the agent would
 * receive the first line as a question and the rest as forty more. The delayed
 * carriage return afterwards is the same one `writeProgrammaticInput` sends to
 * Claude Code's TUI, and for the same reason.
 */
export type LiveTurnResult =
  | { ok: true; envelope: string; raw: string }
  | { ok: false; error: string; raw: string };

export function askLiveSession(
  conn: HermesConnection,
  session: LiveSession,
  prompt: string,
  opts: { signal?: { aborted: boolean }; timeoutMs?: number } = {},
): Promise<LiveTurnResult> {
  const timeoutMs = opts.timeoutMs ?? TURN_TIMEOUT_MS;

  return new Promise(async resolve => {
    let pty: WebSocket;
    try {
      const ticket = await mintTicket(conn);
      const url = `${wsBase(conn)}/api/pty?channel=${encodeURIComponent(session.sessionId)}`
        + `&attach=${attachToken()}&ticket=${encodeURIComponent(ticket)}`;
      pty = new WebSocket(url);
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err), raw: '' });
      return;
    }
    pty.binaryType = 'arraybuffer';

    let raw = '';
    let settled = false;
    /** How much of the buffer is the TUI painting itself and the prompt coming
     *  back, rather than the answer. */
    let promptEcho = 0;
    const finish = (value: LiveTurnResult) => {
      if (settled) return;
      settled = true;
      clearInterval(abortPoll);
      clearTimeout(timer);
      try { pty.close(); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: 'Hermes did not finish this turn in time.', raw }),
      timeoutMs,
    );
    // Pause has to reach a turn already in flight, so the abort flag is read
    // here rather than only between turns.
    const abortPoll = setInterval(() => {
      if (opts.signal?.aborted) finish({ ok: false, error: 'aborted', raw });
    }, 500);

    pty.onerror = () => finish({ ok: false, error: 'the gateway terminal channel failed', raw });
    pty.onclose = () => finish({ ok: false, error: 'the gateway closed the terminal channel', raw });

    pty.onmessage = (event: MessageEvent) => {
      const data = event.data;
      raw += typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf-8');
      // Only look at what arrived after the prompt was echoed, so the envelope
      // found is the answer rather than the request.
      const text = stripAnsi(raw);
      const after = promptEcho > 0 ? text.slice(promptEcho) : text;
      const found = firstCompleteJson(after);
      if (found) {
        setTimeout(() => finish({ ok: true, envelope: found, raw }), SETTLE_AFTER_ENVELOPE_MS);
      }
    };

    pty.onopen = () => {
      pty.send(`\x1b[RESIZE:${COLS};${ROWS}]`);
      // Wake it, then let the TUI finish painting before typing into it.
      pty.send(' ');
      setTimeout(() => {
        if (settled) return;
        pty.send('\x7f'); // erase the wake keystroke
        // Everything printed so far is the TUI, not the answer.
        promptEcho = stripAnsi(raw).length;
        pty.send(`\x1b[200~${prompt}\x1b[201~`);
        setTimeout(() => { if (!settled) pty.send('\r'); }, 150);
      }, WAKE_MS);
    };
  });
}

/* ── The reasoning effort ────────────────────────────────────────────────── */

/**
 * Where the effort actually lives.
 *
 * Not on the cron job (which accepts the field and drops it), and not on
 * /api/model/set. It is `agent.reasoning_effort` in the gateway's config, which
 * is how the dashboard's own control sets it: read the config, replace that one
 * key, write the whole object back. It is a property of the gateway or the
 * profile rather than of a message, so there is no per-turn effort to offer.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export async function getReasoningEffort(conn: HermesConnection): Promise<string | null> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/config', { token: conn.token });
  if (status >= 300) return null;
  const agent = (body as { agent?: Record<string, unknown> })?.agent;
  const value = agent?.reasoning_effort;
  return typeof value === 'string' && value ? value : null;
}

export async function setReasoningEffort(
  conn: HermesConnection,
  effort: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  // Read-modify-write, because the gateway takes the whole config object. A
  // PUT built from anything but the current config would silently revert every
  // other setting on it.
  const current = await hermesRequest(baseUrl, '/api/config', { token: conn.token });
  if (current.status >= 300) return { success: false, error: `could not read the gateway config (HTTP ${current.status})` };
  const config = (current.body ?? {}) as Record<string, unknown>;
  const agent = (config.agent && typeof config.agent === 'object' ? { ...config.agent } : {}) as Record<string, unknown>;
  agent.reasoning_effort = effort;

  const { status, body } = await hermesRequest(baseUrl, '/api/config', {
    method: 'PUT',
    token: conn.token,
    body: { ...config, agent },
    timeoutMs: 20_000,
  });
  if (status < 300) return { success: true };
  const detail = (body && typeof body === 'object' && 'detail' in body)
    ? String((body as { detail: unknown }).detail).slice(0, 200)
    : `HTTP ${status}`;
  return { success: false, error: detail };
}
