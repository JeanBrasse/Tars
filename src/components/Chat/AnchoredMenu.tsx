'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

const ITEMS = '[role="menuitem"]:not([disabled])';

/**
 * A menu or popover opened from a control, drawn over the page.
 *
 * Portalled to the body because the Chat's left column scrolls, and a menu
 * inside a scrolling box is cut at its edge: the frames draw the add menu and
 * the row menu over the thread beside the column. Frames: `Chat · A · Room ·
 * members join and leave` (the add menu), `Chat · A · Team rows · states` >
 * `MORE`, `Chat · A · Room · nothing said yet, how it runs open`.
 *
 * At the end of the body, it takes the focus when it opens, or Tab walks away
 * from it through the rest of the page: the first item of a menu, a popover's
 * own box. Up and Down, Home and End move between a menu's items. Escape
 * closes it; Tab closes it and goes on from the control that opened it, as it
 * would have without it; a pick closes it. Each gives the focus back to that
 * control rather than to the body the menu leaves with.
 *
 * It stays with its control: a scroll of a box that holds the control moves
 * it, and closes it once the control has left that box's view. Any other
 * scroll leaves it be: the thread following a new message used to close the
 * row menu beside it (the Audit's early look at #165).
 */
export function AnchoredMenu({
  anchor,
  open,
  onClose,
  align = 'left',
  width,
  label,
  role = 'menu',
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Which edge of the anchor the menu lines up with. */
  align?: 'left' | 'right';
  width: number;
  label: string;
  /** A menu of items, or a popover that only says something. */
  role?: 'menu' | 'dialog';
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // The listeners call the current one: callers pass a new one every render.
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; });

  const place = useCallback(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const left = align === 'right' ? r.right - width : r.left;
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, [anchor, align, width]);

  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    place();
  }, [open, place]);

  // Into it once it is on the page, and back to the control when it closes
  // with the focus inside it: by then it has left the page, and the focus
  // with it, to the body.
  const shown = open && at !== null;
  useEffect(() => {
    if (!shown) return;
    const el = box.current;
    const control = anchor.current;
    (el?.querySelector<HTMLElement>(ITEMS) ?? el)?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || el?.contains(active)) control?.focus({ preventScroll: true });
    };
  }, [shown, anchor]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    const onScroll = (e: Event) => {
      const control = anchor.current;
      const target = e.target;
      if (!control || (target instanceof Node && box.current?.contains(target))) return;
      const holder = target === document ? document.documentElement : target instanceof Element ? target : null;
      if (!holder?.contains(control)) return;
      const r = control.getBoundingClientRect();
      const view = holder === document.documentElement
        ? { top: 0, bottom: window.innerHeight }
        : holder.getBoundingClientRect();
      if (r.bottom <= view.top || r.top >= view.bottom) close.current();
      else place();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, anchor, place]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Not prevented: from the control, Tab goes on to whatever follows it.
      anchor.current?.focus({ preventScroll: true });
      close.current();
      return;
    }
    if (role !== 'menu') return;
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? (i + 1) % items.length
      : e.key === 'ArrowUp' ? (i <= 0 ? items.length - 1 : i - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? items.length - 1
            : -1;
    if (to < 0 || !items.length) return;
    e.preventDefault();
    items[to].focus();
  };

  if (!open || !at || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={box}
      role={role}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-[90] border border-border bg-card focus:outline-none focus-visible:outline-none"
      style={{ top: at.top, left: at.left, width }}
    >
      {children}
    </div>,
    document.body,
  );
}
