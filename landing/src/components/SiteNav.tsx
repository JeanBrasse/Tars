import { Download, Github } from 'lucide-react';

/**
 * The site's nav, on every page (`Landing · desktop` and `Landing · 404` draw
 * the same one). Off the home page its links lead back to the home page's
 * sections.
 */
export function SiteNav({ home = false }: { home?: boolean }) {
  const at = (section: string) => (home ? `#${section}` : `/#${section}`);
  return (
    <nav className="max-w-[1040px] w-full mx-auto px-6 py-6 flex items-center justify-between">
      <a href={home ? '#' : '/'} className="flex items-center gap-2.5">
        <span className="inline-block w-2.5 h-2.5 bg-accent" />
        <span className="font-display text-xl">Tars</span>
      </a>
      <div className="hidden md:flex items-center gap-8 text-[13px] text-ink-soft">
        <a href={at('features')} className="hover:text-ink transition-colors">Features</a>
        <a href={at('how')} className="hover:text-ink transition-colors">How it works</a>
        <a href={at('download')} className="hover:text-ink transition-colors">Download</a>
      </div>
      <div className="flex items-center gap-4">
        <a href="https://github.com/JeanBrasse/Tars" target="_blank" rel="noopener noreferrer" aria-label="Tars on GitHub" className="text-ink-soft hover:text-ink transition-colors">
          <Github className="w-[18px] h-[18px]" aria-hidden />
        </a>
        <a href={at('download')} className="hidden sm:flex items-center gap-1.5 px-4 py-2 bg-accent text-bg text-[13px] font-medium hover:bg-accent-deep transition-colors">
          <Download className="w-3.5 h-3.5" />
          Download
        </a>
      </div>
    </nav>
  );
}
