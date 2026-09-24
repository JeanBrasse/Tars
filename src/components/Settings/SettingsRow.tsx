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
  /** A description that must be read whole: it wraps, 560 wide as the frames
   *  set their hints, and the row grows with it instead of cutting it. */
  wrap?: boolean;
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
  wrap = false,
  className = '',
}: SettingsRowProps) => (
  // The data hooks let a spec read a sub-page as rows, whatever its section.
  <div data-settings-row className={`${wrap ? 'min-h-[57px] py-[11px]' : 'h-[57px]'} shrink-0 px-4 flex items-center gap-4 ${className}`}>
    <div className="min-w-0 flex-1">
      <p data-settings-label className="text-[12.5px] leading-tight text-foreground truncate">{label}</p>
      {description && (
        <p data-settings-hint className={`mt-0.5 text-[11px] leading-tight text-muted-foreground ${wrap ? 'max-w-[560px]' : 'truncate'}`}>{description}</p>
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
