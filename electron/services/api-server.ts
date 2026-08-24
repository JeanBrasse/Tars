import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import TelegramBot from 'node-telegram-bot-api';
import { App as SlackApp } from '@slack/bolt';
import { AgentStatus, AppSettings } from '../types';
import { API_PORT, API_TOKEN_FILE } from '../constants';
import { RouteApp, RouteContext, RouteRequest } from './api-routes';
import { registerAllRoutes } from './api-routes';

/** Enough for a prompt or a webhook payload, far short of a memory attack. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// The event bus lives in its own module: the overseer listens to it and must
// not have to import the HTTP server, the Telegram bot and the Slack app to do
// so. Re-exported here because callers reach it through this file.
export { emitAgentStatus } from './agent-events';
import { agentStatusEmitter } from './agent-events';
export { agentStatusEmitter };

let apiServer: http.Server | null = null;
let apiToken: string | null = null;

/**
 * How long the local API keeps trying to bind before it gives up.
 *
 * The usual cause of EADDRINUSE here is not a permanent squatter: it is the
 * previous Tars still shutting down and holding the port for a second or two.
 * A single attempt was enough to lose the whole local API for the life of the
 * process, so the schedule front-loads fast retries and then backs off. Eight
 * attempts spread over about ninety seconds, then a loud, final give-up.
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const RETRY_WINDOW_MS = RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

/** Where the local API is in its lifecycle. */
export type ApiServerPhase = 'stopped' | 'starting' | 'listening' | 'retrying' | 'failed';

export interface ApiServerState {
  phase: ApiServerPhase;
  /** The port it is serving, or the one it keeps failing to bind. */
  port: number;
  /** Bind attempts made so far, including the one in flight. */
  attempts: number;
  maxAttempts: number;
  /** Message of the last bind failure, null while healthy. */
  lastError: string | null;
  /** Milliseconds until the next attempt while retrying, null otherwise. */
  nextRetryInMs: number | null;
  /** Epoch ms of the moment it started listening, null when it is not. */
  listeningSince: number | null;
}

let apiServerState: ApiServerState = {
  phase: 'stopped',
  port: API_PORT,
  attempts: 0,
  maxAttempts: MAX_ATTEMPTS,
  lastError: null,
  nextRetryInMs: null,
  listeningSince: null,
};
let retryTimer: NodeJS.Timeout | null = null;

/**
 * Emits 'state' with the new ApiServerState on every transition.
 *
 * The port is a contract: CLAUDE_MGR_API_URL, the shell hooks and the bundled
 * MCP servers all assume something is listening on it. When nothing is, every
 * one of them fails with a connection refused that nobody in the app sees. So
 * the state is published rather than logged and forgotten, and anything in the
 * main process that needs to know whether delegation can work at all can ask
 * getApiServerState() or subscribe here.
 */
export const apiServerEmitter = new EventEmitter();

/** The local API's real state. Safe to call at any time, including before start. */
export function getApiServerState(): ApiServerState {
  return { ...apiServerState };
}

function setApiServerState(patch: Partial<ApiServerState>): void {
  apiServerState = { ...apiServerState, ...patch };
  apiServerEmitter.emit('state', getApiServerState());
}

