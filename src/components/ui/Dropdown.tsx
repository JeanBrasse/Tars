'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { filterOptions, initialIndex, stepIndex } from './dropdown-logic';

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * Themed replacement for <select>. Native selects render their popup through
 * the OS, so they ignore the app's palette entirely: every model, provider and
 * project picker opened as a stock macOS menu, white-on-light in a dark modal.
 * This renders the list ourselves.
 *
 * Replacing a native control means re-earning what it gave for free, so the
 * panel keeps the keyboard: Up/Down move the highlight, Enter commits, Escape
 * closes without changing anything, Home/End jump the ends, and the highlighted
 * row is scrolled into view. `searchable` adds a filter field for lists too long
 * to scan - the model catalogue runs to fifty entries and the project list grows
 * without bound.
 */
export function Dropdown<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  className = '',
  align = 'left',
  mono = false,
  searchable = false,
  searchPlaceholder = 'filter',
  ariaLabel,
  size = 'md',
}: {
  value: T | '';
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  className?: string;
  align?: 'left' | 'right';
  mono?: boolean;
  /** Show a filter field above the list. Worth it past roughly a dozen options. */
  searchable?: boolean;
  searchPlaceholder?: string;
  ariaLabel?: string;
  /** 32px (default) or the 26px row used in dense tables, e.g. a team's member grid. */
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = options.find(o => o.value === value);

  const visible = useMemo(
    () => (searchable ? filterOptions(options, query) : options),
    [options, query, searchable],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
  }, []);

  const commit = useCallback((option: DropdownOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  }, [onChange, close]);

  // Opening starts on the current value, so Up/Down move from where the user is
  // rather than from the top of the list.
  useEffect(() => {
    if (!open) return;
    setActiveIndex(initialIndex(visible, value));
    if (searchable) searchRef.current?.focus();
    // Only when the panel opens: re-running on `visible` would fight the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Filtering invalidates the highlight, so put it back on the first match.
  useEffect(() => {
    if (!open || query === '') return;
    setActiveIndex(initialIndex(visible, ''));
  }, [query, open, visible]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close]);

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function step(direction: 1 | -1) {
    const next = stepIndex(visible, activeIndex, direction);
    if (next >= 0) setActiveIndex(next);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(initialIndex(visible, ''));
        break;
      case 'End':
        // Stepping backward from the first row wraps to the last enabled one.
        e.preventDefault();
        setActiveIndex(stepIndex(visible, 0, -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && visible[activeIndex]) commit(visible[activeIndex]);
        break;
      // Space types into the filter field, so it can only commit without one.
      case ' ':
        if (searchable) break;
        e.preventDefault();
        if (activeIndex >= 0 && visible[activeIndex]) commit(visible[activeIndex]);
        break;
    }
  }

  return (
    <div ref={ref} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : setOpen(true))}
        className={`w-full flex items-center justify-between gap-2 bg-secondary border text-foreground transition-colors ${
          size === 'sm' ? 'h-[26px] px-2 text-xs' : 'h-8 px-3 text-sm'
        } ${open ? 'border-primary' : 'border-border hover:border-border-accent'} ${mono ? 'font-mono' : ''}`}
      >
        <span className={`truncate ${current ? '' : 'text-muted-foreground'}`}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className={`absolute z-[90] mt-1 min-w-full bg-card border border-border ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {searchable && (
            <div className="flex items-center gap-2 h-8 px-2.5 border-b border-border">
              <Search className="w-3 h-3 text-muted-foreground shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
          )}

          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No match for “{query}”.</p>
            ) : visible.map((o, i) => (
              <button
                key={o.value}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                type="button"
                disabled={o.disabled}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(o)}
                className={`w-full h-8 px-3 flex items-center gap-2 text-left text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  o.value === value
                    ? 'bg-accent-dim text-foreground'
                    : i === activeIndex
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground'
                }`}
              >
                {/* 4px accent square marks the selection; kept in flow when unselected so labels stay aligned */}
                <span className={`w-1 h-1 shrink-0 ${o.value === value ? 'bg-primary' : 'opacity-0'}`} />
                <span className={`min-w-0 truncate ${mono ? 'font-mono' : ''}`}>{o.label}</span>
                {o.hint && (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{o.hint}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
