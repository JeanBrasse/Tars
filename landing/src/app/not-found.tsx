import Link from 'next/link';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteNav } from '@/components/SiteNav';

// The site's 404, in its own colours: Next's default was the one white page on
// the site. Frame: `Landing · 404`, in design/landing.pen.
export default function NotFound() {
  return (
    <main className="min-h-screen bg-bg text-ink flex flex-col">
      <SiteNav />
      <section className="max-w-[1040px] w-full mx-auto px-6 pt-24 pb-28 flex-1">
        <p className="font-mono text-xs text-accent mb-5">404</p>
        <h1 className="font-display text-5xl md:text-6xl leading-[1.05] max-w-3xl mb-5">There is nothing at this address.</h1>
        <p className="text-ink-soft text-[15px] leading-relaxed max-w-xl mb-8">
          The link may be old or mistyped. Everything about Tars is on the home page.
        </p>
        <Link href="/" className="inline-flex items-center px-5 py-2.5 bg-accent text-bg text-sm font-medium hover:bg-accent-deep transition-colors">
          Back to Tars
        </Link>
      </section>
      <SiteFooter />
    </main>
  );
}
