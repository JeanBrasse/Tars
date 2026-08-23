'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui';
import { useElectronSkills } from '@/hooks/useElectron';
import { usePluginsDatabase } from '@/lib/plugins-database';
import { SettingsRow } from './SettingsRow';
import type { Skill } from './types';

interface SkillsSectionProps {
  skills: Skill[];
}

/**
 * A summary, not an inventory.
 *
 * This used to enumerate every user / plugin / project skill in three stacked
 * cards, which turned a settings sub-page into a directory listing. The rows
 * below state the facts and hand the browsing back to the Extensions page.
 *
 * Four controls here were disabled behind the tooltip "Not wired yet.", which
 * told a user nothing they could act on. Two of them were not unimplemented,
 * only disconnected: the refresh is the same one Extensions calls, and the
 * marketplace list is real data the plugin catalogue already holds. The other
 * two need a channel that does not exist, so they say what they would do and
 * point at the page that can do it today, rather than sitting greyed out with
 * no explanation.
 */
export const SkillsSection = ({ skills }: SkillsSectionProps) => {
  const { refresh, isElectron: hasElectron } = useElectronSkills();
  const { marketplaces, loading: marketplacesLoading, error: marketplacesError } = usePluginsDatabase();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const userSkills = skills.filter(s => s.source === 'user');
  const pluginSkills = skills.filter(s => s.source === 'plugin');
  const projectSkills = skills.filter(s => s.source === 'project');

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
      setRefreshedAt(new Date().toLocaleTimeString());
    } finally {
      setRefreshing(false);
    }
  };

  const marketplaceDetail = marketplacesError
    ? 'Could not reach them just now.'
    : marketplacesLoading
      ? 'Reading them.'
      : marketplaces.length === 0
        ? 'None reachable.'
        : marketplaces.map(m => m.name).join(', ');

  return (
    <>
      <SettingsRow
        label="Installed skills"
        description={`${userSkills.length} user · ${pluginSkills.length} plugin · ${projectSkills.length} project. Available to every CLI provider.`}
        control={
          <span className="font-mono text-[12.5px] text-foreground">{skills.length}</span>
        }
      />

      <SettingsRow
        label="Per-provider directories"
        description="Each CLI reads skills from its own folder. Linking one install to another provider is done on the Extensions page, per skill, where you can see which providers already have it."
        control={
          <Link
            href="/skills"
            className="inline-flex h-[26px] items-center border border-border px-2.5 font-mono text-[11px] text-text-secondary transition-colors hover:text-foreground"
          >
            open extensions
          </Link>
        }
      />

      <SettingsRow
        label="Marketplaces"
        description={`Sources Tars pulls skills and plugins from. ${marketplaceDetail}`}
        control={
          <span className="font-mono text-[12.5px] text-muted-foreground">
            {marketplacesLoading ? '…' : marketplaces.length}
          </span>
        }
      />

      <SettingsRow
        label="Refresh catalogue"
        description={
          refreshedAt
            ? `Re-reads every skill directory on disk. Last read at ${refreshedAt}.`
            : 'Re-reads every skill directory on disk.'
        }
        control={
          <Button
            size="sm"
            className="font-mono"
            onClick={handleRefresh}
            disabled={!hasElectron || refreshing}
            title={hasElectron ? undefined : 'Only in the desktop app.'}
          >
            {refreshing ? 'reading' : 'refresh now'}
          </Button>
        }
      />
    </>
  );
};
