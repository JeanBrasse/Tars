import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { DATA_DIR, dataPath } from '../constants';
import { readHermesConnection, writeHermesConnection } from '../services/hermes-config';
import {
  fetchHermesCrons,
  hermesCronAction,
  updateHermesCron,
  deleteHermesCron,
  probeHermes,
  signInHermes,
  clearHermesSession,
  fetchHermesBoard,
  createHermesTask,
  updateHermesTask,
} from '../services/hermes-client';
import {
  HermesConnection,
  defaultHermesConnection,
  resolveHermesBaseUrl,
  HERMES_DEFAULT_PORT,
} from '../types/hermes';

const execFileAsync = promisify(execFile);

/** Where Hermes Desktop keeps its own connection config on macOS. */
const HERMES_DESKTOP_CONFIG = path.join(
  os.homedir(), 'Library', 'Application Support', 'Hermes', 'connection.json',
);

const readConnection = readHermesConnection;
const writeConnection = writeHermesConnection;

/** Hermes Desktop's config shape -> ours (same vocabulary, nested differently). */
function importDesktopConfig(): HermesConnection | null {
  try {
    if (!fs.existsSync(HERMES_DESKTOP_CONFIG)) return null;
    const raw = JSON.parse(fs.readFileSync(HERMES_DESKTOP_CONFIG, 'utf-8'));
    const mode = raw?.mode as HermesConnection['mode'];
    if (!mode) return null;
    const conn: HermesConnection = { mode, authMode: 'token' };
    const section = raw?.[mode] ?? {};
    if (mode === 'remote' || mode === 'cloud') {
      conn.url = section.url;
      conn.authMode = section.authMode === 'oauth' ? 'oauth' : 'token';
      if (section.token?.encoding === 'plain' && section.token?.value) conn.token = section.token.value;
      if (section.org) conn.org = section.org;
    } else if (mode === 'ssh') {
      conn.ssh = {
        host: section.host, user: section.user,
        port: section.port, keyPath: section.keyPath || section.identityFile,
        remotePort: section.remotePort || HERMES_DEFAULT_PORT,
        localPort: section.localPort,
      };
    } else {
      conn.localPort = section.port || HERMES_DEFAULT_PORT;
    }
    return conn;
  } catch (err) {
    console.error('[hermes] cannot import Hermes Desktop config:', err);
    return null;
  }
}

/** GET a Hermes endpoint, following the gateway's own auth conventions. */
function hermesGet(baseUrl: string, pathname: string, token?: string, timeoutMs = 6000): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(baseUrl + pathname); } catch { reject(new Error('Invalid gateway URL')); return; }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, {
      method: 'GET',
      timeout: timeoutMs,
      headers: token ? { 'X-Hermes-Session-Token': token } : undefined,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const API_PORT = 31415;

/**
 * Hermes integration handlers: everything the Settings → Hermes section
 * needs to wire a remote (VPS) Hermes instance to this Tars:
 * - connection info: the incoming-webhook URL/token to paste into Hermes
 *   cron jobs, plus Tailscale state (DNS name, serve status) so the user
 *   knows exactly how the VPS reaches this machine
 * - a local dry-run test of the webhook (auth + agent resolution, no dispatch)
 * - a reachability check of the Hermes gateway URL itself
 */

interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  dnsName?: string;
  ip?: string;
  serveConfigured: boolean;
}

async function detectTailscale(): Promise<TailscaleInfo> {
  const candidates = ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 4000 });
      const status = JSON.parse(stdout);
      const dnsName = typeof status?.Self?.DNSName === 'string'
        ? status.Self.DNSName.replace(/\.$/, '')
        : undefined;
      const ip = Array.isArray(status?.Self?.TailscaleIPs) ? status.Self.TailscaleIPs[0] : undefined;

      let serveConfigured = false;
      try {
        const { stdout: serveOut } = await execFileAsync(bin, ['serve', 'status'], { timeout: 4000 });
        serveConfigured = !/no serve config/i.test(serveOut) && serveOut.trim().length > 0;
      } catch { /* serve status exits non-zero when unconfigured on some versions */ }

      return {
        installed: true,
        running: status?.BackendState === 'Running',
        dnsName,
        ip,
        serveConfigured,
      };
    } catch { /* try next candidate */ }
  }
  return { installed: false, running: false, serveConfigured: false };
}

/** Dedicated secret for the incoming webhook: exposing the master API token
 *  over the tailnet would hand out full control of every route. */
function readWebhookSecret(): string {
  const file = dataPath('hermes-webhook-secret');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8').trim();
    const secret = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch (err) {
    console.error('[hermes] cannot provision webhook secret:', err);
    return '';
  }
}

function readApiToken(): string {
  try {
    return fs.readFileSync(dataPath('api-token'), 'utf-8').trim();
  } catch {
    return '';
  }
}

