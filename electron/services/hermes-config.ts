import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { defaultHermesConnection, type HermesConnection } from '../types/hermes';
import { describeSecretFileError, ensureSecretFileMode, writeSecretFileSync } from '../utils/secret-file';

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
    // Same reason as the session jar: this file holds `token`, and a parse
    // error would quote its first characters into the log.
    console.error(`[hermes] cannot read connection config: ${describeSecretFileError(err)}`);
  }
  return defaultHermesConnection();
}

export function writeHermesConnection(conn: HermesConnection): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Holds the gateway session token - same treatment as app-settings.json.
  writeSecretFileSync(HERMES_CONNECTION_FILE, JSON.stringify(conn, null, 2));
}

/**
 * The connection the file names, for what must never guess. readHermesConnection()
 * fills whatever the file lacks, or all of it when the file cannot be read, from
 * the default, 127.0.0.1:9119, which on Noah's machine is the SSH tunnel to his
 * Hermes: a broken file sent a sandbox's kanban to his board (the Backend's gate
 * of #171). Here the file must read, parse to an object and name the address its
 * mode needs. Null when there is no file; otherwise the reason, which never quotes
 * the file: it holds the gateway's token.
 */
export function configuredHermesConnection(): { conn: HermesConnection } | { unusable: string } | null {
  if (!fs.existsSync(HERMES_CONNECTION_FILE)) return null;
  const unusable = (why: string) => ({ unusable: `${HERMES_CONNECTION_FILE} ${why}: save the connection again in Settings, Hermes.` });
  let parsed: unknown;
  try {
    ensureSecretFileMode(HERMES_CONNECTION_FILE);
    parsed = JSON.parse(fs.readFileSync(HERMES_CONNECTION_FILE, 'utf-8'));
  } catch (err) {
    return unusable(`cannot be read (${describeSecretFileError(err)})`);
  }
  if (!parsed || typeof parsed !== 'object') return unusable('holds no connection');
  const file = parsed as Partial<HermesConnection>;
  const conn: HermesConnection = { ...defaultHermesConnection(), ...file };
  switch (file.mode) {
    case 'local': {
      const port = file.localPort;
      return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
        ? { conn }
        : unusable('names no port for the local gateway');
    }
    case 'ssh':
      return typeof file.ssh?.host === 'string' && file.ssh.host.trim() ? { conn } : unusable('names no SSH host');
    case 'remote':
    case 'cloud':
      return typeof file.url === 'string' && file.url.trim() ? { conn } : unusable('names no gateway URL');
    default:
      return unusable('names no mode Tars knows');
  }
}

/** A connection worth attempting: configured, and not the empty default. */
export function usableHermesConnection(): HermesConnection | null {
  const conn = readHermesConnection();
  if (conn.mode === 'local') return conn;
  if (conn.mode === 'ssh') return conn.ssh?.host ? conn : null;
  return conn.url ? conn : null;
}
