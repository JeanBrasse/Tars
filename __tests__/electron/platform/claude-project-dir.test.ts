import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  encodeClaudeProjectDir, claudeProjectDirNames, decodeWindowsClaudeProjectDir,
} from '../../../electron/platform';
import { POSIX_CORPUS } from './posix-corpus';
import golden from './posix-golden.json';

/**
 * Claude Code's folder for a project under `~/.claude/projects` (audit B H-01
 * to H-05), and the way back from the folder to the project.
 *
 * Claude Code turns every character of the path that is not an ASCII letter or
 * digit into `-`. Tars assumed `/` and `.` only, which is the same thing for
 * most macOS paths and nothing like it on Windows: `C:\Users\x\proj` stayed
 * `C:\Users\x\proj`, so a transcript was looked for at
 * `...\.claude\projects\C:\Users\x\proj\<id>.jsonl`, every restart started a new
 * conversation, and Memory could not create a MEMORY.md. The decoder started at
 * `/`, never produced a drive and never a space: `C--Users-nicol-Documents-
 * Claude-Project-Tars` came back as `\C\Users\nicol\Documents\Claude\Project\Tars`,
 * and fs:list-projects dropped every project Claude had seen.
 *
 * How it can fail, written before the code:
 * 1. the encoder is not Claude Code's: checked against folder names Claude Code
 *    wrote on this machine (C:\Users\nicol\.claude\projects, read 2026-09-25,
 *    names only, for paths that exist);
 * 2. darwin/linux read a folder the old code did not, or stop reading one it
 *    did: the legacy `[/.]` spelling and the `/`-only one memory-hub tried stay
 *    readable, after Claude's own;
 * 3. win32 offers a legacy spelling, which holds `:` and `\` and names no folder;
 * 4. the decoder does not rebuild the drive root `X:\`;
 * 5. a space, a dot, an underscore, an accent or any other character Claude
 *    turned into `-` is not rebuilt from the disk (only `-`, `.`, `_` were tried);
 * 6. a longer name loses to a shorter one that also exists (`a b` and `a\b`);
 * 7. case: Claude keeps the case the cwd was typed in, NTFS ignores it;
 * 8. a folder whose project is gone throws, or returns a drive-less path;
 * 9. darwin/linux, and any name that is not drive-shaped, are decoded the
 *    old way (null here, decode-project-path.ts carries on);
 * 10. an unreadable directory throws instead of ending the match.
 */

describe('1. the encoder is Claude Code\'s', () => {
  it('gives the names Claude Code wrote on this machine', () => {
    const seen: Array<[string, string]> = [
      ['C:\\Users\\nicol\\Documents\\Claude Project\\Tars', 'C--Users-nicol-Documents-Claude-Project-Tars'],
      ['C:\\Users\\nicol\\.buzz', 'C--Users-nicol--buzz'],
      ['C:\\Users\\nicol\\Documents\\Claude Project\\Monarq\\Monarq', 'C--Users-nicol-Documents-Claude-Project-Monarq-Monarq'],
      ['C:\\Users\\nicol', 'C--Users-nicol'],
    ];
    for (const [project, folder] of seen) expect(encodeClaudeProjectDir(project)).toBe(folder);
  });

  it('turns every other character into a dash, on any platform', () => {
    expect(encodeClaudeProjectDir('/Users/noah/docs.octav.fi')).toBe('-Users-noah-docs-octav-fi');
    expect(encodeClaudeProjectDir('/Users/noah/my_proj (2)@x+y')).toBe('-Users-noah-my-proj--2--x-y');
    expect(encodeClaudeProjectDir('C:\\Users\\Nicolás\\projet')).toBe('C--Users-Nicol-s-projet');
  });

  // Claude Code 2.1.220 (claude.exe, read 2026-09-25): a name longer than 200
  // characters is cut to 200 and followed by `-` and a base-36 hash of the whole
  // path. The suffixes below were computed by running Claude Code's own encoder,
  // extracted from that binary, on these inputs; they are not this code's output.
  it('shortens a name over 200 characters exactly as Claude Code does', () => {
    const vectors: Array<[string, string]> = [
      ['C:\\Users\\nicol\\' + 'Documents\\Claude Project\\'.repeat(8) + 'Tars', '-475b7m'],
      ['/Users/noah/' + 'a'.repeat(188), ''],
      ['/Users/noah/' + 'a'.repeat(189), '-fo84kw'],
      ['/' + 'x/'.repeat(100) + 'R\u00e9union (2) \u00e9', '-u8lp63'],
    ];
    for (const [input, suffix] of vectors) {
      expect(encodeClaudeProjectDir(input), input.slice(0, 40)).toBe(input.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200) + suffix);
    }
  });

  it('agrees with the old one wherever the old one was right: letters, digits, "/", "." and "-"', () => {
    for (const [p, old] of Object.entries(golden.encode)) {
      if (/^[A-Za-z0-9/.-]*$/.test(p)) expect(encodeClaudeProjectDir(p), p).toBe(old);
    }
  });
});

