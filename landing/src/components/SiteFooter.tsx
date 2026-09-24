/** The site's footer, on every page, as `Landing · desktop`, `Landing · 404` and `Landing · privacy and terms` draw it. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="max-w-[1040px] mx-auto px-6 py-8 flex items-center justify-between">
        <span className="flex items-center gap-2.5">
          <span className="inline-block w-2 h-2 bg-accent" />
          <span className="font-display text-base">Tars</span>
        </span>
        <div className="flex items-center gap-6 font-mono text-xs text-ink-muted">
          <a href="/privacy" className="hover:text-ink transition-colors">privacy</a>
          <a href="/terms" className="hover:text-ink transition-colors">terms</a>
          <a href="https://github.com/JeanBrasse/Tars" target="_blank" rel="noopener noreferrer" className="hover:text-ink transition-colors">
            github
          </a>
        </div>
      </div>
    </footer>
  );
}
