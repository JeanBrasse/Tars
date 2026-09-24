import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The shell a terminal Tars opens runs, when SHELL is not set (Noah,
 * 2026-09-24: "l'app doit rester compatible linux").
 *
 * How it fails, written before the code (2026-09-24):
 * 1. With SHELL unset on Linux, six launches (the quick terminal, the agent
 *    terminals of main.ts, the CLI path detection, three handlers) fall back to
 *    /bin/zsh, which a Linux install often lacks: the spawn fails.
 * 2. macOS stops getting /bin/zsh, its default since Catalina.
 * 3. A SHELL that is set is not the one used.
 */

const spawned: string[] = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string) => {
    spawned.push(file);
    return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: vi.fn(), kill: vi.fn(), resize: vi.fn(), pid: 1 };
  }),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { defaultShell } from '../../../electron/utils/default-shell';
import { createQuickPty } from '../../../electron/core/pty-manager';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const shellBefore = process.env.SHELL;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (shellBefore === undefined) delete process.env.SHELL; else process.env.SHELL = shellBefore;
});

describe('the shell a terminal runs when SHELL is not set', () => {
  it('1, 2, 3. is /bin/bash off macOS, /bin/zsh on it, and SHELL whenever it is set', () => {
    expect(defaultShell({}, 'linux')).toBe('/bin/bash');
    expect(defaultShell({}, 'darwin')).toBe('/bin/zsh');
    expect(defaultShell({ SHELL: '' }, 'linux')).toBe('/bin/bash');
    expect(defaultShell({ SHELL: '/usr/bin/fish' }, 'linux')).toBe('/usr/bin/fish');
    expect(defaultShell({ SHELL: '/bin/zsh' }, 'darwin')).toBe('/bin/zsh');
  });

  it('1. is what the quick terminal starts on Linux with SHELL unset', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    delete process.env.SHELL;

    createQuickPty('/', 80, 24, null);

    expect(spawned.at(-1)).toBe('/bin/bash');
  });
});
