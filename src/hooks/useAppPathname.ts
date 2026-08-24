'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Which page is on screen, in the packaged app as well as in the browser.
 *
 * `usePathname()` is Next's answer and it is right in `next dev`. In the
 * packaged app the renderer is a static export served over the `app://`
 * protocol, and there it returns `/` whatever page you are on: the URL is
 * `app://-/agents/`, which Next's router cannot map back to a route. Every
 * comparison against it then matched the Dashboard entry, so the sidebar kept
 * Dashboard lit while you were somewhere else, on top of lighting the page you
 * had actually opened.
 *
 * `window.location.pathname` is right in both, and navigation in the packaged
 * app is a real document load, so reading it on mount is enough. It is read in
 * an effect rather than during render because the server-rendered markup has
 * no window, and disagreeing with it would be a hydration mismatch.
 */

/** `/agents/` and `/agents/index.html` are the same page as `/agents`. */
export function normalisePathname(raw: string): string {
  const withoutFile = raw.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '');
  if (!withoutFile || withoutFile === '/') return '/';
  return withoutFile.replace(/\/+$/, '') || '/';
}

export function useAppPathname(): string {
  const routerPathname = usePathname();
  const [fromLocation, setFromLocation] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () => setFromLocation(normalisePathname(window.location.pathname));
    read();
    // Back and forward still move within one document in the browser build.
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [routerPathname]);

  return fromLocation ?? normalisePathname(routerPathname || '/');
}
