import { test, expect, _electron as electron, type CDPSession } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, seedSandbox } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The wheel over a terminal never types into the program running in it.
 *
 * xterm 5.3 turns wheel travel over a buffer with no history, which is the
 * alternate screen every full-screen CLI holds, into arrow keys sent through
 * onData like a keystroke. At Claude Code's prompt an arrow walks back through
 * the messages already sent, so scrolling up to reread a conversation put an old
 * message in the box, one Enter away from going out again. `stopWheelTyping`
 * stops the wheel before xterm sees it.
 *
 * Driven through the real app because the conversion needs real layout: xterm
 * divides pixel deltas by the row height it measured, and with no layout there
 * is no row height, so a test without one sees no arrows whether the fix is
 * there or not. What runs in the terminal is a recorder: every byte it receives
 * lands in a file, one letter typed at it changes the mode it holds, and the
 * test takes the guard away at the end to watch the arrows arrive, which is what
 * makes every "nothing was sent" above it mean something.
 *
 * The terminal is the Projects page's shell, `Terminal.tsx`: a login zsh in the
 * sandbox's HOME, whose .zshrc hands the terminal to the recorder.
 */


/**
 * Raw mode, no echo, every byte appended to the log. `n` leaves for the main
 * buffer with four hundred lines of history, `a` goes back to the alternate
 * screen, `k` and `K` turn application cursor keys on and off.
 */
const RECORDER = `#!${process.execPath}
const fs = require('fs');
const log = process.env.TARS_TERMINAL_LOG;
const say = text => process.stdout.write(text);
process.stdin.setRawMode(true);
process.stdin.resume();
say('\\x1b[?1049h\\x1b[2J\\x1b[Hthe recorder holds the alternate screen\\r\\n');
process.stdin.on('data', chunk => {
  fs.appendFileSync(log, chunk);
  const letter = chunk.toString('latin1');
  if (letter === 'n') {
    say('\\x1b[?1049l');
    for (let i = 1; i <= 400; i++) say('history line ' + i + '\\r\\n');
    say('the recorder is in the main buffer\\r\\n');
  } else if (letter === 'a') {
    say('\\x1b[?1049h\\x1b[2J\\x1b[Hthe recorder holds the alternate screen again\\r\\n');
  } else if (letter === 'k') {
    say('\\x1b[?1happlication cursor keys on\\r\\n');
  } else if (letter === 'K') {
    say('\\x1b[?1lapplication cursor keys off\\r\\n');
  }
});
`;

/** Only the interactive shell of a terminal: a zsh started without a tty reads no .zshrc anyway. */
const ZSHRC = `if [[ -o interactive && -t 0 && -n "$TARS_TERMINAL_RECORDER" ]]; then
  exec "$TARS_TERMINAL_RECORDER"
fi
`;

/** One notch of a mouse wheel, as Chromium reports it. */
const NOTCH = 100;

/**
 * A trackpad swipe: the finger speeding up and slowing down, then the inertia
 * macOS keeps sending after it lifts, in fractions of a pixel. xterm adds these
 * up until they make a line.
 */
const SWIPE = [1.5, 4, 9, 15, 19, 17, 13, 10, 7.5, 5.5, 4, 3, 2.2, 1.6, 1.1, 0.8, 0.5, 0.3, 0.2, 0.1];

