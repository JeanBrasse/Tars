/**
 * argv as one Windows command line (audit A26, A27).
 *
 * Windows passes a process one string; the C runtime of the process started
 * (CommandLineToArgvW and the MSVC rules every Node, Rust and Go CLI follows)
 * splits it back. We build that string ourselves and hand it to node-pty as
 * a string, which it appends as it is: its own quoting takes an argument that
 * starts and ends with " as already quoted, and leaves an argument with a
 * newline and no space unquoted, so a prompt like `"fix it"` split.
 *
 * Nothing between us and CreateProcess reads %, ^, &, |, < or >: there is no
 * cmd.exe on this path (cli-binary.ts reads .cmd shims through), so they are
 * left as they are.
 */

/** CreateProcess takes 32767 characters including the terminating NUL. */
export const WINDOWS_COMMAND_LINE_MAX = 32766;

export type WindowsCommandLineErrorCode = 'too-long' | 'nul' | 'bad-program';

export class WindowsCommandLineError extends Error {
  constructor(readonly code: WindowsCommandLineErrorCode, detail: string, readonly length?: number) {
    super(`Cannot build the Windows command line (${code}): ${detail}`);
    this.name = 'WindowsCommandLineError';
  }
}

/**
 * One argument, quoted when it has to be: empty, or holding a space, a tab,
 * a newline, a vertical tab or a double quote. Inside quotes, backslashes are
 * doubled only before a " or the closing quote, and a " is written \".
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.includes('\0')) throw new WindowsCommandLineError('nul', 'an argument holds a NUL character');
  if (arg !== '' && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * The program, argv[0]. The runtime reads it differently: up to the next "
 * when it starts with one, else up to whitespace, with no escapes. So it is
 * quoted plainly when it has a space or a tab, and one holding a " (not a
 * valid Windows file name) is refused. This is also how node-pty writes
 * `file` in front of a string of arguments.
 */
export function quoteWindowsProgram(file: string): string {
  if (!file) throw new WindowsCommandLineError('bad-program', 'the program is empty');
  if (/["\0]/.test(file)) throw new WindowsCommandLineError('bad-program', 'the program holds a double quote or a NUL');
  return /[ \t]/.test(file) ? `"${file}"` : file;
}

/** The whole command line for [program, ...args], refused over WINDOWS_COMMAND_LINE_MAX. */
export function buildWindowsCommandLine(argv: string[]): string {
  if (argv.length === 0) throw new WindowsCommandLineError('bad-program', 'no program');
  const line = [quoteWindowsProgram(argv[0]), ...argv.slice(1).map(quoteWindowsArg)].join(' ');
  if (line.length > WINDOWS_COMMAND_LINE_MAX) {
    throw new WindowsCommandLineError('too-long',
      `${line.length} characters, over the ${WINDOWS_COMMAND_LINE_MAX} CreateProcess accepts`, line.length);
  }
  return line;
}
