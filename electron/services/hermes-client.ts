import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { HermesConnection, resolveHermesBaseUrl } from '../types/hermes';
import { DATA_DIR } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';

/**
 * Minimal Hermes gateway client.
 *
 * Hermes gateways come in two auth flavours, advertised on the public
 * GET /api/status:
 *  - open / token: no sign-in, or a static `X-Hermes-Session-Token` header.
 *  - cookie (auth_flows: ['cookie']): a real sign-in. We POST
 *    /auth/password-login {provider, username, password} and keep the
 *    returned session cookies for subsequent calls. The gateway rotates a
 *    fresh access-token cookie transparently while the refresh cookie lives,
 *    so we simply keep whatever it hands back.
 *
 * The cookie jar lives in the main process only. It must never reach the
 * renderer.
 */

interface HermesResponse {
  status: number;
  body: unknown;
  setCookies: string[];
}

/**
 * Where the session lives between runs.
 *
 * The jar used to be memory-only, so signing in lasted exactly as long as the
 * process: every relaunch - and every crash - came back signed out, with the
 * Kanban and Schedules pages showing "Unauthorized" for a gateway the user had
 * authenticated against days ago. hermes-connection.json holds the URL and the
 * auth mode but deliberately never held the cookies, so nothing on disk could
 * restore the session.
 *
 * It is a credential, so it gets the same 0600 atomic write as api-token, and
 * it stays in the main process - `hermesRequest` reads it, the renderer has no
 * channel that returns it.
 */
const SESSION_FILE = path.join(DATA_DIR, 'hermes-session.json');

const cookieJars = new Map<string, Map<string, string>>();

function loadJars(): void {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as Record<string, Record<string, string>>;
    for (const [baseUrl, cookies] of Object.entries(raw)) {
      if (cookies && typeof cookies === 'object') {
        cookieJars.set(baseUrl, new Map(Object.entries(cookies)));
      }
    }
  } catch (err) {
    // A corrupt session file must not stop the app booting - the worst case is
    // one sign-in.
    console.error('[hermes] could not restore the session jar:', err);
  }
}

function persistJars(): void {
  try {
    const plain: Record<string, Record<string, string>> = {};
    for (const [baseUrl, jar] of cookieJars) {
      if (jar.size > 0) plain[baseUrl] = Object.fromEntries(jar);
    }
    writeSecretFileSync(SESSION_FILE, JSON.stringify(plain, null, 2));
  } catch (err) {
    console.error('[hermes] could not persist the session jar:', err);
  }
}

loadJars();

function jarFor(baseUrl: string): Map<string, string> {
  let jar = cookieJars.get(baseUrl);
  if (!jar) { jar = new Map(); cookieJars.set(baseUrl, jar); }
  return jar;
}

function cookieHeader(baseUrl: string): string | undefined {
  const jar = jarFor(baseUrl);
  if (jar.size === 0) return undefined;
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(baseUrl: string, setCookies: string[]): void {
  const jar = jarFor(baseUrl);
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    // An expired/cleared cookie comes back empty: drop it from the jar.
    if (!value) jar.delete(name);
    else jar.set(name, value);
  }
  persistJars();
}

export function clearHermesSession(baseUrl: string): void {
  cookieJars.delete(baseUrl);
  persistJars();
}

export function hasHermesSession(baseUrl: string): boolean {
  const jar = cookieJars.get(baseUrl);
  if (!jar) return false;
  return Array.from(jar.keys()).some(k => k.includes('hermes_session'));
}

export function hermesRequest(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<HermesResponse> {
  const { method = 'GET', body, token, timeoutMs = 10000 } = options;
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(baseUrl + pathname); } catch { reject(new Error('Invalid gateway URL')); return; }

    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (token) headers['X-Hermes-Session-Token'] = token;
    const cookie = cookieHeader(baseUrl);
    if (cookie) headers['Cookie'] = cookie;

    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, { method, headers, timeout: timeoutMs }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        const setCookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
        if (setCookies.length) storeCookies(baseUrl, setCookies);
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, setCookies });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

export interface HermesStatus {
  reachable: boolean;
  status?: number;
  version?: string;
  gatewayState?: string;
  authRequired: boolean;
  authFlows: string[];
  authProviders: string[];
  signedIn: boolean;
  error?: string;
}