function initApiToken(): string {
  try {
    if (fs.existsSync(API_TOKEN_FILE)) {
      const existing = fs.readFileSync(API_TOKEN_FILE, 'utf-8').trim();
      if (existing.length >= 32) {
        apiToken = existing;
        return existing;
      }
    }
  } catch { /* regenerate */ }

  const token = crypto.randomBytes(32).toString('hex');
  const dir = path.dirname(API_TOKEN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(API_TOKEN_FILE, token, { mode: 0o600 });
  apiToken = token;
  return token;
}

export function getApiToken(): string {
  if (!apiToken) {
    return initApiToken();
  }
  return apiToken;
}

function createRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

function matchRoute(pattern: string | RegExp, pathname: string): Record<string, string> | null {
  if (typeof pattern === 'string') {
    return pathname === pattern ? {} : null;
  }
  const m = pathname.match(pattern);
  if (!m) return null;
  // Map positional captures to 'id' (first group): all parameterized routes use a single :id param
  return m[1] ? { id: m[1] } : {};
}

export function startApiServer(
  mainWindow: BrowserWindow | null,
  appSettings: AppSettings,
  getTelegramBot: () => TelegramBot | null,
  getSlackApp: () => SlackApp | null,
  slackResponseChannel: string | null,
  slackResponseThreadTs: string | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  sendNotificationCallback: (
    title: string,
    body: string,
    agentId?: string,
    notificationSettings?: { notificationsEnabled: boolean; notificationSounds?: Record<string, string> },
  ) => void,
  initAgentPtyCallback: (agent: AgentStatus) => Promise<string>,
  getAppSettings?: () => AppSettings
) {
  if (apiServer) {
    // A server that gave up on the port is still a live object, and the old
    // guard made that permanent: nothing could ever start the API again for
    // the life of the process. A caller retrying after a give-up gets a fresh
    // server and a fresh attempt budget.
    if (apiServerState.phase !== 'failed') return;
    const abandoned = apiServer;
    apiServer = null;
    abandoned.close();
    // A fresh server gets a fresh attempt budget, or the retry schedule would
    // still be exhausted and the first EADDRINUSE would give up at once.
    setApiServerState({ attempts: 0, lastError: null, nextRetryInMs: null, listeningSince: null });
  }

  initApiToken();

  const routeApp = createRouteApp();
  const ctx: RouteContext = {
    mainWindow,
    appSettings,
    getAppSettings: getAppSettings || (() => appSettings),
    getTelegramBot,
    getSlackApp,
    slackResponseChannel,
    slackResponseThreadTs,
    handleStatusChangeNotificationCallback,
    sendNotificationCallback,
    initAgentPtyCallback,
    agentStatusEmitter,
  };
  registerAllRoutes(routeApp, ctx);

  apiServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);
    const pathname = url.pathname;

    // Auth check: exempt local-only endpoints called from hooks/shell scripts
    const authExempt = pathname === '/api/local-file'
      || pathname === '/api/health'
      || pathname.startsWith('/api/hooks/')
      || pathname === '/api/kanban/complete';

    // A browser tab on any site can reach 127.0.0.1. CORS hides the response
    // but not the side effect, so reject cross-origin callers outright: our
    // own renderer is app://- in production and localhost:3000 in dev, and
    // the shell hooks send no Origin at all.
    const origin = req.headers.origin;
    if (origin && origin !== 'app://-' && origin !== 'http://localhost:3000') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }

    if (!authExempt) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${apiToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Parse body for POST and PUT requests
    let body: Record<string, unknown> = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        // Bounded: this reads before routing, and on the auth-exempt hook
        // paths, so an unbounded stream was a way to exhaust the main
        // process's memory without any credential at all.
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of req) {
          received += (chunk as Buffer).length;
          if (received > MAX_BODY_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const data = Buffer.concat(chunks).toString();
        if (data) {
          const parsed = JSON.parse(data);
          // Reject the two keys that would let a request write onto
          // Object.prototype once the body is spread or merged downstream.
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const clean = parsed as Record<string, unknown>;
            delete clean['__proto__'];
            delete clean['constructor'];
            body = clean;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    const sendJson = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      // Dispatch to first matching route
      for (const route of routeApp.routes) {
        if (route.method !== req.method) continue;
        const params = matchRoute(route.pattern, pathname);
        if (params === null) continue;

        const routeReq: RouteRequest = {
          method: req.method!,
          pathname,
          url,
          body,
          raw: req,
          res,
          params,
        };
        await route.handler(routeReq, sendJson, ctx);
        return;
      }

      sendJson({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('API error:', error);
      sendJson({ error: 'Internal server error' }, 500);
    }
  });

  const server = apiServer;
  const resolveSettings = getAppSettings || (() => appSettings);

  const attemptBind = () => {
    if (apiServer !== server) return;
    const attempts = apiServerState.attempts + 1;
    setApiServerState({
      phase: attempts === 1 ? 'starting' : 'retrying',
      attempts,
      nextRetryInMs: null,
    });
    server.listen(API_PORT, '127.0.0.1');
  };

  const giveUp = (err: NodeJS.ErrnoException) => {
    setApiServerState({
      phase: 'failed',
      lastError: err.message,
      nextRetryInMs: null,
      listeningSince: null,
    });
    // Loud on purpose. The window stays perfectly healthy-looking while every
    // path back into the app is dead, which is exactly how this went unnoticed
    // the last time: hooks, the seven MCP servers, /dispatch and /delegate all
    // speak to this port and nothing else reports that it is gone.
    console.error(
      `[api] FATAL: could not bind the local API to 127.0.0.1:${API_PORT} after ` +
      `${MAX_ATTEMPTS} attempts over ${Math.round(RETRY_WINDOW_MS / 1000)}s.`,
    );
    console.error(
      '[api] Delegation is offline: the CLI hooks, the bundled MCP servers, /dispatch and /delegate all call back on this port.',
    );
    console.error(
      `[api] Another process holds it. Find it with: lsof -nP -iTCP:${API_PORT} -sTCP:LISTEN`,
    );
    console.error('[api] Quit it (most often a second Tars), then restart Tars.');

    const settings = resolveSettings();
    if (settings?.notificationsEnabled) {
      sendNotificationCallback(
        'Tars API error: port in use',
        `Port ${API_PORT} is held by another process, so delegation, hooks and MCP servers are offline. Quit the other instance and restart Tars.`,
        undefined,
        settings,
      );
    }
  };

  server.on('listening', () => {
    if (apiServer !== server) return;
    setApiServerState({
      phase: 'listening',
      lastError: null,
      nextRetryInMs: null,
      listeningSince: Date.now(),
    });
    const retried = apiServerState.attempts > 1 ? ` after ${apiServerState.attempts} attempts` : '';
    console.log(`Agent API server running on http://127.0.0.1:${API_PORT}${retried}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    // This listener is never detached. A bind that fails after stopApiServer()
    // has already dropped the reference is not news, but leaving it unhandled
    // would take the main process down with it.
    if (apiServer !== server) return;

    if (err.code !== 'EADDRINUSE') {
      console.error('API server error:', err);
      // An error raised while it is serving does not mean the bind is lost, so
      // only a server that is not listening is reported as down.
      if (!server.listening) {
        setApiServerState({
          phase: 'failed',
          lastError: err.message,
          nextRetryInMs: null,
          listeningSince: null,
        });
      }
      return;
    }

    if (apiServerState.attempts >= MAX_ATTEMPTS) {
      giveUp(err);
      return;
    }
    const delay = RETRY_DELAYS_MS[apiServerState.attempts - 1];

    console.warn(
      `[api] Port ${API_PORT} is in use (attempt ${apiServerState.attempts}/${MAX_ATTEMPTS}). ` +
      `Retrying in ${Math.round(delay / 1000)}s.`,
    );
    setApiServerState({
      phase: 'retrying',
      lastError: err.message,
      nextRetryInMs: delay,
      listeningSince: null,
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attemptBind();
    }, delay);
    // A pending retry must never be the reason the app cannot quit.
    retryTimer.unref();
  });

  attemptBind();
}

export function stopApiServer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (apiServer) {
    const stopping = apiServer;
    apiServer = null;
    stopping.close();
  }
  setApiServerState({
    phase: 'stopped',
    attempts: 0,
    lastError: null,
    nextRetryInMs: null,
    listeningSince: null,
  });
}
