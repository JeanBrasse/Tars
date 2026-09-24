/** The site's footer, on every page, as `Landing · desktop` and `Landing · 404` draw it. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="max-w-[1040px] mx-auto px-6 py-8 flex items-center justify-between">
        <span className="flex items-center gap-2.5">
          <span className="inline-block w-2 h-2 bg-accent" />
          <span className="font-display text-base">Tars</span>
        </span>
        <a href="https://github.com/JeanBrasse/Tars" target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-ink-muted hover:text-ink transition-colors">
          github
        </a>
      </div>
    </footer>
  );
}