/** POST JSON to the local API and resolve with {status, body}. */
function postLocal(pathname: string, token: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: API_PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
      timeout: 5000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

export function registerHermesHandlers(): void {
  ipcMain.handle('hermes:getConnectionInfo', async () => {
    const [tailscale, token] = await Promise.all([detectTailscale(), Promise.resolve(readWebhookSecret())]);
    const tailnetUrl = tailscale.dnsName ? `https://${tailscale.dnsName}/api/webhooks/hermes` : undefined;
    return {
      apiPort: API_PORT,
      webhookPath: '/api/webhooks/hermes',
      webhookLocalUrl: `http://127.0.0.1:${API_PORT}/api/webhooks/hermes`,
      webhookTailnetUrl: tailnetUrl,
      apiToken: token,
      tailscale,
      serveCommand: `tailscale serve --bg --set-path /api/webhooks/hermes ${API_PORT}`,
    };
  });

  ipcMain.handle('hermes:connection:get', async () => {
    const connection = readConnection();
    return {
      connection,
      baseUrl: resolveHermesBaseUrl(connection),
      desktopConfigAvailable: fs.existsSync(HERMES_DESKTOP_CONFIG),
    };
  });

  ipcMain.handle('hermes:connection:save', async (_event, connection: HermesConnection) => {
    try {
      writeConnection(connection);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('hermes:connection:import', async () => {
    const imported = importDesktopConfig();
    if (!imported) return { success: false, error: 'No Hermes Desktop configuration found on this machine.' };
    writeConnection(imported);
    return { success: true, connection: imported, baseUrl: resolveHermesBaseUrl(imported) };
  });

  /**
   * Probes the gateway the way Hermes Desktop does: /api/status is public and
   * advertises the version plus which auth model is in force, so we can tell
   * "unreachable" from "reachable but you still need to sign in".
   */
  ipcMain.handle('hermes:connection:test', async (_event, connection: HermesConnection) => {
    const probe = await probeHermes(connection);
    return {
      success: probe.reachable && (!probe.authRequired || probe.signedIn),
      baseUrl: probe.baseUrl,
      status: probe.status,
      version: probe.version,
      gatewayState: probe.gatewayState,
      authRequired: probe.authRequired,
      authFlows: probe.authFlows,
      authProviders: probe.authProviders,
      signedIn: probe.signedIn,
      needsSignIn: probe.authRequired && !probe.signedIn,
      error: probe.error,
    };
  });

  ipcMain.handle('hermes:signIn', async (_event, params: { connection: HermesConnection; username: string; password: string; provider?: string }) => {
    const result = await signInHermes(params.connection, {
      username: params.username, password: params.password, provider: params.provider,
    });
    if (!result.success) return result;
    const probe = await probeHermes(params.connection);
    return { success: true, version: probe.version, gatewayState: probe.gatewayState };
  });

  ipcMain.handle('hermes:signOut', async (_event, connection: HermesConnection) => {
    clearHermesSession(resolveHermesBaseUrl(connection));
    return { success: true };
  });

  // ── Crons (schedules live in Hermes) ──
  ipcMain.handle('hermes:crons:list', async () => fetchHermesCrons(readConnection()));

  ipcMain.handle('hermes:crons:action', async (_event, params: { action: 'pause' | 'resume' | 'trigger'; jobId: string; profile?: string }) =>
    hermesCronAction(readConnection(), params.action, params.jobId, params.profile));

  // Editing a schedule. The page could only run/pause/delete before this
  // channel existed, so there was nothing behind an edit control to call.
  ipcMain.handle('hermes:crons:update', async (_event, params: { jobId: string; updates: Record<string, unknown>; profile?: string }) =>
    updateHermesCron(readConnection(), params.jobId, params.updates ?? {}, params.profile));

  ipcMain.handle('hermes:crons:delete', async (_event, params: { jobId: string; profile?: string }) =>
    deleteHermesCron(readConnection(), params.jobId, params.profile));

  // ── Kanban (the board lives in Hermes; Tars is a client) ──
  ipcMain.handle('hermes:kanban:board', async (_event, params: { board?: string } = {}) => {
    return fetchHermesBoard(readConnection(), params?.board);
  });

  ipcMain.handle('hermes:kanban:createTask', async (_event, task: Record<string, unknown>) => {
    return createHermesTask(readConnection(), task);
  });

  ipcMain.handle('hermes:kanban:updateTask', async (_event, params: { taskId: string; patch: Record<string, unknown> }) => {
    return updateHermesTask(readConnection(), params.taskId, params.patch);
  });

  // Reachability check of the remote Hermes gateway (any HTTP response counts:
  // we only prove the tailnet route works, not the gateway's API shape).
  ipcMain.handle('hermes:testGateway', async (_event, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url.trim())) {
      return { success: false, error: 'Enter an http(s):// URL first' };
    }
    try {
      const target = new URL(url.trim());
      const mod = target.protocol === 'https:' ? await import('https') : await import('http');
      const status = await new Promise<number>((resolve, reject) => {
        const req = mod.request(target, { method: 'GET', timeout: 6000 }, res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
