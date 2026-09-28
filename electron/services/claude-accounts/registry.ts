import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { privatePath } from '../../constants';
import { writeSecretFileSync } from '../../utils/secret-file';
import type { ClaudeAccount, ClaudeAccountsSettings } from '../../types';

/**
 * Which Claude accounts Tars may launch agents on (DESIGN-COMPTES-CLAUDE.md, B1).
 *
 * Its own file, not a key of app-settings.json: `app:saveSettings` merges
 * whatever the renderer sends over what is saved, so a Settings page holding
 * an older copy of the list would have put back an account removed since, or
 * dropped one added since. Only the claude-accounts channels write this one.
 * And in ~/.tars-private, not ~/.dorothy: every agent is handed ~/.dorothy with
 * --add-dir and can write there (the Audit's B2).
 *
 * The file names accounts, not folders. An account's folder is derived from
 * its id, ~/.claude-accounts/<id>, whatever the file says: an entry pointing
 * an account at ~/Documents would otherwise have Tars write links there and
 * Remove trash it.
 *
 * Everything below takes settings and returns new ones, without touching the
 * ones it was given; the handlers read, change, write.
 */

export const DEFAULT_ACCOUNT_ID = 'default';
export const MAX_ACCOUNTS = 5;
export const DEFAULT_FIVE_HOUR_THRESHOLD = 90;
export const DEFAULT_WEEKLY_THRESHOLD = 95;
const MIN_THRESHOLD = 50;
const MAX_LABEL = 40;

const ACCOUNT_ID = /^acct-[0-9a-f]{6}$/;
// C0 and C1 controls, DEL, and the bidirectional overrides and isolates: a
// label is printed in Settings and on every agent card.
const UNREADABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export function accountsFile(): string {
  return privatePath('claude-accounts.json');
}

/**
 * Where the accounts' directories live: ~/.claude-accounts, the home resolved
 * once. Outside ~/.dorothy on purpose, since every agent is given that one
 * with --add-dir and, on Linux, a credential is a file in its account's
 * directory.
 */
export function accountsRoot(home: string = os.homedir()): string {
  return path.join(fs.realpathSync(home), '.claude-accounts');
}

export function defaultAccountsSettings(): ClaudeAccountsSettings {
  return {
    enabled: false,
    accounts: [{ id: DEFAULT_ACCOUNT_ID, label: 'Account 1', configDir: null, enabled: true }],
    fiveHourThreshold: DEFAULT_FIVE_HOUR_THRESHOLD,
    weeklyThreshold: DEFAULT_WEEKLY_THRESHOLD,
  };
}

/** The label trimmed, or an error that says what is wrong with it. */
export function validateLabel(label: unknown): string {
  if (typeof label !== 'string') throw new Error('An account needs a label.');
  const trimmed = label.trim();
  if (!trimmed) throw new Error('An account needs a label.');
  if (trimmed.length > MAX_LABEL) throw new Error(`An account label is ${MAX_LABEL} characters at most.`);
  if (UNREADABLE.test(trimmed)) throw new Error('An account label cannot hold control or direction characters.');
  return trimmed;
}

function isThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_THRESHOLD && value <= 100;
}

/** The folder of an account id: under the root, named by the id. */
export function accountDir(id: string, root: string = accountsRoot()): string {
  if (!ACCOUNT_ID.test(id)) throw new Error('There is no such account.');
  return path.join(root, id);
}

/** One entry of the file as an account, or null when it is not one. */
function readAccount(raw: unknown, fallbackLabel: string, root: string): ClaudeAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const isDefault = r.id === DEFAULT_ACCOUNT_ID;
  if (!isDefault && !(typeof r.id === 'string' && ACCOUNT_ID.test(r.id))) return null;
  let label: string;
  try {
    label = validateLabel(r.label);
  } catch {
    label = fallbackLabel;
  }
  return {
    id: r.id as string,
    label,
    // Derived, never read from the file: see the top of this file.
    configDir: isDefault ? null : accountDir(r.id as string, root),
    enabled: r.enabled !== false,
  };
}

/** What the file holds, made valid. Anything it cannot read is the defaults. */
export function normalizeAccountsSettings(raw: unknown, root: string = accountsRoot()): ClaudeAccountsSettings {
  const defaults = defaultAccountsSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const r = raw as Record<string, unknown>;

  const accounts: ClaudeAccount[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(r.accounts) ? r.accounts : []) {
    const account = readAccount(entry, `Account ${accounts.length + 1}`, root);
    if (!account || seen.has(account.id)) continue;
    seen.add(account.id);
    accounts.push(account);
  }
  if (!seen.has(DEFAULT_ACCOUNT_ID)) accounts.unshift(defaults.accounts[0]);
  // Five at most, account 1 always among them.
  const kept = accounts.filter((a, i) => a.id === DEFAULT_ACCOUNT_ID
    || accounts.slice(0, i).filter(b => b.id !== DEFAULT_ACCOUNT_ID).length < MAX_ACCOUNTS - 1);

  return {
    enabled: r.enabled === true,
    accounts: kept,
    fiveHourThreshold: isThreshold(r.fiveHourThreshold) ? r.fiveHourThreshold : defaults.fiveHourThreshold,
    weeklyThreshold: isThreshold(r.weeklyThreshold) ? r.weeklyThreshold : defaults.weeklyThreshold,
  };
}

