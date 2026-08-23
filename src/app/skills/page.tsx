'use client';

import { useState } from 'react';
import { PageHeader, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import SkillsTab from '@/components/Extensions/SkillsTab';
import PluginsTab from '@/components/Extensions/PluginsTab';

const TABS = [
  { value: 'skills', label: 'Skills' },
  { value: 'plugins', label: 'Plugins' },
] as const satisfies readonly SegmentedOption<'skills' | 'plugins'>[];

type TabId = (typeof TABS)[number]['value'];

export default function ExtensionsPage() {
  const [tab, setTab] = useState<TabId>('skills');

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col overflow-hidden">
      <PageHeader
        title="Extensions"
        subtitle="Skills and plugins your agents can use."
        actions={
          <SegmentedControl
            options={TABS}
            value={tab}
            onChange={setTab}
            ariaLabel="Extensions view"
          />
        }
      />

      {/* Active tab - only the selected one mounts, so the inactive tab's
          marketplace fetch doesn't run until it's opened */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'skills' ? <SkillsTab /> : <PluginsTab />}
      </div>
    </div>
  );
}