export async function probeHermes(conn: HermesConnection): Promise<HermesStatus & { baseUrl: string }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  if (!baseUrl) {
    return { baseUrl: '', reachable: false, authRequired: false, authFlows: [], authProviders: [], signedIn: false, error: 'No gateway URL for this mode.' };
  }
  try {
    const { status, body } = await hermesRequest(baseUrl, '/api/status', { token: conn.token });
    const info = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const authRequired = info.auth_required === true;
    return {
      baseUrl,
      reachable: status > 0 && status < 500,
      status,
      version: typeof info.version === 'string' ? info.version : undefined,
      gatewayState: typeof info.gateway_state === 'string' ? info.gateway_state : undefined,
      authRequired,
      authFlows: Array.isArray(info.auth_flows) ? info.auth_flows as string[] : [],
      authProviders: Array.isArray(info.auth_providers) ? info.auth_providers as string[] : [],
      signedIn: !authRequired || hasHermesSession(baseUrl),
    };
  } catch (err) {
    return { baseUrl, reachable: false, authRequired: false, authFlows: [], authProviders: [], signedIn: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function signInHermes(
  conn: HermesConnection,
  credentials: { provider?: string; username: string; password: string },
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  if (!baseUrl) return { success: false, error: 'No gateway URL for this mode.' };
  try {
    const provider = credentials.provider || 'basic';
    const { status, body } = await hermesRequest(baseUrl, '/auth/password-login', {
      method: 'POST',
      body: { provider, username: credentials.username, password: credentials.password, next: '/' },
    });
    if (status === 200 && hasHermesSession(baseUrl)) return { success: true };
    const detail = (body && typeof body === 'object' && 'detail' in body)
      ? String((body as { detail: unknown }).detail)
      : `HTTP ${status}`;
    return { success: false, error: status === 200 ? 'Gateway accepted the login but set no session cookie.' : detail };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Kanban plugin ─────────────────────────────────────────────────────────
// The board itself (columns, tasks, runs, workers) lives in Hermes: Tars
// is only a client. Endpoints are mounted at /api/plugins/kanban.

export const HERMES_KANBAN_COLUMNS = [
  'triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done',
] as const;

const KANBAN = '/api/plugins/kanban';

/**
 * The gateway returns FastAPI-style validation errors as
 * `{ detail: "title is required" }` or `{ detail: [{ msg, loc, ... }] }`. Every
 * kanban call used to collapse that to a bare `HTTP 422`, so a task created
 * with no title told the user nothing they could act on. Read `detail` the
 * same way for every endpoint here, board included.
 */
function errorDetail(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const msgs = detail.map(d => (d && typeof d === 'object' && 'msg' in d) ? String((d as { msg: unknown }).msg) : String(d));
      if (msgs.length) return msgs.join('; ');
    }
  }
  return `HTTP ${status}`;
}

export async function fetchHermesBoard(conn: HermesConnection, board?: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const query = board ? `?board=${encodeURIComponent(board)}` : '';
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/board${query}`, { token: conn.token });
  if (status !== 200) {
    return { success: false as const, error: errorDetail(status, body), needsSignIn: status === 401 || status === 403 };
  }
  return { success: true as const, board: body };
}

export async function getHermesTask(conn: HermesConnection, taskId: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/tasks/${encodeURIComponent(taskId)}`, { token: conn.token });
  if (status !== 200) {
    return { success: false as const, error: errorDetail(status, body), needsSignIn: status === 401 || status === 403 };
  }
  return { success: true as const, detail: body };
}

export async function createHermesTask(conn: HermesConnection, task: Record<string, unknown>) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/tasks`, { method: 'POST', body: task, token: conn.token });
  return status < 300
    ? { success: true as const, task: body }
    : { success: false as const, error: errorDetail(status, body), needsSignIn: status === 401 || status === 403 };
}

export async function updateHermesTask(conn: HermesConnection, taskId: string, patch: Record<string, unknown>) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: patch, token: conn.token });
  return status < 300
    ? { success: true as const, task: body }
    : { success: false as const, error: errorDetail(status, body), needsSignIn: status === 401 || status === 403 };
}

export async function deleteHermesTask(conn: HermesConnection, taskId: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', token: conn.token });
  return status < 300
    ? { success: true as const }
    : { success: false as const, error: errorDetail(status, body), needsSignIn: status === 401 || status === 403 };
}

export async function addHermesTaskComment(conn: HermesConnection, taskId: string, body_: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/tasks/${encodeURIComponent(taskId)}/comments`, { method: 'POST', body: { body: body_ }, token: conn.token });
  return status < 300
    ? { success: true as const }
    : { success: false as const, error: errorDetail(status, body), needsSignIn: status === 401 || status === 403 };
}