export function readAccountsSettings(): ClaudeAccountsSettings {
  try {
    return normalizeAccountsSettings(JSON.parse(fs.readFileSync(accountsFile(), 'utf-8')));
  } catch {
    return defaultAccountsSettings();
  }
}

export function writeAccountsSettings(settings: ClaudeAccountsSettings): void {
  writeSecretFileSync(accountsFile(), JSON.stringify(settings, null, 2));
}

function find(settings: ClaudeAccountsSettings, id: unknown): ClaudeAccount {
  const account = settings.accounts.find(a => a.id === id);
  if (!account) throw new Error('There is no such account.');
  return account;
}

function uniqueLabel(settings: ClaudeAccountsSettings, label: unknown, exceptId?: string): string {
  const clean = validateLabel(label);
  if (settings.accounts.some(a => a.id !== exceptId && a.label.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`Another account already has the label "${clean}".`);
  }
  return clean;
}

function withAccounts(settings: ClaudeAccountsSettings, accounts: ClaudeAccount[]): ClaudeAccountsSettings {
  return { ...settings, accounts };
}

/**
 * A new account, its directory under `root` named by a random id (one in 16
 * million), checked against the list, rather than the next free number: a
 * directory names its keychain item, and a number given again would find the
 * item of the account that had it, had its logout failed.
 */
export function addAccount(settings: ClaudeAccountsSettings, label: unknown, root: string): { settings: ClaudeAccountsSettings; account: ClaudeAccount } {
  if (!path.isAbsolute(root)) throw new Error('The accounts folder must be an absolute path.');
  if (settings.accounts.length >= MAX_ACCOUNTS) throw new Error(`Tars manages ${MAX_ACCOUNTS} Claude accounts at most.`);
  const clean = uniqueLabel(settings, label);
  let id: string;
  do {
    id = `acct-${randomBytes(3).toString('hex')}`;
  } while (settings.accounts.some(a => a.id === id));
  const account: ClaudeAccount = { id, label: clean, configDir: accountDir(id, root), enabled: true };
  return { settings: withAccounts(settings, [...settings.accounts.map(a => ({ ...a })), account]), account };
}

export function renameAccount(settings: ClaudeAccountsSettings, id: unknown, label: unknown): ClaudeAccountsSettings {
  const target = find(settings, id);
  const clean = uniqueLabel(settings, label, target.id);
  return withAccounts(settings, settings.accounts.map(a => (a.id === target.id ? { ...a, label: clean } : { ...a })));
}

export function setAccountEnabled(settings: ClaudeAccountsSettings, id: unknown, enabled: unknown): ClaudeAccountsSettings {
  const target = find(settings, id);
  if (typeof enabled !== 'boolean') throw new Error('Enabled is on or off.');
  return withAccounts(settings, settings.accounts.map(a => (a.id === target.id ? { ...a, enabled } : { ...a })));
}

/** A new order: exactly the ids there are, each once. */
export function reorderAccounts(settings: ClaudeAccountsSettings, ids: unknown): ClaudeAccountsSettings {
  if (!Array.isArray(ids) || ids.length !== settings.accounts.length || new Set(ids).size !== ids.length) {
    throw new Error('A new order names every account once.');
  }
  return withAccounts(settings, ids.map(id => ({ ...find(settings, id) })));
}

export function removeAccount(settings: ClaudeAccountsSettings, id: unknown): ClaudeAccountsSettings {
  const target = find(settings, id);
  if (target.id === DEFAULT_ACCOUNT_ID) throw new Error('Account 1 is the Claude Code account this Mac already uses, and stays.');
  return withAccounts(settings, settings.accounts.filter(a => a.id !== target.id).map(a => ({ ...a })));
}

export function setThresholds(settings: ClaudeAccountsSettings, fiveHour: unknown, weekly: unknown): ClaudeAccountsSettings {
  if (!isThreshold(fiveHour) || !isThreshold(weekly)) {
    throw new Error(`A threshold is a whole percentage from ${MIN_THRESHOLD} to 100.`);
  }
  return { ...settings, accounts: settings.accounts.map(a => ({ ...a })), fiveHourThreshold: fiveHour, weeklyThreshold: weekly };
}

export function setEnabled(settings: ClaudeAccountsSettings, enabled: unknown): ClaudeAccountsSettings {
  if (typeof enabled !== 'boolean') throw new Error('The option is on or off.');
  return { ...settings, accounts: settings.accounts.map(a => ({ ...a })), enabled };
}
