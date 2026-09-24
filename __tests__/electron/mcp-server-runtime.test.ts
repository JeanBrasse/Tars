import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Tars's own MCP servers run on the Node inside the app, not on whatever
 * `node` an agent's shell finds first.
 *
 * Every registration named the program `node`, so the CLI that starts a server
 * looked it up on its PATH. An agent's terminal is `/bin/bash -l`, and on macOS
 * /etc/profile runs path_helper, which puts /etc/paths (/usr/local/bin first)
 * before the PATH Tars hands it. Measured on 2026-09-24: the live Tars's
 * mcp-orchestrator processes ran /usr/local/bin/node, Node 18.16, end of life,
 * though the settings name a Node 22 and nvm has 22 and 24; and
 * `env -i PATH=<nvm 22>:/usr/bin:/bin bash -l -c 'command -v node'` answers
 * /usr/local/bin/node. A machine with no Node at all, which claude's native
 * installer does not need, got no Tars tools in any agent.
 *
 * The program is now a launcher Tars writes at ~/.dorothy/bin/tars-mcp-node at
 * every start: it runs the app's own binary with ELECTRON_RUN_AS_NODE=1.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. The command registered is looked up on a PATH (`node`), so the shell's
 *    first node runs the servers, whatever its version.
 * 2. The launcher depends on PATH itself, or does not pass the arguments on.
 * 3. An app path with a space, a quote or `$(...)` breaks the launcher or is
 *    run by the shell.
 * 4. The launcher is writable by other accounts.
 * 5. The launcher still names the old binary after the app moved; or it is
 *    rewritten at every call although nothing changed.
 * 6. On Windows, where a shell script cannot be the command, nothing runs.
 * 7. A launcher that cannot be written makes the setup throw, and no server is
 *    registered at all.
 * 8. The servers registered by an older Tars with `node` are left as they are,
 *    since the registration check only compares the server's path.
 * 9. Over-correction: once moved over, every server is registered again at
 *    every start (for Claude that is a `claude mcp add` per server).
 * 10. The servers handed to a delegated ACP run still name `node`.
 * 11. A move-over that failed for one registration, or found no server to
 *     move (a start without the bundles), is recorded as done anyway, and the
 *     servers left on `node` are never moved again. Found in the app on this
 *     branch: a dev start, whose resources hold no bundle, wrote the record.
 */

const home = () => os.homedir();

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

/** A provider that keeps its registrations in memory, the way the real ones keep them on disk. */
const registry = new Map<string, { command: string; args: string[] }>();
const calls: string[] = [];
const fakeProvider = {
  id: 'fake',
  isMcpServerRegistered: (name: string, serverPath: string) => registry.get(name)?.args.at(-1) === serverPath,
  registerMcpServer: async (name: string, command: string, args: string[]) => { calls.push(`add ${name}`); registry.set(name, { command, args }); },
  removeMcpServer: async (name: string) => { calls.push(`remove ${name}`); registry.delete(name); },
  getSkillDirectories: () => [] as string[],
  getPtyEnvVars: () => ({}),
};
vi.mock('../../electron/providers', () => ({ getAllProviders: () => [fakeProvider], getProvider: () => fakeProvider }));

