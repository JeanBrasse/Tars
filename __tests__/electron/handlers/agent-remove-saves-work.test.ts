/**
 * The window's Delete saves an agent's uncommitted work before it removes the
 * agent's worktree (Noah, 05/10: "deleting an agent first saves its uncommitted
 * work on wip/<name>, without asking"). agent:remove ran
 * `git worktree remove --force`, and whatever was not committed went with it.
 *
 * How it fails:
 * 1. The worktree goes and its uncommitted work with it: no wip/<name>.
 * 2. A save that fails still removes the worktree, so the work it could not
 *    save is lost all the same.
 * 3. The window is not told where the work went, or that a worktree was kept.
 *
 * The handler and git are the real ones, on a repository in a throwaway folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-remove-saves-${process.pid}-${Date.now()}`,
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
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AgentStatus, AppSettings } from '../../../electron/types';

fs.mkdirSync(tmpHome, { recursive: true });

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

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let repo: string;
let wt: string;

beforeEach(() => {
  repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(tmpHome, 'repo-'))), 'project');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.example');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  wt = path.join(repo, '.worktrees', 'feat-x');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
  agents.set('w1', {
    id: 'w1', name: 'Backend Engineer', status: 'idle', projectPath: repo, worktreePath: wt, branchName: 'feat/x',
    skills: [], output: [], lastActivity: '',
  } as unknown as AgentStatus);
});

afterEach(() => {
  agents.clear();
});

describe('the window\'s Delete', () => {
  it('1, 3. saves the uncommitted work on wip/<name>, removes the worktree, and says where the work went', async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'fresh\n');

    const result = await handlers.get('agent:remove')!({}, 'w1');

    expect(result).toEqual({ success: true, savedTo: 'wip/backend-engineer' });
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'show', 'wip/backend-engineer:a.txt')).toBe('one\ntwo');
    expect(git(repo, 'show', 'wip/backend-engineer:new.txt')).toBe('fresh');
    expect(agents.has('w1')).toBe(false);
  });

  it('removes a clean worktree and makes no branch', async () => {
    expect(await handlers.get('agent:remove')!({}, 'w1')).toEqual({ success: true });
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'wip/*')).toBe('');
  });

  it('2, 3. keeps the worktree when the work cannot be saved, and says why', async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'kept\n');
    const objects = path.join(repo, '.git', 'objects');
    fs.chmodSync(objects, 0o555);
    let result: unknown;
    try {
      result = await handlers.get('agent:remove')!({}, 'w1');
    } finally {
      fs.chmodSync(objects, 0o755);
    }
    expect(result).toMatchObject({ success: true, worktreeKept: expect.stringContaining(wt) });
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('kept\n');
    expect(agents.has('w1')).toBe(false);
  });
});
