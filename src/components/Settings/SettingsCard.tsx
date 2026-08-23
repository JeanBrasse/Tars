import type { ReactNode } from 'react';

interface SettingsCardProps {
  children: ReactNode;
  className?: string;
}

/**
 * The single surface every settings sub-page renders inside.
 *
 * Sections used to stack their own `border border-border bg-card p-6` cards,
 * one per group of rows, so a sub-page read as three or four floating boxes.
 * The design has exactly one card per sub-page, filling the height left over
 * under the header, with its rows separated by the card's own hairlines - hence
 * `divide-y` here rather than a `border-b` on each row.
 *
 * Children are expected to be `<SettingsRow>`s. No section may hand-roll a row.
 */
export const SettingsCard = ({ children, className = '' }: SettingsCardProps) => (
  <div
    className={`flex-1 min-h-0 overflow-y-auto border border-border bg-card divide-y divide-border ${className}`}
  >
    {children}
  </div>
);
