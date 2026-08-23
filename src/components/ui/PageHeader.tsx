'use client';

/**
 * The band at the top of every screen.
 *
 * Each page used to roll its own - `text-xl lg:text-2xl font-bold` here, a
 * slightly different margin there, and the Dashboard had none at all. The
 * design has one header on all sixty-odd frames: a serif title, a sentence
 * saying what the screen is for, and the page's actions on the right, sharing
 * one baseline.
 *
 * Height comes out at 84px with the standard 22px top gutter above it, which
 * is what every frame measures.
 *
 * That 22px gutter is the *page container's* job, not this component's - the
 * shell supplies it once so the band lines up across every screen. A page must
 * never re-add `pt-4 lg:pt-6` (or any other top padding) around a PageHeader;
 * doing so double-counts the gutter and pushes the title off the measured
 * baseline.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned controls. Use ui/Button so heights match the scale. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex items-end justify-between gap-4 pb-3.5 shrink-0 ${className}`}>
      <div className="min-w-0">
        <h1 className="font-serif text-2xl leading-[1.15] text-foreground truncate">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-[12.5px] leading-[1.4] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
