'use client';

import { useEffect } from 'react';
import { PageHeader, Panel } from '@/components/ui';
import { CHANGELOG, LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

export default function WhatsNewPage() {
  // Mark as seen when user visits this page
  useEffect(() => {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    // Dispatch a storage event so Sidebar can react without a full reload
    window.dispatchEvent(new Event('whats-new-seen'));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto w-full">
      <PageHeader
        title="What's New"
        subtitle="Release history and recent improvements to Tars"
      />

      {/* One panel per release. The old rail-and-dots timeline drew a shape the
          releases already have - they are in order, and each one is a box. */}
      <div className="space-y-2">
        {CHANGELOG.map((release, i) => (
          <Panel key={release.id}>
            <div className="flex items-baseline gap-3">
              <span className="font-serif text-[28px] leading-none text-foreground">
                {release.version}
              </span>
              {i === 0 && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground">
                  new
                </span>
              )}
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {formatDate(release.date)}
              </span>
            </div>

            <ul className="mt-3 space-y-1.5">
              {release.updates.map((update, j) => (
                <li key={j} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <span className="w-1 h-1 mt-[7px] shrink-0 bg-primary" />
                  <span>{update}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
