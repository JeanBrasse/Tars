import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { BrowserWindow } from 'electron';

export const ptyProcesses: Map<string, pty.IPty> = new Map();
export const quickPtyProcesses: Map<string, pty.IPty> = new Map();
export const skillPtyProcesses: Map<string, pty.IPty> = new Map();
export const pluginPtyProcesses: Map<string, pty.IPty> = new Map();

export function killPty(ptyId: string, isQuick = false): boolean {
  const processes = isQuick ? quickPtyProcesses : ptyProcesses;
  const ptyProcess = processes.get(ptyId);
  if (ptyProcess) {
    ptyProcess.kill();
    processes.delete(ptyId);
    return true;
  }
  return false;
}

/** Kill all PTY processes across all maps. Called on app quit. */
export function killAllPty(): void {
  const allMaps = [ptyProcesses, quickPtyProcesses, skillPtyProcesses, pluginPtyProcesses];
  let killed = 0;
  for (const map of allMaps) {
    for (const [id, proc] of map) {
      try {
        proc.kill();
        killed++;
      } catch (err) {
        console.warn(`Failed to kill PTY ${id}:`, err);
      }
    }
    map.clear();
  }
  console.log(`Killed ${killed} PTY process(es) on shutdown`);
}

/**
 * Write a command to a PTY and submit it.
 *
 * When `bracketPaste` is true (used for sending messages to an already-running
 * Claude Code session), the carriage return is ALWAYS sent as a separate,
 * delayed write, even for short single-line messages. Claude Code's TUI treats
 * a rapid "text\r" burst as a single paste event and buffers it without
 * submitting (the text lands in the input box as "[Pasted text]" but is never
 * sent). Delaying the \r lets the paste settle so it registers as a deliberate
 * submit keystroke. Multi-line / long input is additionally wrapped in bracket
 * paste markers so the terminal treats it as one paste rather than line-by-line
 * input.
 *
 * When `bracketPaste` is false (default, used for the initial shell command
 * that starts Claude Code), the data is sent as plain text + \r, which is what
 * a raw bash/zsh shell expects and has no paste-detection race.
 *
 * DO NOT use this for raw keystroke passthrough from xterm.js UI terminals.
 */
/**
 * How long the submit keystroke trails the text it submits.
 *
 * Exported because that gap is a window in which a second write would land
 * inside the first message and be sent by its carriage return. A caller that
 * can produce two messages in quick succession has to know how long to leave
 * between them, and guessing it a second time somewhere else would be a copy
 * of this number that could drift from it.
 */
export const PROGRAMMATIC_SUBMIT_DELAY_MS = 300;

/**
 * Text that cannot become control.
 *
 * Everything this module types into an agent's terminal is written by someone
 * else: a teammate's bus message, a Telegram or Slack message, a dispatched
 * task. The terminal reads control characters as keys, so text that carries
 * them stops being text.
 *
 * Two ways in, and the second is why this strips more than the paste marker.
 * A long or multi-line payload is wrapped in `\x1b[200~ … \x1b[201~`, and a
 * payload containing the closing marker ends that paste early: everything
 * after it arrives as ordinary typing, and the carriage return Tars sends 300
 * ms later submits it. A short single-line payload is written with **no
 * markers at all**, so there every control character is typed directly: a bare
 * `\r` submits what came before it and makes the rest a second command, with
 * no escape sequence needed.
 *
 * So: the paste markers go, then every C0 and C1 control except tab and
 * newline, which are content inside a paste. What is left of any other escape
 * sequence is its printable tail, which is inert.
 *
 * This lives here rather than in the callers because the callers are the
 * problem: bus, Telegram, Slack and dispatch all pass text they did not write,
 * and a fifth added tomorrow would have to remember. The guarantee belongs on
 * the line that does the writing.
 */
function asTypedText(data: string): string {
  return data
    .replace(/[\u001b\u009b]\[20[01]~/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export function writeProgrammaticInput(
  ptyProcess: pty.IPty,
  data: string,
  bracketPaste = false,
): void {
  // Sanitised once, for both shapes below: the short path has no paste to
  // break out of, and is exactly the one where a lone carriage return works.
  data = asTypedText(data);
  if (bracketPaste) {
    if (data.includes('\n') || data.length > 200) {
      // Bracket paste mode: \x1b[200~ ... \x1b[201~ tells the terminal
      // "everything between these markers is pasted content, not typed input"
      ptyProcess.write('\x1b[200~' + data + '\x1b[201~');
    } else {
      // Short single-line message: no bracket markers needed, but the \r must
      // still be delayed (see below) so it isn't swallowed into the paste.
      ptyProcess.write(data);
    }
    // Delay the carriage return so the TUI finishes processing the input before
    // receiving the submit keystroke. Without this, short Telegram/Slack
    // messages get typed into the box but never sent.
    setTimeout(() => ptyProcess.write('\r'), PROGRAMMATIC_SUBMIT_DELAY_MS);
  } else {
    // Plain shell command for a raw bash/zsh prompt: send directly.
    ptyProcess.write(data + '\r');
  }
}

export function writeToPty(ptyId: string, data: string, isQuick = false): boolean {
  const processes = isQuick ? quickPtyProcesses : ptyProcesses;
  const ptyProcess = processes.get(ptyId);
  if (ptyProcess) {
    ptyProcess.write(data);
    return true;
  }
  return false;
}

export function resizePty(ptyId: string, cols: number, rows: number, isQuick = false): boolean {
  const processes = isQuick ? quickPtyProcesses : ptyProcesses;
  const ptyProcess = processes.get(ptyId);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
    return true;
  }
  return false;
}

export function createQuickPty(
  cwd: string | undefined,
  cols: number | undefined,
  rows: number | undefined,
  mainWindow: BrowserWindow | null
): string {
  const shell = process.env.SHELL || '/bin/zsh';

  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: process.env as { [key: string]: string },
  });

  const id = uuidv4();
  quickPtyProcesses.set(id, ptyProcess);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell:ptyOutput', { ptyId: id, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell:ptyExit', { ptyId: id, exitCode });
    }
    quickPtyProcesses.delete(id);
  });

  return id;
}