let acpLaunch: { command: string; args: string[] };
vi.mock('../../electron/services/acp/registry', () => ({ acpLaunchFor: () => acpLaunch, loadAcpRegistry: async () => undefined }));
vi.mock('../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

import { mcpNodeCommand } from '../../electron/utils/mcp-node';
import { delegateOverAcp } from '../../electron/services/acp/delegate';
import { setupMcpOrchestrator } from '../../electron/services/mcp-orchestrator';

const launcher = () => path.join(home(), '.dorothy', 'bin', 'tars-mcp-node');

/** A program that prints what it was run with, standing in for the app binary. */
function fakeApp(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app');
  fs.writeFileSync(file, `#!${process.execPath}\nconsole.log(JSON.stringify({ runAsNode: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2) }));\n`, { mode: 0o755 });
  return file;
}
const run = (command: string, args: string[]) =>
  JSON.parse(execFileSync(command, args, { env: { PATH: '/nonexistent' } }).toString());

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-node-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('the program Tars runs its MCP servers on', () => {
  it('1, 2. is an absolute launcher that runs the app binary as Node, with no PATH at all', () => {
    const app = fakeApp(path.join(scratch, 'one'));

    const command = mcpNodeCommand(app, 'darwin');

    expect(command).toBe(launcher());
    expect(path.isAbsolute(command)).toBe(true);
    expect(run(command, ['/some/bundle.js', '--flag'])).toEqual({ runAsNode: '1', args: ['/some/bundle.js', '--flag'] });
  });

  it('3. survives an app path with a space, a quote and $(...), and runs none of it', () => {
    const app = fakeApp(path.join(scratch, "My Apps", "it's $(touch pwned)"));

    const command = mcpNodeCommand(app, 'linux');

    expect(run(command, ['x'])).toEqual({ runAsNode: '1', args: ['x'] });
    expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
  });

  it('4. is readable, writable and runnable by its owner alone', () => {
    mcpNodeCommand(fakeApp(path.join(scratch, 'four')), 'darwin');
    expect(fs.statSync(launcher()).mode & 0o777).toBe(0o700);
  });

  it('5. follows the app when it moves, and is not rewritten when it did not', () => {
    const before = fakeApp(path.join(scratch, 'before'));
    const after = fakeApp(path.join(scratch, 'after'));
    mcpNodeCommand(before, 'darwin');
    const first = fs.statSync(launcher());

    mcpNodeCommand(before, 'darwin');
    expect(fs.statSync(launcher()).mtimeMs, 'rewritten with nothing changed').toBe(first.mtimeMs);
    expect(fs.statSync(launcher()).ino).toBe(first.ino);

    mcpNodeCommand(after, 'darwin');
    expect(fs.readFileSync(launcher(), 'utf-8')).toContain(after);
    expect(fs.readFileSync(launcher(), 'utf-8')).not.toContain(before);
  });

  it('6. stays `node` on Windows', () => {
    expect(mcpNodeCommand('C:\\Tars\\Tars.exe', 'win32')).toBe('node');
  });

  it('7. falls back to `node` when the launcher cannot be written', () => {
    const bin = path.dirname(launcher());
    fs.rmSync(bin, { recursive: true, force: true });
    fs.writeFileSync(bin, 'a file where the directory should be');
    try {
      expect(mcpNodeCommand(fakeApp(path.join(scratch, 'seven')), 'darwin')).toBe('node');
    } finally {
      fs.rmSync(bin, { force: true });
    }
  });
});

describe('registering the servers', () => {
  const resources = path.join(scratch, 'resources');
  const bundles = ['mcp-orchestrator', 'mcp-memory', 'mcp-kanban'].map(dir => {
    const file = path.join(resources, dir, 'dist', 'bundle.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  });

  beforeEach(() => {
    (process as unknown as { resourcesPath: string }).resourcesPath = resources;
    registry.clear();
    calls.length = 0;
    fs.rmSync(path.join(home(), '.dorothy', 'mcp-servers-runtime.json'), { force: true });
  });

  it('8. moves the servers an older Tars registered with `node` over to the launcher, once', async () => {
    for (const [i, name] of ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-kanban'].entries()) {
      registry.set(name, { command: 'node', args: [bundles[i]] });
    }

    await setupMcpOrchestrator({} as never);

    for (const name of ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-kanban']) {
      expect(registry.get(name)?.command, name).toBe(launcher());
    }
    expect(calls).toContain('remove claude-mgr-orchestrator');
  });

  it('11. is tried again at the next start when one registration failed, or when there was nothing to move', async () => {
    registry.set('claude-mgr-orchestrator', { command: 'node', args: [bundles[0]] });
    const register = fakeProvider.registerMcpServer;
    fakeProvider.registerMcpServer = async (name, command, args) => {
      if (name === 'claude-mgr-orchestrator') throw new Error('claude is busy');
      return register(name, command, args);
    };
    try {
      await setupMcpOrchestrator({} as never);
    } finally {
      fakeProvider.registerMcpServer = register;
    }

    await setupMcpOrchestrator({} as never);
    expect(registry.get('claude-mgr-orchestrator')?.command).toBe(launcher());

    // A start that finds no bundle records nothing either.
    fs.rmSync(path.join(home(), '.dorothy', 'mcp-servers-runtime.json'), { force: true });
    (process as unknown as { resourcesPath: string }).resourcesPath = path.join(scratch, 'no-resources');
    await setupMcpOrchestrator({} as never);
    expect(fs.existsSync(path.join(home(), '.dorothy', 'mcp-servers-runtime.json'))).toBe(false);
  });

  it('9. registers nothing again at the next start', async () => {
    await setupMcpOrchestrator({} as never);
    expect(registry.get('claude-mgr-orchestrator')?.command).toBe(launcher());
    calls.length = 0;

    await setupMcpOrchestrator({} as never);

    expect(calls).toEqual([]);
  });
});

describe('a delegated run', () => {
  it('10. hands its CLI servers that run on the launcher', async () => {
    const resources = path.join(scratch, 'resources');
    (process as unknown as { resourcesPath: string }).resourcesPath = resources;
    const report = path.join(scratch, 'acp-servers.json');
    const agentScript = path.join(scratch, 'acp-agent.mjs');
    fs.writeFileSync(agentScript, `
import { writeFileSync } from 'node:fs';
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') {
    writeFileSync(${JSON.stringify(report)}, JSON.stringify(msg.params.mcpServers.map(s => ({ name: s.name, command: s.command }))));
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  }
  if (msg.method === 'session/prompt') return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
}
`);
    acpLaunch = { command: process.execPath, args: [agentScript] };

    await delegateOverAcp({
      agent: { id: 'a1', name: 'A', status: 'idle', projectPath: scratch, provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString() } as never,
      task: 'x', appSettings: {} as never, timeoutMs: 20_000,
    });

    const servers = JSON.parse(fs.readFileSync(report, 'utf-8')) as { name: string; command: string }[];
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) expect(server.command, server.name).toBe(launcher());
  });
});
