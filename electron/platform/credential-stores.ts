import * as path from 'path';
import type { Env } from './fs-probe';
import { envValue } from './path-env';

/**
 * Where Windows programs keep credentials, for the guards that decide which
 * files an agent may send out of the machine (audit B M-03): the app's
 * `isSafeTelegramPath` and, in its own copy, the Telegram MCP server's.
 *
 * On macOS and Linux those guards refuse the home's dotfiles (`~/.ssh`,
 * `~/.aws`, ...), which is where the tools keep them there. On Windows the same
 * tools, and the ones only Windows has, keep them under %APPDATA% (roaming)
 * and %LOCALAPPDATA%. Each is listed both where the variable says and in its
 * default place under the home, since the two can differ (a redirected
 * profile, a sandboxed one). The guards compare without case.
 *
 * darwin/linux: none. Their guards stay exactly as they were; the
 * `~/Library` equivalents (Keychains, browser profiles, Tars's own profile)
 * are the same gap there, left for a decision of its own.
 */
const ROAMING = [
  'GitHub CLI', // hosts.yml: the gh token
  'gcloud', // credentials.db, access_tokens.db, legacy_credentials
  'tars', // Tars's own Electron profile: cookies, local storage
  'Microsoft\\Credentials', // Credential Manager
  'Microsoft\\Protect', // DPAPI master keys, which decrypt everything above
  'Microsoft\\Crypto', // private keys
  'Microsoft\\SystemCertificates', // certificates with their keys
  'Microsoft\\Vault',
  'Mozilla', // Firefox profiles: logins.json, key4.db, cookies
  'Opera Software',
  'Telegram Desktop', // tdata: a logged-in session
  'discord', // its token, in Local Storage
  'Slack',
  'Signal',
  'Bitwarden',
];

const LOCAL = [
  'Microsoft\\Credentials',
  'Microsoft\\Vault',
  'Microsoft\\TokenBroker', // Microsoft account and Entra ID tokens
  'Microsoft\\IdentityCache',
  'Microsoft\\OneAuth',
  'Google\\Chrome\\User Data', // cookies, Login Data
  'Microsoft\\Edge\\User Data',
  'BraveSoftware\\Brave-Browser\\User Data',
  'Chromium\\User Data',
  'Vivaldi\\User Data',
  '1Password',
];

/** Home dotfiles that hold credentials on Windows and are not in the guards' own lists. */
const HOME = ['.azure'];

export function credentialStoreDirs(opts: { platform?: NodeJS.Platform; home: string; env?: Env }): string[] {
  if ((opts.platform ?? process.platform) !== 'win32') return [];
  const env = opts.env ?? process.env;
  const w = path.win32;
  const roaming = [envValue(env, 'APPDATA', 'win32'), w.join(opts.home, 'AppData', 'Roaming')];
  const local = [envValue(env, 'LOCALAPPDATA', 'win32'), w.join(opts.home, 'AppData', 'Local')];
  const dirs = [
    ...roaming.filter((d): d is string => !!d).flatMap(base => ROAMING.map(rel => w.join(base, rel))),
    ...local.filter((d): d is string => !!d).flatMap(base => LOCAL.map(rel => w.join(base, rel))),
    ...HOME.map(rel => w.join(opts.home, rel)),
  ];
  const seen = new Set<string>();
  return dirs.filter(d => !seen.has(d.toLowerCase()) && !!seen.add(d.toLowerCase()));
}