describe('2, 3. the folder names to read, Claude\'s first', () => {
  it('darwin/linux: Claude\'s, then the two spellings Tars used to read', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(claudeProjectDirNames('/Users/noah/my_proj.v2', platform))
        .toEqual(['-Users-noah-my-proj-v2', '-Users-noah-my_proj-v2', '-Users-noah-my_proj.v2']);
      expect(claudeProjectDirNames('/Users/noah/tars', platform)).toEqual(['-Users-noah-tars']);
      for (const p of POSIX_CORPUS.paths) {
        expect(claudeProjectDirNames(p, platform), p).toContain(golden.encode[p as keyof typeof golden.encode]);
      }
    }
  });

  // The reviewer's gate: on darwin/linux `project_path: ".."` gave the old spelling `..`,
  // and memory-hub wrote into ~/.claude/memory. A name of dots only is never a folder to try.
  it('darwin/linux: never a spelling made of dots only', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(claudeProjectDirNames('..', platform)).toEqual(['--']);
      expect(claudeProjectDirNames('.', platform)).toEqual(['-']);
      expect(claudeProjectDirNames('...', platform)).toEqual(['---']);
      for (const name of claudeProjectDirNames('/a/../b', platform)) expect(name).not.toMatch(/^\.+$/);
    }
  });

  it('win32: Claude\'s alone', () => {
    expect(claudeProjectDirNames('C:\\Users\\x\\my_proj.v2', 'win32')).toEqual(['C--Users-x-my-proj-v2']);
  });

  // Found by the full suite (memory-webhook-routes, "legacy dot-preserving encodings"):
  // dropping the old spellings on win32 lost them for a POSIX-shaped path too.
  it('win32: the old spellings too when each is one folder name, never one that walks out of the folder', () => {
    expect(claudeProjectDirNames('/Users/test/docs.site', 'win32')).toEqual(['-Users-test-docs-site', '-Users-test-docs.site']);
    for (const hostile of ['C:\\p\\..\\..\\Windows', 'C:/p/../../Windows', '..\\..\\x', 'C:x', '..', '.']) {
      expect(claudeProjectDirNames(hostile, 'win32'), hostile).toEqual([encodeClaudeProjectDir(hostile)]);
    }
  });
});

/** A win32 disk: directory -> its entries, keys in lower case. */
function fakeDisk(dirs: string[]) {
  const tree = new Map<string, Set<string>>();
  for (const full of dirs) {
    const parts = full.split('\\');
    let cur = `${parts[0]}\\`;
    for (const part of parts.slice(1).filter(Boolean)) {
      const key = cur.toLowerCase();
      if (!tree.has(key)) tree.set(key, new Set());
      tree.get(key)!.add(part);
      cur = path.win32.join(cur, part);
    }
  }
  const listed: string[] = [];
  const readdir = (dir: string): string[] => {
    listed.push(dir);
    const entries = tree.get(dir.toLowerCase());
    if (!entries) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    return [...entries];
  };
  return { readdir, listed };
}

