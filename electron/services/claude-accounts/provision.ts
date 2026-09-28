import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { updateSharedJsonSync } from '../../utils/shared-file';
import { writeAtomicSync } from '../../utils/secret-file';

/**
 * Makes an account's configuration directory one Tars's agents can work in
 * (DESIGN-COMPTES-CLAUDE.md, B2). Run when the account is added, and again at
 * each launch on it, so what it copies stays current.
 *
 * Measured on claude 2.1.283: with CLAUDE_CONFIG_DIR set, everything below is
 * read from that directory, symbolic links followed.
 *
 * - Shared through links to ~/.claude: projects/ (the transcripts, and every
 *   agent's memory, which lives in projects/<project>/memory; Usage, the Chat,
 *   resume and the Memory page all read ~/.claude/projects, and `--resume`
 *   from another account finds nothing without it), and the user's own
 *   CLAUDE.md, skills, agents, commands, plugins and output styles.
 * - settings.json: a copy of ~/.claude/settings.json, which is the source. It
 *   carries Tars's hooks and status line, so every account reports like
 *   account 1. A copy and not a link: a file Claude Code rewrites by renaming
 *   a new one over it would turn a link into a file of its own, silently.
 * - .claude.json: the account's own (its identity lives there). Only
 *   mcpServers and theme are mirrored from ~/.claude.json, and onboarding is
 *   marked done so an agent does not stop on first-run screens. Trust for a
 *   project is written at launch (ensureProjectTrusted), not here.
 *
 * Nothing else in the directory is opened, listed or read. The credential
 * (the keychain item named after the directory, or .credentials.json on
 * Linux) is Claude Code's alone.
 */

export const SHARED_ENTRIES = ['projects', 'CLAUDE.md', 'skills', 'agents', 'commands', 'plugins', 'output-styles'] as const;

/** Keys of ~/.claude.json an account mirrors. */
const MIRRORED_KEYS = ['mcpServers', 'theme'] as const;

export interface ProvisionReport {
  /** Shared entries where something real sits in place of the link, left alone. */
  conflicts: string[];
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function readJsonOrUndefined(file: string): Record<string, unknown> | undefined | 'unreadable' {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function linkShared(configDir: string, claudeDir: string, conflicts: string[]): void {
  for (const name of SHARED_ENTRIES) {
    const target = path.join(claudeDir, name);
    const link = path.join(configDir, name);
    // projects/ must be shared even before account 1 has run anything, or the
    // account's first session would create a folder of its own there.
    if (name === 'projects') fs.mkdirSync(target, { recursive: true });
    const current = lstatOrNull(link);
    if (current) {
      if (!current.isSymbolicLink()) {
        conflicts.push(name);
        continue;
      }
      if (fs.readlinkSync(link) === target) continue;
      // A link, and only a link, is removed: it is Tars's own.
      fs.unlinkSync(link);
    }
    if (!lstatOrNull(target)) continue;
    fs.symlinkSync(target, link);
  }
}

function copySettings(configDir: string, claudeDir: string): void {
  let source: string;
  try {
    source = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8');
  } catch {
    return;
  }
  const copy = path.join(configDir, 'settings.json');
  let current: string | undefined;
  try {
    current = fs.readFileSync(copy, 'utf-8');
  } catch {
    current = undefined;
  }
  if (current !== source) writeAtomicSync(copy, source, 0o600);
}

function mirrorClaudeJson(configDir: string, home: string): void {
  const source = readJsonOrUndefined(path.join(home, '.claude.json'));
  updateSharedJsonSync<Record<string, unknown>>(path.join(configDir, '.claude.json'), current => {
    const next: Record<string, unknown> = { ...(current ?? {}) };
    next.hasCompletedOnboarding = true;
    // Unreadable: the account keeps what it has rather than losing its servers.
    if (source !== 'unreadable') {
      for (const key of MIRRORED_KEYS) {
        if (source && source[key] !== undefined) next[key] = source[key];
        else delete next[key];
      }
    }
    return next;
  }, { createMode: 0o600 });
}

export function provisionAccountDir(configDir: string, home: string = os.homedir()): ProvisionReport {
  if (!path.isAbsolute(configDir)) throw new Error('An account directory must be an absolute path.');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);

  const conflicts: string[] = [];
  linkShared(configDir, claudeDir, conflicts);
  copySettings(configDir, claudeDir);
  mirrorClaudeJson(configDir, home);
  return { conflicts };
}
