/**
 * Hermes connection model: mirrors the contract implemented by Hermes
 * Desktop in apps/desktop/electron/connection-config.ts, so a Tars config
 * can be imported from (and stay compatible with) the user's existing setup.
 *
 * Auth models a gateway can advertise on GET /api/status:
 *  - token: static dashboard session token. REST uses the
 *    `X-Hermes-Session-Token` header, WS uses `?token=`.
 *  - oauth/cookie: the gateway gates behind a login flow and authenticates
 *    REST with an HttpOnly session cookie; WS upgrades need a single-use
 *    ticket minted at POST /api/auth/ws-ticket.
 */

export type HermesMode = 'local' | 'ssh' | 'remote' | 'cloud';
export type HermesAuthMode = 'token' | 'oauth';

export interface HermesSshConfig {
  host: string;
  user: string;
  /** SSH port on the remote host. Default 22. */
  port?: number;
  /** Path to a private key; falls back to the agent/default keys when empty. */
  keyPath?: string;
  /** Port the gateway listens on, on the remote host. Default 9119. */
  remotePort?: number;
  /** Local port the tunnel binds to. Default = remotePort. */
  localPort?: number;
}

export interface HermesConnection {
  mode: HermesMode;
  /** local: the gateway port on this machine (default 9119). */
  localPort?: number;
  ssh?: HermesSshConfig;
  /** remote/cloud: absolute gateway URL. */
  url?: string;
  authMode?: HermesAuthMode;
  /** Static session token (token auth) or the stored gateway token. */
  token?: string;
  /** cloud only: organisation/workspace slug. */
  org?: string;
}

export const HERMES_DEFAULT_PORT = 9119;

export function defaultHermesConnection(): HermesConnection {
  return { mode: 'local', localPort: HERMES_DEFAULT_PORT, authMode: 'token' };
}

/** The HTTP base URL a given config resolves to. */
export function resolveHermesBaseUrl(conn: HermesConnection): string {
  switch (conn.mode) {
    case 'local':
      return `http://127.0.0.1:${conn.localPort || HERMES_DEFAULT_PORT}`;
    case 'ssh': {
      const local = conn.ssh?.localPort || conn.ssh?.remotePort || HERMES_DEFAULT_PORT;
      return `http://127.0.0.1:${local}`;
    }
    case 'remote':
    case 'cloud':
    default:
      return (conn.url || '').trim().replace(/\/+$/, '');
  }
}
