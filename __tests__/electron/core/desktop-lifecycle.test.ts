import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Windows app lifecycle, installed on Windows and nowhere else
 * (desktop-lifecycle.ts): one instance, the close to the tray, no menu.
 *
 * How it fails, written before the session-end code (2026-09-26; the rest of
 * the file was already there and the review's mutant, the win32 gate removed
 * from the menu call, survived every test):
 * 1. darwin/linux: the application menu is removed (on macOS that is Cmd+Q,
 *    Cmd+C, Cmd+V and every Edit command), an AppUserModelId is set, the
 *    single-instance lock is taken, or a close, before-quit or session-end
 *    listener is added: any of these changes a Mac or Linux user's app.
 * 2. win32: any of those is missing: the default menu's Ctrl+W still kills
 *    every agent, toasts have no owner, a second launch starts a second Tars,
 *    or a close quits.
 * 3. win32: a close while Tars runs is not turned into a hide; or a close
 *    after before-quit (the tray's Quit Tars, the updater, a test harness)
 *    is still turned into one, and the app never ends.
 * 4. win32, session end: Windows logs off, shuts down or restarts. The window
 *    hides on close, so this is now the usual way Tars ends, and Electron
 *    emits no before-quit then, only the window's `session-end`. The shutdown
 *    steps (flush the bus, save the fleet, end the ACP runs, kill every
 *    terminal) must run there, synchronously, before the handler returns:
 *    Windows ends the process right after. And the closes that follow must
 *    close.
 * 5. The shutdown steps run twice for one session end, or are a second list
 *    beside main.ts's before-quit one, which the next step added there would
 *    miss: by default the session end runs the app's before-quit listeners.
 */

const calls: string[] = [];
const appListeners = new Map<string, (() => void)[]>();

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => { calls.push('requestSingleInstanceLock'); return true; }),
    setAppUserModelId: vi.fn(() => calls.push('setAppUserModelId')),
    on: vi.fn((event: string, fn: () => void) => {
      calls.push(`app.on:${event}`);
      appListeners.set(event, [...(appListeners.get(event) ?? []), fn]);
    }),
    quit: vi.fn(() => calls.push('app.quit')),
    emit: vi.fn((event: string) => {
      calls.push(`app.emit:${event}`);
      for (const fn of appListeners.get(event) ?? []) fn();
      return true;
    }),
  },
  Menu: { setApplicationMenu: vi.fn(() => calls.push('setApplicationMenu')) },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  ipcMain: { handle: vi.fn() },
}));

type Listener = (event?: { preventDefault(): void }) => void;

function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  const win = {
    hidden: 0,
    on: (event: string, fn: Listener) => {
      calls.push(`win.on:${event}`);
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    hide: () => { win.hidden++; },
    isDestroyed: () => false,
    emit: (event: string) => {
      let prevented = false;
      for (const fn of listeners.get(event) ?? []) fn({ preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
  return win;
}

async function load() {
  vi.resetModules();
  return import('../../../electron/core/desktop-lifecycle');
}

const explained = { explained: () => true, markExplained: () => {} };

beforeEach(() => {
  calls.length = 0;
  appListeners.clear();
});

describe('darwin and linux: nothing of the Windows lifecycle', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: no menu change, no AUMID, no lock, no listener`, async () => {
      const { installDesktopShell, claimSingleInstance } = await load();
      const win = fakeWindow();
      const shutdown = vi.fn();
      expect(claimSingleInstance(() => {}, platform)).toBe(true);
      installDesktopShell({
        getMainWindow: () => win as never, explanation: explained, onSessionEnd: shutdown, platform,
      });
      expect(calls).toEqual([]);
      expect(shutdown).not.toHaveBeenCalled();
    });
  }
});

describe('win32', () => {
  it('takes the lock, sets the AUMID, removes the menu, and listens for the end', async () => {
    const { installDesktopShell, claimSingleInstance } = await load();
    const win = fakeWindow();
    expect(claimSingleInstance(() => {}, 'win32')).toBe(true);
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, onSessionEnd: () => {}, platform: 'win32' });
    for (const c of ['requestSingleInstanceLock', 'app.on:second-instance', 'setAppUserModelId', 'setApplicationMenu',
      'app.on:before-quit', 'win.on:close', 'win.on:session-end']) {
      expect(calls, c).toContain(c);
    }
  });

  it('hides on close while Tars runs, closes once before-quit has run', async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, onSessionEnd: () => {}, platform: 'win32' });
    expect(win.emit('close')).toBe(true);
    expect(win.hidden).toBe(1);
    for (const fn of appListeners.get('before-quit') ?? []) fn();
    expect(win.emit('close')).toBe(false);
    expect(win.hidden).toBe(1);
  });

  it('runs the shutdown steps at session end, once, synchronously, and lets the closes through', async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    const shutdown = vi.fn();
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, onSessionEnd: shutdown, platform: 'win32' });
    win.emit('session-end');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(win.emit('close')).toBe(false);
    win.emit('session-end');
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("by default runs the app's own before-quit listeners at session end", async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    const quitSteps = vi.fn();
    appListeners.set('before-quit', [quitSteps]);
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, platform: 'win32' });
    win.emit('session-end');
    expect(calls.filter(c => c === 'app.emit:before-quit')).toHaveLength(1);
    expect(quitSteps).toHaveBeenCalledTimes(1);
    expect(win.emit('close')).toBe(false);
  });
});