// ── Cron / automations ────────────────────────────────────────────────────
// Schedules live in Hermes (per-profile jobs.json); Tars lists and drives
// them. Unit routes need the job's own `profile`, otherwise the gateway scans
// every profile to find it.

export async function fetchHermesCrons(conn: HermesConnection) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/cron/jobs?profile=all', { token: conn.token });
  if (status !== 200) {
    const detail = (body && typeof body === 'object' && 'detail' in body)
      ? String((body as { detail: unknown }).detail) : `HTTP ${status}`;
    return { success: false as const, error: detail, needsSignIn: status === 401 || status === 403 };
  }
  return { success: true as const, jobs: body };
}

export async function hermesCronAction(
  conn: HermesConnection,
  action: 'pause' | 'resume' | 'trigger',
  jobId: string,
  profile?: string,
) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const { status, body } = await hermesRequest(
    baseUrl, `/api/cron/jobs/${encodeURIComponent(jobId)}/${action}${q}`,
    { method: 'POST', token: conn.token },
  );
  return status < 300 ? { success: true as const, job: body } : { success: false as const, error: `HTTP ${status}` };
}

/**
 * Edit a job in place.
 *
 * The Schedules page shipped with run/pause/delete only, so a job's expression
 * or prompt could not be changed from Tars at all - the gateway does support
 * it, we simply never called the route. It is PUT (not PATCH like Kanban), and
 * the body wraps the changed fields in `updates`; keys left out stay as they
 * are. Verified against Hermes 0.20.0: `name`, `prompt`, `schedule` (a plain
 * expression string - cron, `every 30m`, `2h`, an ISO timestamp) and `enabled`
 * all take. `profile` is a locator, not a field: the gateway accepts it in the
 * body and ignores it, so a job cannot be moved between profiles this way.
 *
 * A bad expression comes back 400 with the gateway's own `detail` listing the
 * accepted forms - pass that through verbatim, it is better copy than anything
 * we would write here.
 */
export async function updateHermesCron(
  conn: HermesConnection,
  jobId: string,
  updates: Record<string, unknown>,
  profile?: string,
) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const { status, body } = await hermesRequest(
    baseUrl, `/api/cron/jobs/${encodeURIComponent(jobId)}${q}`,
    { method: 'PUT', body: { updates }, token: conn.token },
  );
  if (status < 300) return { success: true as const, job: body };
  const detail = (body && typeof body === 'object' && 'detail' in body)
    ? String((body as { detail: unknown }).detail) : `HTTP ${status}`;
  return { success: false as const, error: detail, needsSignIn: status === 401 || status === 403 };
}

export async function deleteHermesCron(conn: HermesConnection, jobId: string, profile?: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const { status } = await hermesRequest(baseUrl, `/api/cron/jobs/${encodeURIComponent(jobId)}${q}`, { method: 'DELETE', token: conn.token });
  return status < 300 ? { success: true as const } : { success: false as const, error: `HTTP ${status}` };
}

/**
 * Create a cron job.
 *
 * Used by the Overseer (electron/services/overseer.ts) to provision its own
 * permanent job, which it then drives entirely by hand: it PUTs a fresh
 * prompt and POSTs /trigger on every turn rather than waiting on `schedule`.
 *
 * `enabled` is forced to true. A job created with enabled:false answers 200
 * to both the creation call and every later /trigger, and then does nothing
 * at all - no run, no session, no error. That silence cost an hour to track
 * down against the live gateway, so there is no way to call this with the
 * job disabled.
 */
/**
 * The models the gateway can actually run, and which it is running now.
 *
 * The overseer was pinned to whatever the gateway happened to have selected,
 * which on the author's install is deepseek-v4-flash. That is a real choice a
 * user should get to make: it decides how good the fleet briefings are and what
 * they cost. `GET /api/model/options` answers with every provider the gateway
 * has credentials for and their model lists, so the picker offers what will
 * actually work rather than a table compiled into Tars.
 */
