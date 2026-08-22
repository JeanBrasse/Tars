import type { ReactNode } from 'react';

interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /**
   * The row's control. It gets the 300px trailing column - pass
   * `width="control"` on a ui/Field so the field fills it exactly, or drop a
   * 26/32px button or a Toggle in and it sits flush to the right edge.
   */
  control?: ReactNode;
  /**
   * Second control, pinned to the last 30px of the column (a Toggle beside an
   * input). Adding one shrinks `control` rather than widening the row.
   */
  secondaryControl?: ReactNode;
  className?: string;
}

/**
 * One row inside a `<SettingsCard>`.
 *
 * Fixed 57px so a sub-page reads as an even stack whatever the copy does, 16px
 * of padding on both inside edges, and a 300px control column ending 16px
 * inside the card's right border - the trailing edge every settings frame lines
 * its inputs up on. The description is a single muted line under the label; it
 * truncates rather than growing the row.
 */
export const SettingsRow = ({
  label,
  description,
  control,
  secondaryControl,
  className = '',
}: SettingsRowProps) => (
  <div className={`h-[57px] shrink-0 px-4 flex items-center gap-4 ${className}`}>
    <div className="min-w-0 flex-1">
      <p className="text-[12.5px] leading-tight text-foreground truncate">{label}</p>
      {description && (
        <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground truncate">{description}</p>
      )}
    </div>

    {(control || secondaryControl) && (
      <div className="w-[300px] shrink-0 flex items-center justify-end gap-2">
        {control && <div className="min-w-0 flex-1 flex items-center justify-end">{control}</div>}
        {secondaryControl && (
          <div className="w-[30px] shrink-0 flex items-center justify-end">{secondaryControl}</div>
        )}
      </div>
    )}
  </div>
);