describe('the decoder on win32 (an injected disk, so it runs on any host)', () => {
  const decode = (name: string, dirs: string[]) => decodeWindowsClaudeProjectDir(name, { platform: 'win32', readdir: fakeDisk(dirs).readdir });

  it('4, 5. rebuilds the drive and every character Claude turned into a dash', () => {
    const disk = [
      'C:\\Users\\nicol\\Documents\\Claude Project\\Tars',
      'C:\\Users\\nicol\\.buzz',
      'D:\\Unreal Projects\\the_black.sea',
      'C:\\Users\\nicol\\Téléchargements\\a+b (2)',
    ];
    expect(decode('C--Users-nicol-Documents-Claude-Project-Tars', disk)).toBe('C:\\Users\\nicol\\Documents\\Claude Project\\Tars');
    expect(decode('C--Users-nicol--buzz', disk)).toBe('C:\\Users\\nicol\\.buzz');
    expect(decode('D--Unreal-Projects-the-black-sea', disk)).toBe('D:\\Unreal Projects\\the_black.sea');
    expect(decode('C--Users-nicol-T-l-chargements-a-b--2-', disk)).toBe('C:\\Users\\nicol\\Téléchargements\\a+b (2)');
    expect(decode('C--', disk)).toBe('C:\\');
  });

  it('6. the longest name that exists wins', () => {
    const disk = ['C:\\w\\a b\\c', 'C:\\w\\a\\b\\c'];
    expect(decode('C--w-a-b-c', disk)).toBe('C:\\w\\a b\\c');
  });

  it('7. matches without case, and keeps the disk\'s own spelling', () => {
    expect(decode('c--users-nicol-proj', ['C:\\Users\\Nicol\\Proj'])).toBe('c:\\Users\\Nicol\\Proj');
  });

  it('8, 10. a project that is gone keeps its drive and its raw words, without throwing', () => {
    expect(decode('C--Users-nicol-gone-away', ['C:\\Users\\nicol'])).toBe('C:\\Users\\nicol\\gone\\away');
    expect(decode('Z--nothing-here', [])).toBe('Z:\\nothing\\here');
  });

  it('9. is not the decoder for darwin, linux, or a name with no drive', () => {
    const disk = ['C:\\Users\\nicol'];
    expect(decodeWindowsClaudeProjectDir('C--Users-nicol', { platform: 'darwin', readdir: fakeDisk(disk).readdir })).toBeNull();
    expect(decodeWindowsClaudeProjectDir('C--Users-nicol', { platform: 'linux', readdir: fakeDisk(disk).readdir })).toBeNull();
    for (const name of ['-Users-noah-tars', '--srv-share-p', 'CD--x', '', '-']) {
      expect(decodeWindowsClaudeProjectDir(name, { platform: 'win32', readdir: fakeDisk(disk).readdir }), name).toBeNull();
    }
  });

  it('lists each directory once per level, not once per guess', () => {
    const { readdir, listed } = fakeDisk(['C:\\Users\\nicol\\Documents\\Claude Project\\Tars']);
    decodeWindowsClaudeProjectDir('C--Users-nicol-Documents-Claude-Project-Tars', { platform: 'win32', readdir });
    expect(listed).toHaveLength(5);
  });
});

describe('the decoder on this disk (win32 only)', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it.runIf(process.platform === 'win32')('finds a project with spaces, dots, underscores and accents', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-decode-')));
    made.push(root);
    const project = path.join(root, 'Claude Project', 'my_app.v2', 'Réunion (x)');
    fs.mkdirSync(project, { recursive: true });
    expect(decodeWindowsClaudeProjectDir(encodeClaudeProjectDir(project))).toBe(project);
  });
});