export interface HermesModelProvider {
  slug: string;
  name: string;
  models: string[];
  isCurrent: boolean;
}

export async function fetchHermesModelOptions(
  conn: HermesConnection,
): Promise<
  | { success: true; provider: string; model: string; providers: HermesModelProvider[] }
  | { success: false; error: string; needsSignIn?: boolean }
> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/model/options', { token: conn.token });
  if (status === 401 || status === 403) {
    return { success: false, error: 'Sign in to Hermes to list its models', needsSignIn: true };
  }
  if (status >= 300) return { success: false, error: `HTTP ${status}` };

  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.providers) ? b.providers : [];
  return {
    success: true,
    provider: typeof b.provider === 'string' ? b.provider : '',
    model: typeof b.model === 'string' ? b.model : '',
    providers: raw.map(entry => {
      const p = entry as Record<string, unknown>;
      return {
        slug: typeof p.slug === 'string' ? p.slug : '',
        name: typeof p.name === 'string' ? p.name : String(p.slug ?? ''),
        models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string') : [],
        isCurrent: p.is_current === true,
      };
    }).filter(p => p.slug),
  };
}

/**
 * Point the gateway at a model.
 *
 * Measured against the live gateway rather than assumed, because two other
 * mechanisms look like they should work and do not: `provider` and `model` on
 * a cron job are accepted and echoed back but ignored at run time, and a job
 * run under a non-default profile never produces an answer at all. Only this
 * changes what actually replies.
 *
 * `scope: "main"` is the gateway's own wording for the primary slot. It is a
 * gateway-wide setting, not a Tars one, which is why the screen that calls
 * this says so.
 */
export async function setHermesModel(
  conn: HermesConnection,
  choice: { provider: string; model: string },
) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/model/set', {
    method: 'POST',
    token: conn.token,
    body: { scope: 'main', provider: choice.provider, model: choice.model },
  });
  if (status < 300) return { success: true as const };
  const detail = (body && typeof body === 'object' && 'detail' in body)
    ? JSON.stringify((body as { detail: unknown }).detail).slice(0, 200) : `HTTP ${status}`;
  return { success: false as const, error: detail, needsSignIn: status === 401 || status === 403 };
}

export async function createHermesCron(
  conn: HermesConnection,
  job: { name: string; schedule: string; prompt: string; deliver?: string; model?: string; provider?: string },
) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/cron/jobs', {
    method: 'POST',
    token: conn.token,
    // `model` and `provider` are accepted here and echoed back on the created
    // job, but measurement against the live gateway showed they are ignored at
    // run time: a job pinned to anthropic never answered, while the same job
    // on the gateway's own current model did. They are still sent because a
    // later gateway may honour them; what actually selects the model is
    // setHermesModel above.
    body: {
      name: job.name,
      schedule: job.schedule,
      prompt: job.prompt,
      deliver: job.deliver ?? 'local',
      enabled: true,
      ...(job.model ? { model: job.model } : {}),
      ...(job.provider ? { provider: job.provider } : {}),
    },
  });
  if (status < 300) return { success: true as const, job: body as { id?: string; [key: string]: unknown } };
  const detail = (body && typeof body === 'object' && 'detail' in body)
    ? String((body as { detail: unknown }).detail) : `HTTP ${status}`;
  return { success: false as const, error: detail, needsSignIn: status === 401 || status === 403 };
}

export interface HermesCronRun {
  id: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Recent runs of one job, newest first (the gateway's own order). */
export async function fetchHermesCronRuns(
  conn: HermesConnection,
  jobId: string,
  opts: { limit?: number; profile?: string } = {},
): Promise<{ success: true; runs: HermesCronRun[] } | { success: false; error: string; needsSignIn?: boolean }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.profile) params.set('profile', opts.profile);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const { status, body } = await hermesRequest(baseUrl, `/api/cron/jobs/${encodeURIComponent(jobId)}/runs${qs}`, { token: conn.token });
  if (status === 401 || status === 403) return { success: false, error: 'Sign in to Hermes', needsSignIn: true };
  if (status >= 300) return { success: false, error: `HTTP ${status}` };

