import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * The files Tars shares with other programs are never seen half-written.
 *
 * `~/.claude.json` is read and rewritten by every live Claude Code, Claude's
 * `settings.json` is read by every claude binary, and `kanban-tasks.json` is
 * written whole by Tars and by mcp-kanban from every agent that uses the board.
 * All three were rewritten in place, so a reader that opened one mid-write got
 * a truncated JSON document; both kanban writers read that as an empty board,
 * and their next save wrote it.
 *
 * Every case runs the real writer and cuts into its writeFileSync: halfway
 * through, a reader parses the file, or the process dies. HOME is the
 * throwaway one the suite runs in.
 */

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { ensureProjectTrusted } from '../../electron/core/agent-manager';
import { registerIpcHandlers, type IpcHandlerDependencies } from '../../electron/handlers/ipc-handlers';
import { registerKanbanHandlers, type KanbanHandlerDependencies } from '../../electron/handlers/kanban-handlers';
import { KANBAN_FILE } from '../../electron/constants';
import * as mcpKanban from '../../mcp-kanban/src/store';

const nodeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
const home = () => os.homedir();
const claudeJson = () => path.join(home(), '.claude.json');
const claudeSettings = () => path.join(home(), '.claude', 'settings.json');

/** Whether `file` is under `dir`, by the path given or the real one: temp dirs are /var here and /private/var once resolved. */
function under(dir: string, file: string): boolean {
  return file.startsWith(dir) || file.startsWith(fs.realpathSync(dir));
}

/**
 * Cuts into every write under `dir`: writes the first half, runs `midway` with
 * the path being written, then dies there or finishes. Returns the undo.
 */
function cutWrites(dir: string, midway: (file: string) => void, { die = false } = {}): () => void {
  const original = nodeFs.writeFileSync;
  nodeFs.writeFileSync = function (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) {
    if (typeof file === 'string' && under(dir, file) && typeof data === 'string') {
      original.call(nodeFs, file, data.slice(0, Math.floor(data.length / 2)), options);
      midway(file);
      if (die) throw new Error('the process died here');
    }
    return original.call(nodeFs, file, data, options);
  } as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  return () => {
    nodeFs.writeFileSync = original;
    syncBuiltinESMExports();
  };
}

/** What a reader gets from the file right now: its JSON, or the reason it has none. */
function readAsJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }
}

/** Every write and rename that reaches a file under `dir`, while `during` runs. */
async function writesUnder(dir: string, during: () => unknown): Promise<string[]> {
  const seen: string[] = [];
  const originalWrite = nodeFs.writeFileSync;
  const originalRename = nodeFs.renameSync;
  nodeFs.writeFileSync = function (...args: Parameters<typeof fs.writeFileSync>) {
    if (under(dir, String(args[0]))) seen.push(`write ${args[0]}`);
    return originalWrite.apply(nodeFs, args);
  } as typeof fs.writeFileSync;
  nodeFs.renameSync = function (...args: Parameters<typeof fs.renameSync>) {
    if (under(dir, String(args[1]))) seen.push(`rename to ${args[1]}`);
    return originalRename.apply(nodeFs, args);
  } as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    await during();
  } finally {
    nodeFs.writeFileSync = originalWrite;
    nodeFs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  return seen;
}

const leftovers = (dir: string) => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));

beforeEach(() => {
  fs.rmSync(claudeJson(), { force: true });
  fs.rmSync(path.join(home(), '.claude'), { recursive: true, force: true });
  fs.rmSync(path.dirname(KANBAN_FILE), { recursive: true, force: true });
});