const ARROWS = /^(\x1b\[A)+$/;
const APPLICATION_ARROWS = /^(\x1bOA)+$/;

test('the wheel types nothing into a full-screen program, and the keys still do', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-wheel-'));
  seedSandbox(home);
  // Nothing else starts: the recorder is the only program in a terminal.
  fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false }, null, 2));
  // The app keeps the folders added by hand as a list of paths and drops any
  // entry that is not a string, so the objects the shared seed writes there
  // leave the Projects page empty. This sandbox lists its project the way the
  // app writes it.
  const project = path.join(home, 'projects', 'tars');
  fs.writeFileSync(path.join(home, '.dorothy', 'projects.json'), JSON.stringify([project], null, 2));
  const recorder = path.join(home, 'recorder.cjs');
  fs.writeFileSync(recorder, RECORDER, { mode: 0o755 });
  const log = path.join(home, 'received.bin');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(home, '.zshrc'), ZSHRC);

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: apiPort(31493),
      DOROTHY_E2E: '1',
      SHELL: '/bin/zsh',
      TARS_TERMINAL_RECORDER: recorder,
      TARS_TERMINAL_LOG: log,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });

    await page.locator(`p[title="${project}"]`)
      .locator('xpath=ancestor::div[.//button[normalize-space()="open"]][1]')
      .getByRole('button', { name: 'open', exact: true })
      .click({ timeout: 20_000 });
    await page.getByTitle('Open a terminal in this folder').click();

    const rows = page.locator('.xterm-rows');
    await expect(rows).toContainText('the recorder holds the alternate screen', { timeout: 20_000 });
    await page.locator('.xterm').click();
    const box = (await page.locator('.xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const said = (phase: string, bytes: string) => {
      console.log(`WHEEL ${phase}: ${Buffer.byteLength(bytes, 'latin1')} bytes ${JSON.stringify(bytes.slice(0, 24))}`);
      return bytes;
    };
    const sent = async (phase: string, gesture: () => Promise<void>) => {
      const before = fs.statSync(log).size;
      await gesture();
      // Long enough for a byte to cross IPC and the pty: the arrows at the end
      // of this test arrive well inside it.
      await page.waitForTimeout(800);
      return said(phase, fs.readFileSync(log).subarray(before).toString('latin1'));
    };
    const wheel = (direction: 1 | -1) => async () => {
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, direction * NOTCH);
        await page.waitForTimeout(40);
      }
    };
    const swipe = (direction: 1 | -1) => async () => {
      for (const delta of SWIPE) {
        await page.mouse.wheel(0, direction * delta);
        await page.waitForTimeout(16);
      }
    };
    const press = (key: string) => async () => { await page.keyboard.press(key); };
    const mode = async (letter: string, shows: string) => {
      await page.keyboard.type(letter);
      await expect(rows).toContainText(shows, { timeout: 10_000 });
    };

    // The alternate screen: no wheel types, every key still does.
    expect(await sent('alternate, six notches up', wheel(-1))).toBe('');
    expect(await sent('alternate, six notches down', wheel(1))).toBe('');
    expect(await sent('alternate, trackpad swipe up with inertia', swipe(-1))).toBe('');
    expect(await sent('alternate, trackpad swipe down with inertia', swipe(1))).toBe('');
    expect(await sent('alternate, ArrowUp', press('ArrowUp'))).toBe('\x1b[A');
    expect(await sent('alternate, ArrowDown', press('ArrowDown'))).toBe('\x1b[B');

    // Application cursor mode, where the arrows xterm made were `ESC O A`.
    await mode('k', 'application cursor keys on');
    expect(await sent('application cursor, ArrowUp', press('ArrowUp'))).toBe('\x1bOA');
    expect(await sent('application cursor, six notches up', wheel(-1))).toBe('');
    expect(await sent('application cursor, trackpad swipe up', swipe(-1))).toBe('');

    // The main buffer keeps its history, and there the wheel scrolls it.
    await mode('n', 'the recorder is in the main buffer');
    const viewport = page.locator('.xterm-viewport');
    const bottom = await viewport.evaluate(el => el.scrollTop);
    expect(bottom).toBeGreaterThan(0);
    expect(await sent('main buffer, six notches up', wheel(-1))).toBe('');
    const afterNotches = await viewport.evaluate(el => el.scrollTop);
    expect(afterNotches).toBeLessThan(bottom);
    expect(await sent('main buffer, trackpad swipe up', swipe(-1))).toBe('');
    expect(await viewport.evaluate(el => el.scrollTop)).toBeLessThan(afterNotches);

    // The control: the same gestures with the guard taken away, on the same
    // terminal. Arrows arrive, so the silence above was the guard and not a
    // recorder, a wait or a wheel that never reached xterm.
    await mode('a', 'the recorder holds the alternate screen again');
    const cdp = await page.context().newCDPSession(page);
    expect(await wheelGuards(cdp), 'the capture listener stopWheelTyping adds').toBe(1);
    expect(await wheelGuards(cdp, { remove: true })).toBe(1);
    expect(await wheelGuards(cdp)).toBe(0);

    expect(await sent('control, application cursor, six notches up', wheel(-1))).toMatch(APPLICATION_ARROWS);
    expect(await sent('control, application cursor, trackpad swipe up', swipe(-1))).toMatch(APPLICATION_ARROWS);
    await mode('K', 'application cursor keys off');
    expect(await sent('control, six notches up', wheel(-1))).toMatch(ARROWS);
    expect(await sent('control, trackpad swipe up', swipe(-1))).toMatch(ARROWS);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * How many capture-phase wheel listeners the terminal's element holds, read by
 * the DevTools command line API, which hands back the listener functions
 * themselves, so they can be taken away when asked.
 */
async function wheelGuards(cdp: CDPSession, { remove = false } = {}): Promise<number> {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.querySelector('.xterm');
      const guards = (getEventListeners(element).wheel || []).filter(listener => listener.useCapture);
      if (${remove}) for (const guard of guards) element.removeEventListener('wheel', guard.listener, true);
      return guards.length;
    })()`,
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`reading the wheel listeners failed: ${exceptionDetails.text}`);
  return result.value as number;
}