  const raw = Array.isArray(body) ? body : (body as { runs?: unknown[] } | null)?.runs ?? [];
  const runs = raw.map(entry => {
    const r = (entry ?? {}) as Record<string, unknown>;
    return {
      id: typeof r.id === 'string' ? r.id : '',
      status: typeof r.status === 'string' ? r.status : undefined,
      startedAt: typeof r.started_at === 'string' ? r.started_at : typeof r.startedAt === 'string' ? r.startedAt : undefined,
      finishedAt: typeof r.finished_at === 'string' ? r.finished_at : typeof r.finishedAt === 'string' ? r.finishedAt : undefined,
    };
  }).filter(r => r.id);
  return { success: true, runs };
}

export interface HermesSessionMessage {
  role: string;
  content: string;
}

/** The transcript of one run/session: what the overseer actually answered. */
export async function fetchHermesSessionMessages(
  conn: HermesConnection,
  sessionId: string,
): Promise<{ success: true; messages: HermesSessionMessage[] } | { success: false; error: string; needsSignIn?: boolean }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { token: conn.token });
  if (status === 401 || status === 403) return { success: false, error: 'Sign in to Hermes', needsSignIn: true };
  if (status >= 300) return { success: false, error: `HTTP ${status}` };

  const raw = Array.isArray(body) ? body : (body as { messages?: unknown[] } | null)?.messages ?? [];
  const messages = raw.map(entry => {
    const m = (entry ?? {}) as Record<string, unknown>;
    return {
      role: typeof m.role === 'string' ? m.role : '',
      content: typeof m.content === 'string' ? m.content : '',
    };
  });
  return { success: true, messages };
}

/* ── Memory ────────────────────────────────────────────────
 * Hermes exposes no HTTP API for memory *content*: /api/memory only
 * administers which provider is active. The content lives in two markdown
 * files the gateway will hand over through /api/files/read, and past sessions
 * are searchable through the FTS index behind /api/sessions/search.
 */

export interface HermesMemoryFile {
  name: string;
  content: string;
}