describe('~/.claude.json, through ensureProjectTrusted', () => {
  /** A config the way Claude Code keeps it: an account, some projects, 0600. */
  function claudeConfig() {
    const config = {
      numStartups: 41,
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`/work/project-${i}`, { hasTrustDialogAccepted: true, history: ['x'.repeat(200)] }])),
    };
    fs.writeFileSync(claudeJson(), JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(claudeJson(), 0o600);
    return config;
  }

  it('leaves the previous file whole when the write dies halfway', () => {
    const before = claudeConfig();
    const undo = cutWrites(home(), () => {}, { die: true });
    try {
      ensureProjectTrusted('/work/new-project');
    } finally {
      undo();
    }

    expect(readAsJson(claudeJson())).toEqual(before);
    expect(leftovers(home())).toEqual([]);
  });

  it('never shows a reader a partial file while it writes', () => {
    claudeConfig();
    const seenMidway: unknown[] = [];
    const undo = cutWrites(home(), () => seenMidway.push(readAsJson(claudeJson())));
    try {
      ensureProjectTrusted('/work/new-project');
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toMatchObject({ numStartups: 41 });
    expect(readAsJson(claudeJson())).toMatchObject({ projects: { '/work/new-project': { hasTrustDialogAccepted: true } } });
  });

  it('writes nothing when the project is already trusted', async () => {
    claudeConfig();
    const before = fs.statSync(claudeJson());

    const writes = await writesUnder(home(), () => ensureProjectTrusted('/work/project-3'));

    expect(writes).toEqual([]);
    expect(fs.statSync(claudeJson()).mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps the file readable by its owner only', () => {
    claudeConfig();

    ensureProjectTrusted('/work/new-project');

    expect(fs.statSync(claudeJson()).mode & 0o777).toBe(0o600);
  });

  it('keeps a change Claude made between the read and the rename', () => {
    claudeConfig();
    let claudeWrote = false;
    const undo = cutWrites(home(), file => {
      if (claudeWrote || file === claudeJson() || file === fs.realpathSync(claudeJson())) return;
      claudeWrote = true;
      // Claude Code saving its own counter while Tars prepares its file.
      const current = JSON.parse(fs.readFileSync(claudeJson(), 'utf-8'));
      fs.writeFileSync(`${claudeJson()}.claude`, JSON.stringify({ ...current, numStartups: 42 }, null, 2), { mode: 0o600 });
      fs.renameSync(`${claudeJson()}.claude`, claudeJson());
    });
    try {
      ensureProjectTrusted('/work/new-project');
    } finally {
      undo();
    }

    expect(claudeWrote).toBe(true);
    expect(readAsJson(claudeJson())).toMatchObject({
      numStartups: 42,
      projects: { '/work/new-project': { hasTrustDialogAccepted: true } },
    });
  });

  it('updates the file a link points at, and leaves the link a link', () => {
    const dotfiles = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-dotfiles-'));
    fs.writeFileSync(path.join(dotfiles, 'claude.json'), JSON.stringify({ projects: {} }), { mode: 0o600 });
    fs.symlinkSync(path.join(dotfiles, 'claude.json'), claudeJson());

    ensureProjectTrusted('/work/new-project');

    expect(fs.lstatSync(claudeJson()).isSymbolicLink()).toBe(true);
    expect(readAsJson(path.join(dotfiles, 'claude.json'))).toMatchObject({ projects: { '/work/new-project': { hasTrustDialogAccepted: true } } });
  });

  it('leaves a file that is not JSON exactly as it is', () => {
    fs.writeFileSync(claudeJson(), '{"projects": {"/work/a": ', { mode: 0o600 });

    ensureProjectTrusted('/work/new-project');

    expect(fs.readFileSync(claudeJson(), 'utf-8')).toBe('{"projects": {"/work/a": ');
  });
});

