'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * A menu or popover opened from a control, drawn over the page.
 *
 * Portalled to the body because the Chat's left column scrolls, and a menu
 * inside a scrolling box is cut at its edge: the frames draw the add menu and
 * the row menu over the thread beside the column. Positioned once from the
 * anchor when it opens, and closed by a click elsewhere, Escape, a resize or a
 * scroll, since a fixed box no longer sits under a control that moved.
 * Frames: `Chat · A · Room · members join and leave` (the add menu), `Chat ·
 * A · Team rows · states` > `MORE`, `Chat · A · Room · nothing said yet, how
 * it runs open`.
 */
export function AnchoredMenu({
  anchor,
  open,
  onClose,
  align = 'left',
  width,
  label,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Which edge of the anchor the menu lines up with. */
  align?: 'left' | 'right';
  width: number;
  label: string;
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) { setAt(null); return; }
    const r = anchor.current.getBoundingClientRect();
    const left = align === 'right' ? r.right - width : r.left;
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onMove = () => onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, onClose, anchor]);

  if (!open || !at || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      className="fixed z-[90] border border-border bg-card"
      style={{ top: at.top, left: at.left, width }}
    >
      {children}
    </div>,
    document.body,
  );
}
