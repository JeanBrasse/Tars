/**
 * A provider's POSIX command line read back into argv, for launching the CLI
 * without a shell (decision D2, B1).
 *
 * The grammar is closed. It is what the 20 providers' buildInteractiveCommand
 * and the helpers in providers/cli-provider.ts emit, which
 * __tests__/electron/providers/exec-into-cli.test.ts holds to "one simple
 * command": words separated by spaces, each word a run of
 * - single-quoted text, anything but a single quote, newlines included
 *   (every value: paths, models, the prompt);
 * - the escape \' (the middle of '\'', how a quote inside a value is written);
 * - double-quoted plain text ("Edit", from orchestratorToolFlags): no $, `,
 *   \ or " inside;
 * - bare safe characters: letters, digits and . _ / : @ % + , = - (flags,
 *   effort levels, -p, --).
 * Everything else a shell would do something with is refused with a
 * PosixWordsError naming the code and the index, never guessed at: a
 * provider that starts emitting shell syntax fails loudly on every platform.
 */

export type PosixWordsErrorCode =
  | 'empty'              // no word at all
  | 'unterminated-quote' // a ' or " never closed
  | 'operator'           // ; & | ( )
  | 'redirection'        // < >
  | 'expansion'          // $ or ` outside single quotes
  | 'escape'             // a backslash other than \'
  | 'whitespace'         // a newline, tab or CR between words
  | 'special'            // * ? [ ] { } ~ # ! (globs, tilde, comment, history)
  | 'assignment'         // a leading NAME=value
  | 'keyword'            // a leading shell keyword or builtin (exec, eval, if, ...)
  | 'unsupported-char';  // anything else outside quotes

export class PosixWordsError extends Error {
  constructor(readonly code: PosixWordsErrorCode, readonly index: number, detail: string) {
    super(`Not a single POSIX simple command (${code} at index ${index}): ${detail}`);
    this.name = 'PosixWordsError';
  }
}

const BARE = /[A-Za-z0-9._/:@%+,=-]/;
const DOUBLE_QUOTED_REFUSED: Record<string, PosixWordsErrorCode> = { '$': 'expansion', '`': 'expansion', '\\': 'escape' };
const OUTSIDE: Record<string, PosixWordsErrorCode> = {
  ';': 'operator', '&': 'operator', '|': 'operator', '(': 'operator', ')': 'operator',
  '<': 'redirection', '>': 'redirection',
  '$': 'expansion', '`': 'expansion',
  '\\': 'escape',
  '\n': 'whitespace', '\t': 'whitespace', '\r': 'whitespace',
  '*': 'special', '?': 'special', '[': 'special', ']': 'special', '{': 'special', '}': 'special',
  '~': 'special', '#': 'special', '!': 'special',
};
const KEYWORDS = new Set([
  'exec', 'eval', 'source', '.', 'command', 'builtin', 'time', 'coproc', 'function', 'select',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
]);

export function posixWords(command: string): string[] {
  const words: string[] = [];
  let i = 0;
  const n = command.length;
  const refuse = (code: PosixWordsErrorCode, at: number, what: string): never => {
    throw new PosixWordsError(code, at, what);
  };

  for (;;) {
    while (command[i] === ' ') i++;
    if (i >= n) break;

    const start = i;
    let word = '';
    // The bare characters before the word's first quote, and whether it has
    // one: a leading assignment is NAME= unquoted, a keyword is all bare.
    let leadingBare = '';
    let quoted = false;
    while (i < n && command[i] !== ' ') {
      const ch = command[i];
      if (ch === "'") {
        const close = command.indexOf("'", i + 1);
        if (close < 0) refuse('unterminated-quote', i, 'a single quote is never closed');
        word += command.slice(i + 1, close);
        i = close + 1;
        quoted = true;
      } else if (ch === '\\' && command[i + 1] === "'") {
        word += "'";
        i += 2;
        quoted = true;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < n && command[j] !== '"') {
          const bad = DOUBLE_QUOTED_REFUSED[command[j]];
          if (bad) refuse(bad, j, `${JSON.stringify(command[j])} inside double quotes`);
          j++;
        }
        if (j >= n) refuse('unterminated-quote', i, 'a double quote is never closed');
        word += command.slice(i + 1, j);
        i = j + 1;
        quoted = true;
      } else if (BARE.test(ch)) {
        word += ch;
        if (!quoted) leadingBare += ch;
        i++;
      } else {
        refuse(OUTSIDE[ch] ?? 'unsupported-char', i, `${JSON.stringify(ch)} outside quotes`);
      }
    }

    if (words.length === 0) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(leadingBare)) refuse('assignment', start, `a leading assignment ${leadingBare}`);
      if (!quoted && KEYWORDS.has(word)) refuse('keyword', start, `the shell word ${word} leads the command`);
    }
    words.push(word);
  }

  if (words.length === 0) refuse('empty', 0, 'no word');
  return words;
}
