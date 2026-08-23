import React, { useMemo } from 'react';
import type { Skill } from '@/lib/skills-database';
import type { ClaudeSkill } from '@/lib/claude-code';
import type { AgentProvider } from '@/types/electron';
import { Chip } from '@/components/ui';
import OrchestratorModeToggle from './OrchestratorModeToggle';

interface StepToolsProps {
  selectedSkills: string[];
  onToggleSkill: (name: string) => void;
  allInstalledSkills: ClaudeSkill[];
  installedSkillsByProvider: Record<string, string[]>;
  provider: AgentProvider;
  /** Orchestrator mode. This step is the app's only orchestrator control; the
   *  props are optional until the wizard shell hands them over, so the row is
   *  simply absent rather than dead while that lands. */
  isOrchestrator?: boolean;
  onOrchestratorToggle?: (enabled: boolean) => void;
  /* Accepted but no longer used: the skills marketplace - its search field,
   * category dropdown, scrolling catalog and Add/Install buttons - is gone, and
   * with it the reason to know what is installed where. They stay in the
   * interface only so the wizard shell keeps compiling until it stops passing
   * them. */
  installedSkillSet?: Set<string>;
  onInstallSkill?: (skill: Skill) => void;
}

const StepTools = React.memo(function StepTools({
  selectedSkills,
  onToggleSkill,
  allInstalledSkills,
  installedSkillsByProvider,
  provider,
  isOrchestrator,
  onOrchestratorToggle,
}: StepToolsProps) {
  // One row of chips over the skills this agent can actually reach: what the
  // chosen provider has on disk, plus anything already selected (edit mode can
  // carry a skill the provider no longer reports). Keyed by lowercase name so
  // the same skill from two sources is one chip, valued by its real casing.
  const skills = useMemo(() => {
    const byName = new Map<string, string>();
    for (const name of installedSkillsByProvider[provider] ?? []) byName.set(name.toLowerCase(), name);
    for (const s of allInstalledSkills) if (!byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s.name);
    for (const name of selectedSkills) if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), name);
    return [...byName.values()].sort((a, b) => a.localeCompare(b));
  }, [installedSkillsByProvider, provider, allInstalledSkills, selectedSkills]);

  const descriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of allInstalledSkills) if (s.description) map.set(s.name.toLowerCase(), s.description);
    return map;
  }, [allInstalledSkills]);

  return (
    <div className="space-y-5">
      {/* Skills */}
      <div>
        <MicroLabel>Skills</MicroLabel>
        {skills.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No skills installed for {provider}. Install them from Extensions.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {skills.map((name) => {
              const isSelected = selectedSkills.includes(name);
              return (
                <Chip
                  key={name}
                  active={isSelected}
                  marker={isSelected ? 'bg-primary' : 'bg-muted-foreground'}
                  title={descriptions.get(name.toLowerCase())}
                  onClick={() => onToggleSkill(name)}
                >
                  {name}
                </Chip>
              );
            })}
          </div>
        )}
      </div>

      {/* Orchestrator mode - label, toggle and one line, all owned by the toggle */}
      {onOrchestratorToggle && (
        <OrchestratorModeToggle
          isOrchestrator={isOrchestrator ?? false}
          onToggle={onOrchestratorToggle}
        />
      )}
    </div>
  );
});

function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

export default StepTools;