function decodeDataUrl(dataUrl: unknown): string {
  if (typeof dataUrl !== 'string') return '';
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return '';
  try {
    return Buffer.from(dataUrl.slice(comma + 1), 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * MEMORY.md (agent notes) and USER.md (user profile) from the gateway.
 *
 * These were read as `memories/MEMORY.md`, a relative path, and /api/files/read
 * rejects those with `400 {"detail":"Path must be absolute"}`. Every call
 * therefore failed, and because the Brain page only counts the files it got
 * back, a signed-in gateway holding a real MEMORY.md reported "0 files
 * readable" and the digest injected into every new session carried no Hermes
 * memory at all. The gateway expands `~` to its own home, so this stays correct
 * whatever account Hermes runs as.
 */
const HERMES_MEMORY_DIR = '~/.hermes/memories';

export async function fetchHermesMemoryFiles(conn: HermesConnection): Promise<
  { success: true; files: HermesMemoryFile[] } | { success: false; error: string; needsSignIn?: boolean }
> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const files: HermesMemoryFile[] = [];

  for (const name of ['MEMORY.md', 'USER.md']) {
    const { status, body } = await hermesRequest(
      baseUrl, `/api/files/read?path=${encodeURIComponent(`${HERMES_MEMORY_DIR}/${name}`)}`, { token: conn.token },
    );
    if (status === 401 || status === 403) {
      return { success: false, error: 'Sign in to Hermes to read its memory', needsSignIn: true };
    }
    if (status === 404) continue; // the gateway simply has not written it yet
    if (status >= 300) return { success: false, error: `HTTP ${status}` };

    const content = decodeDataUrl((body as Record<string, unknown> | null)?.data_url);
    if (content.trim()) files.push({ name, content });
  }

  return { success: true, files };
}

/**
 * Append to one of the gateway's memory files.
 *
 * Tars could read Hermes' memory but never write to it: `memory_write` only
 * ever touched the project's own notes, so an agent told "remember this in
 * Hermes" had nowhere to put it. There is no append route, so this is
 * read-modify-upload against `/api/files/upload`, which takes a data URL and
 * overwrites. Verified against Hermes 0.20.0: upload, read back and delete all
 * answer 200 on `~/.hermes/memories/`.
 *
 * Last-write-wins, deliberately. A lock would need a route the gateway does not
 * have, and two agents appending to a memory file in the same instant is not
 * worth a second round trip on every write. The read immediately precedes the
 * upload, so the window is one request wide.
 */
export async function appendHermesMemory(
  conn: HermesConnection,
  content: string,
  file = 'MEMORY.md',
): Promise<{ success: true; path: string } | { success: false; error: string; needsSignIn?: boolean }> {
  const trimmed = content.trim();
  if (!trimmed) return { success: false, error: 'Nothing to write' };

  // Only the gateway's own memory directory, and only a plain filename: a
  // caller-supplied `../` would otherwise reach anywhere the gateway can write.
  const name = file.replace(/[^A-Za-z0-9._-]/g, '');
  if (!name || name.startsWith('.')) return { success: false, error: `Invalid memory file "${file}"` };

  const baseUrl = resolveHermesBaseUrl(conn);
  const path = `${HERMES_MEMORY_DIR}/${name}`;

  const read = await hermesRequest(
    baseUrl, `/api/files/read?path=${encodeURIComponent(path)}`, { token: conn.token },
  );
  if (read.status === 401 || read.status === 403) {
    return { success: false, error: 'Sign in to Hermes to write to its memory', needsSignIn: true };
  }
  // 404 is the first write to a file that does not exist yet, not a failure.
  if (read.status >= 300 && read.status !== 404) {
    return { success: false, error: `Could not read ${name}: HTTP ${read.status}` };
  }

  const existing = read.status === 404
    ? ''
    : decodeDataUrl((read.body as Record<string, unknown> | null)?.data_url);
  const separator = existing.trim() ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  const next = `${existing}${separator}${trimmed}\n`;

  const { status, body } = await hermesRequest(baseUrl, '/api/files/upload', {
    method: 'POST',
    token: conn.token,
    body: {
      path,
      data_url: `data:text/markdown;base64,${Buffer.from(next, 'utf-8').toString('base64')}`,
      overwrite: true,
    },
  });
  if (status >= 300) {
    const detail = (body && typeof body === 'object' && 'detail' in body)
      ? String((body as { detail: unknown }).detail) : `HTTP ${status}`;
    return { success: false, error: detail, needsSignIn: status === 401 || status === 403 };
  }

  const written = (body && typeof body === 'object' && 'path' in body)
    ? String((body as { path: unknown }).path) : path;
  return { success: true, path: written };
}

/**
 * The MCP servers the gateway has registered.
 *
 * Why Tars asks: gbrain and Honcho are configured in Settings by pasting an MCP
 * URL, and nobody remembers one. The gateway already knows them, so Tars can
 * offer what it finds instead of an empty field. The catch worth reporting is
 * that a gateway-side `localhost` URL is the gateway's own loopback: Tars
 * cannot reach it from here, which is exactly the case that used to show up as
 * a silently unreachable backend.
 */
export interface HermesMcpServer {
  name: string;
  url: string | null;
  transport: string | null;
  enabled: boolean;
  /** True when the URL only resolves on the gateway's own machine. */
  gatewayLocal: boolean;
}

export async function fetchHermesMcpServers(
  conn: HermesConnection,
): Promise<{ success: true; servers: HermesMcpServer[] } | { success: false; error: string; needsSignIn?: boolean }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/mcp/servers', { token: conn.token });
  if (status === 401 || status === 403) {
    return { success: false, error: 'Sign in to Hermes to list its MCP servers', needsSignIn: true };
  }
  if (status >= 300) return { success: false, error: `HTTP ${status}` };

  const raw = (body as { servers?: unknown[] } | null)?.servers;
  if (!Array.isArray(raw)) return { success: true, servers: [] };

  const servers = raw.map(entry => {
    const s = entry as Record<string, unknown>;
    const url = typeof s.url === 'string' ? s.url : null;
    return {
      name: typeof s.name === 'string' ? s.name : '',
      url,
      transport: typeof s.transport === 'string' ? s.transport : null,
      enabled: s.enabled !== false,
      gatewayLocal: !!url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url),
    };
  }).filter(s => s.name);

  return { success: true, servers };
}

/**
 * Which memory provider the gateway itself is running, and which it could.
 *
 * Distinct from the `~/.hermes/memories/*.md` files: those are always there,
 * this is Hermes' pluggable long-term store (holographic, mem0, hindsight and
 * so on). `active: ""` means none is selected, which is worth saying out loud
 * because it looks from the outside like the gateway has no memory at all.
 */
