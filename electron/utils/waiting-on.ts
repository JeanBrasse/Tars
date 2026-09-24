import type { AgentStatus, AgentWaitingOn } from '../types';
import { dialogOpen } from '../core/agent-launch';

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
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
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

/**
 * What an agent waits on, as the page and the API are told it: only while the
 * dialog is open (#174's dialogOpen, which a refusal recorded in the transcript
 * closes, since Claude Code sends no hook for one). Kept on the agent, it
 * outlived a refused dialog and said "allow ..." for nothing (the gate of #172).
 */
export function publishedWaitingOn(agent: AgentStatus): AgentWaitingOn | undefined {
  return agent.waitingOn && dialogOpen(agent) ? agent.waitingOn : undefined;
}
