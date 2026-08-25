import type { OverseerMessage } from '@/types/electron';

/**
 * One entry in the rendered thread: either a message, or a run of consecutive
 * replies that came back as the format template instead of an answer.
 */
export type ThreadItem =
  | { kind: 'message'; message: OverseerMessage }
  | { kind: 'echo'; key: string; messages: OverseerMessage[] };

/**
 * Fold each run of consecutive template echoes into a single entry.
 *
 * Per run rather than one banner for the whole conversation, because where they
 * happened is the part that matters: a fold sitting under a question Noah asked
 * says that question went unanswered, which a count at the top of the thread
 * cannot. Nothing is dropped - every message stays in the run it belongs to and
 * the fold opens onto all of them.
 *
 * `templateEcho` is only ever set on the overseer's own replies, so a line Noah
 * typed can never be folded away by this.
 */
export function groupThread(messages: OverseerMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];

  for (const message of messages) {
    if (!message.templateEcho) {
      items.push({ kind: 'message', message });
      continue;
    }
    const last = items[items.length - 1];
    if (last && last.kind === 'echo') last.messages.push(message);
    else items.push({ kind: 'echo', key: message.id, messages: [message] });
  }

  return items;
}