describe("Claude's settings.json, through settings:save", () => {
  function deps(): IpcHandlerDependencies {
    return new Proxy({} as Record<string, unknown>, {
      get(target, key: string) {
        if (!(key in target)) target[key] = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : vi.fn();
        return target[key];
      },
    }) as unknown as IpcHandlerDependencies;
  }
  const save = (settings: Record<string, unknown>) => handlers.get('settings:save')!({}, settings) as Promise<{ success: boolean }>;
  const settingsNow = { env: { A: '1' }, hooks: { Stop: [{ command: 'on-stop.sh' }] }, permissions: { allow: ['Bash(git:*)'], deny: [] } };

  beforeEach(() => {
    handlers.clear();
    registerIpcHandlers(deps());
    fs.mkdirSync(path.dirname(claudeSettings()), { recursive: true });
    fs.writeFileSync(claudeSettings(), JSON.stringify(settingsNow, null, 2));
  });

  it('leaves the previous file whole when the write dies halfway', async () => {
    const undo = cutWrites(path.dirname(claudeSettings()), () => {}, { die: true });
    try {
      await save({ env: { A: '2' } });
    } finally {
      undo();
    }

    expect(readAsJson(claudeSettings())).toEqual(settingsNow);
    expect(leftovers(path.dirname(claudeSettings()))).toEqual([]);
  });

  it('never shows a reader a partial file while it writes', async () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(claudeSettings()), () => seenMidway.push(readAsJson(claudeSettings())));
    try {
      expect(await save({ env: { A: '2' } })).toMatchObject({ success: true });
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(settingsNow);
    expect(readAsJson(claudeSettings())).toMatchObject({ env: { A: '2' }, hooks: settingsNow.hooks });
  });

  it('writes nothing when the save changes nothing', async () => {
    const writes = await writesUnder(path.dirname(claudeSettings()), () =>
      save({ env: { A: '1' }, permissions: { allow: ['Bash(git:*)'], deny: [] } }));

    expect(writes).toEqual([]);
  });
});

describe('kanban-tasks.json, written by Tars and by mcp-kanban', () => {
  const board = [{ id: 't1', title: 'keep me', column: 'backlog', order: 0 }, { id: 't2', title: 'and me', column: 'done', order: 0 }];

  function kanbanDeps(): KanbanHandlerDependencies {
    return {
      getMainWindow: () => null,
      findMatchingAgent: vi.fn(async () => null),
      createAgentForTask: vi.fn(async () => 'agent'),
      startAgent: vi.fn(async () => undefined),
      stopAgent: vi.fn(async () => undefined),
      deleteAgent: vi.fn(async () => undefined),
      getAgentOutput: vi.fn(() => []),
    };
  }

  beforeEach(() => {
    handlers.clear();
    registerKanbanHandlers(kanbanDeps());
    fs.mkdirSync(path.dirname(KANBAN_FILE), { recursive: true });
    fs.writeFileSync(KANBAN_FILE, JSON.stringify(board, null, 2));
  });

  const create = () => handlers.get('kanban:create')!({}, {
    title: 'a new task', description: '', projectId: 'p', projectPath: '/work/p', requiredSkills: [], priority: 'low', labels: [],
  });

  it('Tars never shows the board half-written to a reader, mcp-kanban included', async () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(KANBAN_FILE), () => {
      seenMidway.push(readAsJson(KANBAN_FILE));
      seenMidway.push(mcpKanban.loadTasks());
    });
    try {
      await create();
    } finally {
      undo();
    }

    expect(seenMidway.length).toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(board);
  });

  it('Tars leaves the board whole when its write dies halfway', async () => {
    const undo = cutWrites(path.dirname(KANBAN_FILE), () => {}, { die: true });
    try {
      await create();
    } finally {
      undo();
    }

    expect(readAsJson(KANBAN_FILE)).toEqual(board);
  });

  it('mcp-kanban never shows the board half-written to a reader, Tars included', () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(KANBAN_FILE), () => seenMidway.push(readAsJson(KANBAN_FILE)));
    try {
      mcpKanban.saveTasks([...board, { id: 't3', title: 'from an agent', column: 'ongoing', order: 0 }] as never);
    } finally {
      undo();
    }

    expect(seenMidway.length).toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(board);
    expect((readAsJson(KANBAN_FILE) as unknown[]).length).toBe(3);
  });

  it('mcp-kanban leaves the board whole when its write dies halfway, and no temp file behind', () => {
    const undo = cutWrites(path.dirname(KANBAN_FILE), () => {}, { die: true });
    try {
      expect(() => mcpKanban.saveTasks([] as never)).toThrow('the process died here');
    } finally {
      undo();
    }

    expect(readAsJson(KANBAN_FILE)).toEqual(board);
    expect(leftovers(path.dirname(KANBAN_FILE))).toEqual([]);
  });
});
