'use client';

import { StatusSquare } from '@/components/ui';
import type { AgentMessageWaiting } from '@/types/electron';

/** Longest sender name drawn before it is cut, in code points. Nothing sensible is longer. */
const MAX_NAME = 40;

/**
 * What a name may not carry onto this line.
 *
 * The same class `envelopeValue` escapes in `electron/services/agent-watch.ts`,
 * and for the same reason: what a reader can take for a line break, and what
 * shows as nothing or rearranges what is shown. The QA measured a name holding
 * U+202E, a right-to-left override, turning the whole sentence around on
 * screen: "A message from QA.C+lrtC htiw dleif eht raelc ro ,gnipyt era uoy
 * tahw dneS". That is not an injection, it is defacement, and this line is the
 * one place a name is next to Tars's own words. `\p{Cc}` alone, which is what
 * this covered, does not touch any of it.
 */
const HIDDEN_OR_LINE_BREAKING = /[\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu;

/**
 * A sender's name, made safe to put on one line.
 *
 * `from` is free text: it arrives on `/api/agents/:id/message` from whatever
 * called it. React escapes it as a text node, which is why it is never built
 * into markup here, and the two things left to do are the ones escaping does
 * not: flatten what hides or rearranges, and cap the length so one long name
 * cannot push the rest of the sentence out of the line.
 *
 * A space rather than nothing, so a zero-width character between two words
 * leaves a mark instead of silently making one name look like another; a run
 * of them collapses to a single space. The cap counts code points, because
 * cutting UTF-16 units splits a surrogate pair and leaves a lone half, which
 * draws as one replacement character.
 */
function clean(name: string): string {
  const flat = name.replace(HIDDEN_OR_LINE_BREAKING, ' ').trim();
  const points = [...flat];
  return points.length > MAX_NAME ? points.slice(0, MAX_NAME - 1).join('') + '…' : flat;
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
