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
 * The cookie jar lives in the main process only — it must never reach the
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
    // An expired/cleared cookie comes back empty — drop it from the jar.
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

export async function fetchHermesBoard(conn: HermesConnection, board?: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const query = board ? `?board=${encodeURIComponent(board)}` : '';
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/board${query}`, { token: conn.token });
  if (status !== 200) {
    const detail = (body && typeof body === 'object' && 'detail' in body)
      ? String((body as { detail: unknown }).detail) : `HTTP ${status}`;
    return { success: false as const, error: detail, needsSignIn: status === 401 || status === 403 };
  }
  return { success: true as const, board: body };
}

export async function createHermesTask(conn: HermesConnection, task: Record<string, unknown>) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/tasks`, { method: 'POST', body: task, token: conn.token });
  return status < 300 ? { success: true as const, task: body } : { success: false as const, error: `HTTP ${status}`, body };
}

export async function updateHermesTask(conn: HermesConnection, taskId: string, patch: Record<string, unknown>) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, `${KANBAN}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: patch, token: conn.token });
  return status < 300 ? { success: true as const, task: body } : { success: false as const, error: `HTTP ${status}`, body };
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

export async function deleteHermesCron(conn: HermesConnection, jobId: string, profile?: string) {
  const baseUrl = resolveHermesBaseUrl(conn);
  const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const { status } = await hermesRequest(baseUrl, `/api/cron/jobs/${encodeURIComponent(jobId)}${q}`, { method: 'DELETE', token: conn.token });
  return status < 300 ? { success: true as const } : { success: false as const, error: `HTTP ${status}` };
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

/** MEMORY.md (agent notes) and USER.md (user profile) from the gateway. */
export async function fetchHermesMemoryFiles(conn: HermesConnection): Promise<
  { success: true; files: HermesMemoryFile[] } | { success: false; error: string; needsSignIn?: boolean }
> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const files: HermesMemoryFile[] = [];

  for (const name of ['memories/MEMORY.md', 'memories/USER.md']) {
    const { status, body } = await hermesRequest(
      baseUrl, `/api/files/read?path=${encodeURIComponent(name)}`, { token: conn.token },
    );
    if (status === 401 || status === 403) {
      return { success: false, error: 'Sign in to Hermes to read its memory', needsSignIn: true };
    }
    if (status === 404) continue; // the gateway simply has not written it yet
    if (status >= 300) return { success: false, error: `HTTP ${status}` };

    const content = decodeDataUrl((body as Record<string, unknown> | null)?.data_url);
    if (content.trim()) files.push({ name: name.replace('memories/', ''), content });
  }

  return { success: true, files };
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
