import fs from 'node:fs';
import path from 'node:path';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteNav } from '@/components/SiteNav';
import { Markdown } from '@/lib/markdown';

/**
 * The privacy policy or the terms, word for word as Cooper Labs wrote them in
 * src/content/. Read when the site is built: `next build` runs in landing/, and
 * both pages are static. Frame: `Landing · privacy and terms`, in
 * design/landing.pen.
 */
export function LegalPage({ doc }: { doc: 'privacy' | 'terms' }) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'content', `${doc}.md`), 'utf8');
  return (
    <main className="min-h-screen bg-bg text-ink flex flex-col">
      <SiteNav />
      <article className="max-w-[1040px] w-full mx-auto px-6 pt-[72px] pb-[120px] flex-1">
        <div className="max-w-[720px] break-words">
          <Markdown source={source} />
        </div>
      </article>
      <SiteFooter />
    </main>
  );
}
