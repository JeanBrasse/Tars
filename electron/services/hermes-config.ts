import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { defaultHermesConnection, type HermesConnection } from '../types/hermes';
import { ensureSecretFileMode, writeSecretFileSync } from '../utils/secret-file';

/**
 * The gateway connection, read from one place. The IPC handlers and the local
 * HTTP API both need it: memory routes serve agents, which never go through
 * the renderer.
 */

export const HERMES_CONNECTION_FILE = path.join(DATA_DIR, 'hermes-connection.json');

export function readHermesConnection(): HermesConnection {
  try {
    if (fs.existsSync(HERMES_CONNECTION_FILE)) {
      // This file holds `token`, the static X-Hermes-Session-Token sent on
      // every gateway call, and it used to be written with a bare
      // writeFileSync - 0644 under a default umask, so any other account on
      // the machine could read the credential. The write is 0600 now, but a
      // file created by an older build keeps its mode forever, and a `mode:`
      // on writeFileSync only applies at creation. main.ts narrows it at
      // startup; do it here too so the guarantee belongs to the module that
      // owns the file rather than to a caller remembering.
      ensureSecretFileMode(HERMES_CONNECTION_FILE);
      return { ...defaultHermesConnection(), ...JSON.parse(fs.readFileSync(HERMES_CONNECTION_FILE, 'utf-8')) };
    }
  } catch (err) {
    console.error('[hermes] cannot read connection config:', err);
  }
  return defaultHermesConnection();
}

export function writeHermesConnection(conn: HermesConnection): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Holds the gateway session token - same treatment as app-settings.json.
  writeSecretFileSync(HERMES_CONNECTION_FILE, JSON.stringify(conn, null, 2));
}

/** A connection worth attempting: configured, and not the empty default. */
export function usableHermesConnection(): HermesConnection | null {
  const conn = readHermesConnection();
  if (conn.mode === 'local') return conn;
  if (conn.mode === 'ssh') return conn.ssh?.host ? conn : null;
  return conn.url ? conn : null;
}
