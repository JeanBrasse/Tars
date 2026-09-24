'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UIEvent } from 'react';

/**
 * A thread that starts at its top and, once it is longer than its box,
 * follows the newest message, unless you scrolled up to read: then what
 * arrives is counted instead, for a band that jumps back. The room's thread
 * and Hermes's share it.
 *
 * `box` is the scrolling element and `content` a box inside it holding the
 * rows: the scrolling box keeps its own size whatever it holds, so only the
 * inner one says when the rows grew.
 *
 * Each rule here is one a thread broke without it (#165, parts 2 and 3):
 * - The follow runs in a layout effect, before the browser paints and
 *   scrolls. A day line appearing at the top set off scroll anchoring, and
 *   the scroll event that followed found the view off the bottom.
 * - A new message is not the only thing that moves the bottom: a receipt
 *   lands under a line after the line itself, a strip above gains a row, the
 *   window is resized. While you are at the bottom, any change to the box's
 *   height or the content's keeps you there.
 * - Only a move up stops the following. A scroll event caused by a resize
 *   lands before the ResizeObserver's callback and found the view off the
 *   bottom through no move of yours.
 */
export function useFollowBottom(messageCount: number, rowCount: number) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** Where the last scroll left the view, to tell a move up from a resize. */
  const lastTop = useRef(0);
  const seen = useRef(0);
  const [unseen, setUnseen] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    const added = messageCount - seen.current;
    seen.current = messageCount;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (added > 0) setUnseen(n => n + added);
  }, [messageCount, rowCount]);

  useEffect(() => {
    const el = box.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) stick.current = true;
    else if (el.scrollTop < lastTop.current) stick.current = false;
    lastTop.current = el.scrollTop;
    if (stick.current && unseen) setUnseen(0);
  };

  const jumpToLatest = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setUnseen(0);
  };

  return { box, content, onScroll, unseen, jumpToLatest };
}
