import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { BrowserWindow } from 'electron';
import { Draft, clearKeys, confirmSubmitted, emptyDraft, feedDraft, isKeystroke, restoreKeys } from './input-draft';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AgentMessageWaiting } from '../types';

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
 * A marker has two spellings, and only one of them has a bracket. `\x1b[201~`
 * is the 7-bit form; in the 8-bit form the single byte `\x9b` *is* ESC plus
 * `[`, so the sequence is `\x9b201~` with no bracket to match. A pattern that
 * requires one, `[\x1b\x9b]\[201~`, can therefore never match the 8-bit form:
 * the second pass then eats the `\x9b` and prints the `201~`. Hence the
 * alternation below rather than a character class, and do not fold it back.
 *
 * This lives here rather than in the callers because the callers are the
 * problem: bus, Telegram, Slack and dispatch all pass text they did not write,
 * and a fifth added tomorrow would have to remember. The guarantee belongs on
 * the line that does the writing.
 */
function asTypedText(data: string): string {
  return data
    .replace(/(?:\u001b\[|\u009b)20[01]~/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/**
 * How long a terminal stays "in use" after a key was typed into it.
 *
 * A message must never land in the middle of a word, and a person who stops
 * mid-sentence to think must not hold a message for ever. Both are handled by
 * waiting for a pause rather than for an empty field, and this is the pause.
 *
 * Not a measurement: nothing in the app records how long Noah hesitates
 * mid-sentence. What is measured is the cost of getting it wrong in each
 * direction, which is what makes the number safe to choose:
 *
 * - Too short, and Tars takes the field while he is still typing. That costs
 *   the length of the write window, measured at 370 ms for an empty field and
 *   820 ms for a 379-character two-line draft (Claude Code 2.1.273, real PTY).
 *   Nothing is lost: every key typed in that window is held and replayed in
 *   order, which is what `held` below is for.
 * - Too long, and a message waits. Nothing is lost there either, but an
 *   orchestrator is told late.
 *
 * So the wrong direction to err in is "too long", and five seconds is a pause
 * long enough to be a real one and short enough that a note is not stale.
 */
export const TYPING_PAUSE_MS = 5000;

/**
 * How long after the submit keystroke the draft is typed back.
 *
 * The carriage return has to have been taken as a submit before anything else
 * arrives, or the draft joins the message it was supposed to be kept out of.
 */
const RESTORE_DELAY_MS = 250;

/** The gap between the pieces a draft is typed back in. */
const RESTORE_PIECE_GAP_MS = 30;

/**
 * How much one terminal can be holding.
 *
 * The same number, and the same reason, as the cap on what agent-watch holds
 * per recipient: a queue that a person has to act on before it moves is a
 * queue that can stop moving, and something that never empties has to stop
 * growing somewhere. Reached only by a terminal left with a draft Tars cannot
 * put back, which is the one state nothing but that person can end.
 */
const MAX_WAITING_MESSAGES = 20;

/**
 * Who a message is from and whose terminal it is going into.
 *
 * Only needed by a caller whose message can be made to wait: a wait that
 * nobody can see is the thing this is here to avoid, so the panel is told
 * which agent is holding what, and from whom.
 */
export interface WriteOrigin {
  /** The agent whose terminal this is. */
  agentId: string;
  /** Who the message is from, named as the panel should name them. */
  from: string;
  /**
   * Called once the message has actually been written into the terminal.
   *
   * Not when the caller handed it over: a message that is waiting for a
   * human draft has not reached anybody, and a journal that says it has is
   * the same lie whichever queue it is sitting in.
   */
  onWritten?: () => void;
}

/** A message that has not been written into its terminal yet. */
interface Waiting {
  data: string;
  origin?: WriteOrigin;
}

/**
 * What Tars knows about one terminal's input field.
 *
 * Per terminal rather than per agent, and keyed by the pty itself, because a
 * relaunched agent gets a new pty and must not inherit the old one's draft.
 */
interface TerminalInput {
  draft: Draft;
  /** When a key was last typed in, or 0 for a terminal nobody has touched. */
  lastKeyAt: number;
  /** Non-null while Tars owns the field: keys typed meanwhile land here. */
  held: string[] | null;
  /** Messages waiting for the field, oldest first. */
  queue: Waiting[];
  /** Armed while something is queued and the field is not free. */
  timer?: ReturnType<typeof setTimeout>;
  /** The last thing the panel was told, so it is told only when it changes. */
  announced?: string;
  /** Kept so the panel can be told the wait is over after the queue empties. */
  agentId?: string;
}

const inputs = new WeakMap<pty.IPty, TerminalInput>();

function inputOf(ptyProcess: pty.IPty): TerminalInput {
  let state = inputs.get(ptyProcess);
  if (!state) {
    state = { draft: emptyDraft(), lastKeyAt: 0, held: null, queue: [] };
    inputs.set(ptyProcess, state);
  }
  return state;
}

/** Test seam: a terminal the test is done with, and its armed timers. */
export function resetTerminalInput(ptyProcess: pty.IPty): void {
  const state = inputs.get(ptyProcess);
  if (state?.timer) clearTimeout(state.timer);
  inputs.delete(ptyProcess);
}

/** What Tars believes is in a terminal's field. Read by tests and by nothing else. */
export function draftOf(ptyProcess: pty.IPty): Draft {
  return inputOf(ptyProcess).draft;
}

/**
 * A key a person typed into an agent's terminal.
 *
 * Every one of them passes here, which is the only reason the field can be
 * known at all, and while Tars owns the field they are held rather than
 * written: a key arriving between the clearing and the carriage return would
 * be submitted with the message, which is the whole of the bug.
 */
export function writeHumanInput(ptyProcess: pty.IPty, data: string): void {
  const state = inputOf(ptyProcess);
  if (isKeystroke(data)) state.lastKeyAt = Date.now();
  if (state.held) {
    state.held.push(data);
    return;
  }
  state.draft = feedDraft(state.draft, data);
  ptyProcess.write(data);
  if (state.queue.length > 0) pump(ptyProcess);
}

/**
 * A submission was seen for this terminal (UserPromptSubmit).
 *
 * An Enter on a line beginning with `/` may run a command, may open a dialog,
 * and the keys alone cannot tell which. The hook can: a prompt was submitted,
 * so the field did empty, and the model stops having to hedge.
 */
export function noteSubmitted(ptyProcess: pty.IPty): void {
  const state = inputOf(ptyProcess);
  state.draft = confirmSubmitted(state.draft);
  if (state.queue.length > 0) pump(ptyProcess);
}

/**
 * Tell the panel what this terminal is holding, when that changes.
 *
 * A message that waits for a draft waits for a person, and a person cannot
 * act on something nobody showed them. So a wait is never silent: the panel
 * names who is waiting, and the two things that end the wait are the two
 * things only that person can do, send the draft or clear it.
 */
function announce(state: TerminalInput): void {
  const named = state.queue.filter(item => item.origin);
  const agentId = named[0]?.origin?.agentId ?? state.agentId;
  if (!agentId) return;
  state.agentId = agentId;
  const payload: AgentMessageWaiting = {
    agentId,
    waiting: named.length,
    from: [...new Set(named.map(item => item.origin!.from))],
  };
  const line = JSON.stringify(payload);
  if (line === state.announced) return;
  state.announced = line;
  broadcastToAllWindows('agent:message-waiting', payload);
}

/** Milliseconds until this terminal is out of use, or 0 if it already is. */
function pauseLeft(state: TerminalInput): number {
  return Math.max(0, state.lastKeyAt + TYPING_PAUSE_MS - Date.now());
}

/**
 * Write what is queued for a terminal, as soon as its field is free.
 *
 * Three answers, and only the first writes anything:
 * - the field is free: take it, message goes out on its own line.
 * - a key was typed a moment ago: wait for the pause. Re-armed by every key,
 *   so the wait lasts as long as the typing does and not a moment longer.
 * - the field holds something Tars cannot put back as it was: write nothing,
 *   touch nothing, and say so. Only the person at the keyboard can end that.
 */
function pump(ptyProcess: pty.IPty): void {
  const state = inputs.get(ptyProcess);
  if (!state || state.held || state.queue.length === 0) return;
  if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }

  const left = pauseLeft(state);
  if (left > 0) {
    announce(state);
    state.timer = setTimeout(() => { state.timer = undefined; pump(ptyProcess); }, left);
    return;
  }
  if (state.draft.state !== 'known') {
    announce(state);
    return;
  }

  const next = state.queue.shift()!;
  announce(state);
  takeField(ptyProcess, state, next);
}

/**
 * The window in which the field belongs to Tars and to nobody else.
 *
 * Set the draft aside, write the message, submit it, type the draft back
 * exactly as it was and leave it unsent. Keys typed while this runs are held
 * by `writeHumanInput` and replayed at the end, in order: the window is short
 * but it is not instantaneous, and a key landing inside it would otherwise be
 * submitted with the message, or lost.
 */
function takeField(ptyProcess: pty.IPty, state: TerminalInput, item: Waiting): void {
  const draft = state.draft;
  state.held = [];

  const done = () => {
    const held = state.held ?? [];
    state.held = null;
    for (const data of held) {
      state.draft = feedDraft(state.draft, data);
      write(ptyProcess, state, data);
    }
    pump(ptyProcess);
  };

  if (draft.text) write(ptyProcess, state, clearKeys(draft));
  writeBody(ptyProcess, state, item.data);
  try {
    item.origin?.onWritten?.();
  } catch (err) {
    console.error('[pty] a message reached its terminal but its caller threw:', err);
  }
  setTimeout(() => {
    write(ptyProcess, state, '\r');
    if (!draft.text) { done(); return; }
    let at = RESTORE_DELAY_MS;
    for (const piece of restoreKeys(draft)) {
      setTimeout(() => write(ptyProcess, state, piece), at);
      at += RESTORE_PIECE_GAP_MS;
    }
    setTimeout(done, at);
  }, PROGRAMMATIC_SUBMIT_DELAY_MS);
}

/** The message itself, in whichever of the two shapes the TUI needs. */
function writeBody(ptyProcess: pty.IPty, state: TerminalInput, data: string): void {
  if (data.includes('\n') || data.length > 200) {
    // Bracket paste mode: \x1b[200~ ... \x1b[201~ tells the terminal
    // "everything between these markers is pasted content, not typed input"
    write(ptyProcess, state, '\x1b[200~' + data + '\x1b[201~');
  } else {
    // Short single-line message: no bracket markers needed, but the \r must
    // still be delayed (see below) so it isn't swallowed into the paste.
    write(ptyProcess, state, data);
  }
}

/**
 * One write into a terminal that may have died since it was scheduled.
 *
 * Everything in the window above is scheduled hundreds of milliseconds ahead,
 * and an agent can be killed in that time. A throw there would take down the
 * timer and leave the field owned by nobody, so the terminal is given up on
 * instead and whatever was queued for it stops pretending it is going out.
 */
function write(ptyProcess: pty.IPty, state: TerminalInput, data: string): void {
  try {
    ptyProcess.write(data);
  } catch (err) {
    console.warn('[pty] terminal gone mid-write, dropping what was queued for it:', err);
    state.held = null;
    state.queue = [];
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    announce(state);
  }
}

/**
 * Write a message into a terminal, on a line of its own.
 *
 * `bracketPaste` is what tells the two callers apart, and they are genuinely
 * two things. False is a shell command into a shell that is about to be
 * replaced by the CLI it launches; true is a message into a CLI already
 * running, which is every note an agent, a bot, a room or a dispatch sends,
 * and the only one that can land in a field somebody is typing in.
 *
 * So the guard is on the true path, where it was measured. A message is
 * written when the field is free of a human draft, and queued here when it is
 * not: the wait belongs to the line that writes, not to the ten callers, and
 * a caller that returns without having written is exactly how the draft and
 * the message ended up submitted together.
 *
 * The carriage return is ALWAYS a separate, delayed write. Claude Code's TUI
 * treats a rapid "text\r" burst as a single paste event and buffers it
 * without submitting (the text lands in the input box as "[Pasted text]" but
 * is never sent). Delaying the \r lets the paste settle so it registers as a
 * deliberate submit keystroke. Multi-line / long input is additionally
 * wrapped in bracket paste markers so the terminal treats it as one paste
 * rather than line-by-line input.
 *
 * Returns false, and writes nothing, only when the terminal is already
 * holding as much as it can: the caller keeps what it has rather than
 * letting it evaporate here.
 *
 * DO NOT use this for raw keystroke passthrough from xterm.js UI terminals:
 * that is `writeHumanInput`, which is also what keeps the field known.
 */
export function writeProgrammaticInput(
  ptyProcess: pty.IPty,
  data: string,
  bracketPaste = false,
  origin?: WriteOrigin,
): boolean {
  // Sanitised once, for both shapes below: the short path has no paste to
  // break out of, and is exactly the one where a lone carriage return works.
  data = asTypedText(data);
  if (!bracketPaste) {
    // Plain shell command for a raw bash/zsh prompt: send directly. Nothing
    // is queued here. The field is a shell line, not the Claude Code field
    // the draft model was measured against, and the shell is replaced by the
    // command a moment later, so there would be nothing to give back.
    ptyProcess.write(data + '\r');
    return true;
  }
  const state = inputOf(ptyProcess);
  if (state.queue.length >= MAX_WAITING_MESSAGES) {
    console.warn(`[pty] a terminal already holds ${MAX_WAITING_MESSAGES} messages it cannot write, refusing another`);
    announce(state);
    return false;
  }
  state.queue.push({ data, origin });
  pump(ptyProcess);
  return true;
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