export interface HermesMemoryProvider {
  name: string;
  description: string;
  available: boolean;
  configured: boolean;
  status: string;
}

export async function fetchHermesMemoryProviders(
  conn: HermesConnection,
): Promise<
  | { success: true; active: string; providers: HermesMemoryProvider[]; builtinBytes: number }
  | { success: false; error: string; needsSignIn?: boolean }
> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/memory', { token: conn.token });
  if (status === 401 || status === 403) {
    return { success: false, error: 'Sign in to Hermes to read its memory settings', needsSignIn: true };
  }
  if (status >= 300) return { success: false, error: `HTTP ${status}` };

  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.providers) ? b.providers : [];
  const builtin = (b.builtin_files ?? {}) as Record<string, unknown>;

  return {
    success: true,
    active: typeof b.active === 'string' ? b.active : '',
    builtinBytes: Object.values(builtin).reduce<number>(
      (sum, v) => sum + (typeof v === 'number' ? v : 0), 0,
    ),
    providers: raw.map(entry => {
      const p = entry as Record<string, unknown>;
      return {
        name: typeof p.name === 'string' ? p.name : '',
        // The gateway writes its own descriptions with em dashes. Tars does not
        // print those, so they are normalised on the way in rather than at
        // every place this is rendered.
        description: typeof p.description === 'string' ? p.description.replace(/\s*[–—]\s*/g, ': ') : '',
        available: p.available === true,
        configured: p.configured === true,
        status: typeof p.status === 'string' ? p.status : 'unknown',
      };
    }).filter(p => p.name),
  };
}

/** Switch the gateway's active memory provider. */
export async function setHermesMemoryProvider(conn: HermesConnection, provider: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/memory/provider', {
    method: 'PUT', token: conn.token, body: { provider },
  });
  if (status < 300) return { success: true as const, body };
  const detail = (body && typeof body === 'object' && 'detail' in body)
    ? String((body as { detail: unknown }).detail) : `HTTP ${status}`;
  return { success: false as const, error: detail, needsSignIn: status === 401 || status === 403 };
}

export interface HermesSessionHit {
  sessionId?: string;
  title?: string;
  snippet?: string;
  timestamp?: string;
  source?: string;
}

/** Full-text search over every past Hermes session. */
export async function searchHermesSessions(
  conn: HermesConnection,
  query: string,
  limit = 10,
): Promise<{ success: true; hits: HermesSessionHit[] } | { success: false; error: string; needsSignIn?: boolean }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const q = `?q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 50)}`;
  const { status, body } = await hermesRequest(baseUrl, `/api/sessions/search${q}`, { token: conn.token });

  if (status === 401 || status === 403) {
    return { success: false, error: 'Sign in to Hermes to search its history', needsSignIn: true };
  }
  if (status >= 300) return { success: false, error: `HTTP ${status}` };

  const payload = body as Record<string, unknown> | null;
  const raw = Array.isArray(payload)
    ? payload
    : (payload?.results as unknown[] | undefined) ?? (payload?.sessions as unknown[] | undefined) ?? [];

  const hits = raw.slice(0, limit).map(item => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      sessionId: typeof r.session_id === 'string' ? r.session_id : typeof r.id === 'string' ? r.id : undefined,
      title: typeof r.title === 'string' ? r.title : undefined,
      snippet: typeof r.snippet === 'string' ? r.snippet
        : typeof r.content === 'string' ? r.content.slice(0, 400) : undefined,
      timestamp: typeof r.timestamp === 'string' ? r.timestamp
        : typeof r.created_at === 'string' ? r.created_at : undefined,
      source: typeof r.source === 'string' ? r.source : undefined,
    };
  });

  return { success: true, hits };
}

/** Which memory provider the gateway has active, and how big its files are. */
export async function fetchHermesMemoryState(conn: HermesConnection) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/memory', { token: conn.token });
  if (status === 401 || status === 403) {
    return { success: false as const, error: 'Sign in to Hermes', needsSignIn: true };
  }
  if (status >= 300) return { success: false as const, error: `HTTP ${status}` };
  return { success: true as const, state: body as Record<string, unknown> };
}
