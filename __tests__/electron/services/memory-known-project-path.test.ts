import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Brain lists a Tars project whose memory Claude's folder holds, once, under
 * the project's own path (the reviewer's gate of win/paths-memory-security).
 *
 * MEMORY.md for `/Users/noah/My Project` is created in Claude's folder,
 * `-Users-noah-My-Project`. On macOS the decoder tries `-`, `.` and `_` for a
 * dash, never a space, so it reads that folder back as `/Users/noah/My/Project`:
 * Brain showed a "Project" entry holding the memory, and an empty "My Project"
 * beside it.
 *
 * How it can fail, written before the fix:
 * 1. the memory is listed under the decoder's guess instead of the known path;
 * 2. the known project is listed a second time, empty;
 * 3. a folder no known path names is no longer listed, or listed differently.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mem-known-')));
const fakeHome = path.join(tmp, 'home');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});
// What the POSIX decoder makes of these names on a Mac, where the paths exist.
vi.mock('../../../electron/utils/decode-project-path', () => ({
  decodeProjectPath: (name: string) => ({
    '-Users-noah-My-Project': '/Users/noah/My/Project',
    '-Users-noah-other': '/Users/noah/other',
  } as Record<string, string>)[name] ?? `/${name}`,
}));

const HOST = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: HOST, configurable: true }); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe.each(['darwin', 'linux'] as const)('Brain on %s', (platform) => {
  it('1, 2, 3. lists the known project once, under its own path, with its memory', async () => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.resetModules();
    const projects = path.join(fakeHome, '.claude', 'projects');
    fs.rmSync(projects, { recursive: true, force: true });
    for (const folder of ['-Users-noah-My-Project', '-Users-noah-other']) {
      fs.mkdirSync(path.join(projects, folder, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(projects, folder, 'memory', 'MEMORY.md'), `# ${folder}\n`);
    }
    const { listProjectMemories } = await import('../../../electron/services/memory-service');

    const listed = (await listProjectMemories(['/Users/noah/My Project']))
      .filter(p => p.provider === 'claude' || p.id.startsWith('tars:'))
      .map(p => ({ projectPath: p.projectPath, name: p.projectName, hasMemory: p.hasMemory }));

    expect(listed).toEqual(expect.arrayContaining([
      { projectPath: '/Users/noah/My Project', name: 'My Project', hasMemory: true },
      { projectPath: '/Users/noah/other', name: 'other', hasMemory: true },
    ]));
    expect(listed).toHaveLength(2);
  });
});
