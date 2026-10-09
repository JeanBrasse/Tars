import * as fs from 'fs';
import * as path from 'path';

/**
 * Claude Code's folder for a project under `~/.claude/projects`, and the way
 * back.
 *
 * Claude Code names the folder after the project's path with every character
 * that is not an ASCII letter or digit turned into `-`. Read on Windows from
 * the folders it wrote (2026-09-25): `C:\Users\me\Documents\Claude
 * Project\Tars` is `C--Users-me-Documents-Claude-Project-Tars` and
 * `C:\Users\me\.buzz` is `C--Users-me--buzz`. On macOS that is `/` and
 * `.` for most paths, which is the rule Tars had written down, and why a path
 * with a space, an underscore or any other character, and every Windows path,
 * was looked for under a name Claude never gives.
 */
export function encodeClaudeProjectDir(projectPath: string): string {
  const name = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_NAME) return name;
  return `${name.slice(0, MAX_NAME)}-${Math.abs(claudeHash(projectPath)).toString(36)}`;
}

/**
 * A name longer than 200 characters is cut to 200 and followed by `-` and a
 * base-36 hash of the whole path: Claude Code 2.1.220's own `x0()`, read in
 * its claude.exe on 2026-09-25 (`ixt=200`, the hash a 32-bit `(h<<5)-h+c`
 * over UTF-16 units). The test holds it to values computed by that code.
 */
const MAX_NAME = 200;

function claudeHash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h;
}

/**
 * The folder names to read a project's transcripts and memory from, Claude's
 * own first, then the two spellings Tars used to read (`/` and `.` to `-`, and
 * `/` alone, as memory-hub tried), so nothing found before is lost.
 *
 * A spelling that is not one folder name is never tried. `/` alone turns `..`
 * into `..`, which is the parent of ~/.claude/projects, where memory-hub
 * writes: a name of dots only is dropped on every platform. On win32 the old
 * spellings of a Windows path also keep `\` and `:`:
 * they name no folder Claude writes, and `C:\p\..\..\x` would walk out.
 * darwin/linux: no spelling holds a `/`, so only the dots are dropped there.
 */
export function claudeProjectDirNames(projectPath: string, platform: NodeJS.Platform = process.platform): string[] {
  const legacy = [projectPath.replace(/[/.]/g, '-'), projectPath.replace(/\//g, '-')];
  const oneFolder = (n: string) => !/^\.+$/.test(n) && !(platform === 'win32' && /[\\/:]/.test(n));
  return [...new Set([encodeClaudeProjectDir(projectPath), ...legacy.filter(oneFolder)])];
}

/**
 * The folder a session's transcript is looked for in (utils/resume-session.ts,
 * which every reader of a transcript goes through). win32: Claude's own name,
 * the only one Claude writes there (the old rule kept a Windows path's `:`
 * and `\`, `C:\Users\x` stayed `C:\Users\x`). darwin/linux: `/` and `.` to
 * `-`, the rule Tars has always read transcripts under there, unchanged.
 */
export function transcriptProjectDirName(projectPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? encodeClaudeProjectDir(projectPath) : projectPath.replace(/[/.]/g, '-');
}

/**
 * The folder Memory gives a Tars project Claude has no folder for yet, where
 * it creates the project's MEMORY.md (memory-service). win32: Claude's own
 * name, the one Claude reads (the old rule kept a Windows path's `:` and `\`).
 * darwin/linux: `/` and `.` to `-`, the rule Memory has always used there,
 * unchanged.
 */
export function memoryProjectDirName(projectPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? encodeClaudeProjectDir(projectPath) : projectPath.replace(/[/.]/g, '-');
}

/**
 * The known projects by the folder names Claude gives them, for a listing that
 * reads each folder back to a path (memory-service). win32: a folder one of
 * them names is that project, whatever the disk makes of it (the decoder
 * cannot tell `a b` from `a-b` when both exist, and the listing showed the
 * project once under the guess and again empty). darwin/linux: none, every
 * folder is decoded as it always was.
 */
export function knownProjectsByFolder(projectPaths: string[], platform: NodeJS.Platform = process.platform): Map<string, string> {
  const byFolder = new Map<string, string>();
  if (platform !== 'win32') return byFolder;
  for (const known of projectPaths) {
    for (const name of known ? claudeProjectDirNames(known, platform) : []) if (!byFolder.has(name)) byFolder.set(name, known);
  }
  return byFolder;
}

export interface DecodeDeps {
  platform?: NodeJS.Platform;
  /** The names in a directory; throws when it cannot be listed. */
  readdir?: (dir: string) => string[];
}

/**
 * The Windows path a Claude folder name stands for, or null when the name is
 * not one (darwin, linux, or a name with no drive: decode-project-path.ts
 * decodes those as it always has).
 *
 * `C--` is the drive's root (`C:\`). After it, each directory is listed once
 * and the entry whose own encoding matches the most words next in the name is
 * taken: a space, a dot, an underscore, an accent, any character Claude turned
 * into `-` is rebuilt from the disk, not guessed. Ties go to an exact-case
 * match, then to the first name in order. Where nothing matches (the project
 * is gone), the words are kept as folders, as the old decoder did.
 */
export function decodeWindowsClaudeProjectDir(dirName: string, deps: DecodeDeps = {}): string | null {
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const drive = /^([A-Za-z])--(.*)$/.exec(dirName);
  if (!drive) return null;
  const readdir = deps.readdir ?? ((dir: string) => fs.readdirSync(dir));
  const words = drive[2] ? drive[2].split('-') : [];

  let resolved = `${drive[1]}:\\`;
  let i = 0;
  while (i < words.length) {
    let names: string[];
    try {
      names = readdir(resolved);
    } catch {
      names = [];
    }
    let best: { name: string; length: number; exact: boolean } | undefined;
    for (const name of [...names].sort()) {
      const own = encodeClaudeProjectDir(name).split('-');
      if (i + own.length > words.length) continue;
      const next = words.slice(i, i + own.length);
      if (!own.every((w, j) => w.toLowerCase() === next[j].toLowerCase())) continue;
      const exact = own.every((w, j) => w === next[j]);
      if (!best || own.length > best.length || (own.length === best.length && exact && !best.exact)) {
        best = { name, length: own.length, exact };
      }
    }
    if (best) {
      resolved = path.win32.join(resolved, best.name);
      i += best.length;
    } else {
      resolved = path.win32.join(resolved, words[i]);
      i += 1;
    }
  }
  return resolved;
}
