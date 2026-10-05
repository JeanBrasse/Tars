/**
 * The window's side of the folders no agent owns (Noah's choice 16; the frames
 * of #315): system:disk, system:orphanFolders, system:removeOrphanFolders and
 * the progress event, through the real handlers.
 *
 * How it fails, written before the code (2026-10-06):
 * 1. The projects are not Tars's own (projects.json and its agents' projects),
 *    or an agent's worktree is offered for removal.
 * 2. The removal asks nothing of the window but is not told to it as it goes
 *    (no progress event), or answers without what was kept and why.
 * 3. The calls are not in the preload, or the renderer has no type for them.
 * 4. The disk is not the home's.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const { tmpHome, pushed } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-orphans-ipc-${process.pid}-${Date.now()}`,
  pushed: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AgentStatus, AppSettings } from '../../../electron/types';

fs.mkdirSync(path.join(tmpHome, '.dorothy'), { recursive: true });
function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings) };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}
registerIpcHandlers(deps());

const ROOT = path.join(__dirname, '../../..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function project(name: string): string {
  const p = path.join(fs.realpathSync(tmpHome), 'projects', name);
  fs.mkdirSync(p, { recursive: true });
  git(p, 'init', '-q', '-b', 'main');
  return p;
}

describe("the window's calls", () => {
  it("1, 2. list and remove the orphans of Tars's projects, never an agent's worktree, telling each step", async () => {
    const added = project('added');
    const agentsOnly = project('agents-only');
    fs.writeFileSync(path.join(tmpHome, '.dorothy', 'projects.json'), JSON.stringify([added]));
    fs.mkdirSync(path.join(added, '.worktrees', 'old-one'), { recursive: true });
    fs.writeFileSync(path.join(added, '.worktrees', 'old-one', 'x.txt'), 'x');
    fs.mkdirSync(path.join(agentsOnly, '.worktrees', 'stale'), { recursive: true });
    const owned = path.join(agentsOnly, '.worktrees', 'agent-wt');
    fs.mkdirSync(owned, { recursive: true });
    agents.set('a1', { id: 'a1', name: 'A', status: 'idle', projectPath: agentsOnly, worktreePath: owned, skills: [], output: [] } as unknown as AgentStatus);

    const listing = await handlers.get('system:orphanFolders')!({}) as { folders: Array<{ path: string }>; count: number };
    expect(listing.folders.map(f => f.path).sort()).toEqual([
      path.join(added, '.worktrees', 'old-one'), path.join(agentsOnly, '.worktrees', 'stale'),
    ].sort());

    const report = await handlers.get('system:removeOrphanFolders')!({}) as { removed: number; kept: unknown[] };
    expect(report.removed).toBe(2);
    expect(report.kept).toEqual([]);
    expect(fs.existsSync(owned)).toBe(true);
    const steps = pushed.filter(p => p.channel === 'system:orphanFolders:progress').map(p => p.payload as { done: number; total: number });
    expect(steps.map(s => [s.done, s.total])).toEqual([[1, 2], [2, 2]]);
  });

  it("4. the disk is the home's, with the 30 GB floor", async () => {
    const disk = await handlers.get('system:disk')!({}) as { freeBytes: number; totalBytes: number; floorBytes: number };
    const s = fs.statfsSync(tmpHome);
    expect(disk.totalBytes).toBe(s.blocks * s.bsize);
    expect(disk.floorBytes).toBe(30 * 1024 ** 3);
  });

  it('3. the calls are in the preload, and typed for the renderer, together', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8');
    const types = fs.readFileSync(path.join(ROOT, 'src/types/electron.d.ts'), 'utf8');
    for (const channel of ['system:disk', 'system:orphanFolders', 'system:removeOrphanFolders']) {
      expect(preload).toContain(`ipcRenderer.invoke('${channel}')`);
    }
    expect(preload).toContain("'system:orphanFolders:progress'");
    for (const name of ['disk: () => Promise<DiskSpace | null>', 'orphanFolders: () => Promise<OrphanListing>',
      'removeOrphanFolders: () => Promise<OrphanRemovalReport | { error: string }>',
      'onOrphanRemovalProgress: (callback: (progress: OrphanRemovalProgress) => void) => () => void']) {
      expect(types).toContain(name);
    }
  });
});
