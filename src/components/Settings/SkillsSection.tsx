import { Button } from '@/components/ui';
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
 * below state the facts and hand the browsing back to the Skills page.
 *
 * Only the first row has a data source today: `skills` is the one thing the
 * page hands us. Per-provider directories, marketplaces and the catalogue
 * refresh have no IPC behind them yet, so their controls are disabled and say
 * why on hover - wiring them is a feature, not a restyle.
 */
export const SkillsSection = ({ skills }: SkillsSectionProps) => {
  const userSkills = skills.filter(s => s.source === 'user');
  const pluginSkills = skills.filter(s => s.source === 'plugin');
  const projectSkills = skills.filter(s => s.source === 'project');

  const NOT_WIRED = 'Not wired yet.';

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
        description="Each CLI reads skills from its own folder. Tars links them so one install serves all of them."
        control={
          <div className="flex items-center gap-2">
            <Button size="sm" className="font-mono" disabled title={NOT_WIRED}>
              reveal
            </Button>
            <Button size="sm" className="font-mono" disabled title={NOT_WIRED}>
              re-link
            </Button>
          </div>
        }
      />

      <SettingsRow
        label="Marketplaces"
        description="Sources Tars pulls skills and plugins from."
        control={
          <span className="font-mono text-[12.5px] text-muted-foreground" title={NOT_WIRED}>
            none
          </span>
        }
      />

      <SettingsRow
        label="Refresh catalogue"
        description="Re-reads every skill directory on disk."
        control={
          <Button size="sm" className="font-mono" disabled title={NOT_WIRED}>
            refresh now
          </Button>
        }
      />
    </>
  );
};
