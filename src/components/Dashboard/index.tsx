'use client';

import dynamic from 'next/dynamic';
import { LoadingPanel } from '@/components/ui';
import { PageHeader } from '@/components/ui/PageHeader';

// Dynamically import TerminalsView to avoid SSR issues with xterm
const TerminalsView = dynamic(() => import('@/components/TerminalsView'), {
  ssr: false,
  loading: () => (
    <div className="h-full bg-card border border-border">
      <LoadingPanel what="Loading Terminals" />
    </div>
  ),
});

/**
 * Where the page header's action buttons land.
 *
 * The two actions the frame shows - `Layout` and `+ Terminal` - are driven by
 * state that lives inside `TerminalsView` (the active tab's preset, the agent
 * list, the new-agent handler). Dashboard renders `<TerminalsView />` with no
 * props and cannot reach any of it, so the header keeps an empty element here
 * and TerminalsView portals its two controls into it.
 */
export const DASHBOARD_HEADER_ACTIONS_SLOT_ID = 'dashboard-header-actions';

export default function Dashboard() {
  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <PageHeader
        title="Dashboard"
        subtitle="Every terminal you have open, side by side."
        actions={<div id={DASHBOARD_HEADER_ACTIONS_SLOT_ID} className="flex items-center gap-2" />}
      />

      {/* Terminals. No card around them - the panels sit on the page
          background and the status bar runs full-bleed underneath. */}
      <div className="flex-1 min-h-0">
        <TerminalsView />
      </div>
    </div>
  );
}
