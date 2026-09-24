import type { AgentWaitingOn } from '../types';

/** Long enough for a command line or a question, short enough for one line of a card. */
const MAX_TEXT = 200;

/**
 * A text an agent chose (a command, a path, a question), made fit to show in
 * one line: controls become spaces, direction overrides and marks go, runs of
 * space become one, and it is cut. A U+202E in a command would otherwise turn
 * the sentence around it on screen, which is how the notice "a message waits"
 * was once made to say the opposite of what it meant.
 */
export function oneLine(text: string): string {
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/**
 * What a permission dialog asks, from the tool and its input as the
 * PermissionRequest hook receives them. AskUserQuestion reaches that hook too,
 * and is a question rather than a permission: its first question, and how
 * many more there are.
 */
export function waitingOnFrom(toolName: unknown, toolInput: unknown): AgentWaitingOn | undefined {
  const tool = typeof toolName === 'string' ? toolName : '';
  if (!tool) return undefined;
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === 'string' ? input[key] as string : '');

  if (tool === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first = questions.map(q => (q && typeof q === 'object' ? (q as { question?: unknown }).question : undefined))
      .find((q): q is string => typeof q === 'string' && q.trim() !== '');
    if (!first) return { kind: 'question', text: 'a question' };
    const more = questions.length - 1;
    return { kind: 'question', text: oneLine(more > 0 ? `${first} (and ${more} more)` : first) };
  }

  const subject = str('command')
    || (str('file_path') || str('notebook_path') ? `${tool} ${str('file_path') || str('notebook_path')}` : '')
    || str('url') || str('query') || str('pattern')
    || tool;
  return { kind: 'permission', text: oneLine(subject) };
}
