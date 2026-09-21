'use client';

import { StatusSquare } from '@/components/ui';
import type { AgentMessageWaiting } from '@/types/electron';

/** Longest sender name drawn before it is cut. Nothing sensible is longer. */
const MAX_NAME = 40;

/** The control characters a CLI can put in a name, none of which belong on a line. */
const CONTROL = /\p{Cc}+/gu;

/**
 * A sender's name, made safe to put on one line.
 *
 * `from` is free text: it arrives on `/api/agents/:id/message` from whatever
 * called it. React escapes it as a text node, which is why it is never built
 * into markup here, and the two things left to do are the ones escaping does
 * not: flatten the control characters a CLI can emit, and cap the length so
 * one long name cannot push the rest of the sentence out of the line.
 */
function clean(name: string): string {
  const flat = name.replace(CONTROL, ' ').trim();
  return flat.length > MAX_NAME ? flat.slice(0, MAX_NAME - 1) + '…' : flat;
}

function senders(from: string[]): string {
  const names = from.map(clean).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/**
 * The line itself, in two halves: who is waiting, and what to do about it.
 *
 * The count is the subject, so the verb agrees with it whatever `from` holds:
 * one sender with three messages still reads "3 messages from X are waiting".
 * The senders are named in the first half because who is waiting is the part
 * worth scanning; the second half is the same sentence every time, and it says
 * the only two things that end the wait, both of which are the person's.
 */
export function messageWaitingLine({ waiting, from }: AgentMessageWaiting): { who: string; rest: string } {
  const one = waiting === 1;
  const names = senders(from ?? []);
  return {
    who: `${one ? 'A message' : `${waiting} messages`}${names ? ` from ${names}` : ''}`,
    rest: `${one ? 'is' : 'are'} waiting for this field. Send what you are typing, or clear the field with Ctrl+C.`,
  };
}

/**
 * The notice a terminal shows while it is holding a message it cannot write.
 *
 * A row of its own under the panel header, full width, rather than a slot
 * inside that header: at a 580px panel the header leaves about fifty pixels
 * between the agent's name and its controls, and a sentence cut to fifty
 * pixels is exactly the notice nobody reads. It costs the terminal 26px while
 * a message waits, and the fit addon gives them back the moment it goes.
 *
 * Frame: `Message waiting · notice`.
 */
export default function MessageWaitingNotice({ waiting }: { waiting?: AgentMessageWaiting }) {
  if (!waiting || waiting.waiting < 1) return null;
  const { who, rest } = messageWaitingLine(waiting);
  return (
    <div
      role="status"
      title={`${who} ${rest}`}
      className="h-[26px] shrink-0 flex items-center gap-2 px-3 bg-secondary border-b border-border select-none"
    >
      <StatusSquare tone="waiting" />
      <p className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground">
        <span className="text-foreground">{who}</span> {rest}
      </p>
    </div>
  );
}
