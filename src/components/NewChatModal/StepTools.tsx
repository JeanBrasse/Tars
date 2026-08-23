import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Skill } from '@/lib/skills-database';
import type { ClaudeSkill } from '@/lib/claude-code';
import type { AgentProvider } from '@/types/electron';
import { Button, PanelCaption } from '@/components/ui';
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
  const [query, setQuery] = useState('');

  // The skills this agent can actually reach: what the chosen provider has on
  // disk, plus anything already selected (edit mode can carry a skill the
  // provider no longer reports). Keyed by lowercase name so the same skill from
  // two sources is one row, valued by its real casing.
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

  // Name and description both match, because half of these are named after the
  // tool they wrap rather than after the job they do.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(name =>
      name.toLowerCase().includes(q) || (descriptions.get(name.toLowerCase()) ?? '').toLowerCase().includes(q),
    );
  }, [skills, query, descriptions]);

  // Selection order, not alphabetical: the chips read as a list of decisions.
  const selectedInOrder = useMemo(
    () => selectedSkills.filter(name => skills.some(s => s.toLowerCase() === name.toLowerCase())),
    [selectedSkills, skills],
  );

  const selectedLower = useMemo(
    () => new Set(selectedSkills.map(s => s.toLowerCase())),
    [selectedSkills],
  );

  return (
    <div className="space-y-5">
      {/* Skills. This used to be one flat wrap of every installed skill - 84 of
          them on a working machine - with the name and nothing else, so finding
          one meant reading the whole cloud and knowing already what it did. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <PanelCaption>Skills</PanelCaption>
          {skills.length > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {selectedSkills.length} of {skills.length} selected
            </span>
          )}
        </div>

        {skills.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No skills installed for {provider}. Install them from Extensions.
          </p>
        ) : (
          <div className="space-y-2">
            {/* What is picked, without scrolling for it. Each chip removes
                itself, so a mis-click is undone where it is seen. */}
            {selectedInOrder.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {selectedInOrder.map(name => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => onToggleSkill(name)}
                    title={`Remove ${name}`}
                    className="h-[22px] pl-2 pr-1.5 flex items-center gap-1.5 border border-primary bg-accent-dim text-[11px] text-foreground hover:bg-secondary transition-colors"
                  >
                    <span className="font-mono truncate max-w-[180px]">{name}</span>
                    <X className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                  </button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-[22px] px-2 text-[11px]"
                  onClick={() => selectedInOrder.forEach(onToggleSkill)}
                >
                  clear
                </Button>
              </div>
            )}

            <div className="flex items-center gap-2 h-8 px-2.5 bg-secondary border border-border focus-within:border-primary transition-colors">
              <Search className="w-3 h-3 text-muted-foreground shrink-0" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={`filter ${skills.length} skills`}
                aria-label="Filter skills"
                className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear filter"
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <div className="border border-border max-h-[13rem] overflow-y-auto">
              {visible.length === 0 ? (
                <p className="px-2.5 py-3 text-[11px] text-muted-foreground">
                  No skill matches “{query.trim()}”.
                </p>
              ) : visible.map(name => {
                const isSelected = selectedLower.has(name.toLowerCase());
                const description = descriptions.get(name.toLowerCase());
                return (
                  <button
                    key={name}
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    onClick={() => onToggleSkill(name)}
                    className={`w-full px-2.5 py-1.5 flex items-start gap-2.5 text-left border-b border-border last:border-b-0 transition-colors ${
                      isSelected ? 'bg-accent-dim' : 'hover:bg-secondary'
                    }`}
                  >
                    {/* 12px square, filled when on. A checkmark glyph would be
                        the only one in the app; the palette says square. */}
                    <span
                      className={`w-3 h-3 mt-0.5 shrink-0 border ${
                        isSelected ? 'bg-primary border-primary' : 'border-border-accent'
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-foreground truncate">{name}</span>
                      {description && (
                        <span className="block text-[10px] text-muted-foreground line-clamp-2">
                          {description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Orchestrator mode - label, toggle and one line, all owned by the
          toggle. It was declared here and passed to the Task step instead,
          which had stopped rendering it, so the control was in the tree twice
          and on screen nowhere: no agent could be made an orchestrator. */}
      {onOrchestratorToggle && (
        <OrchestratorModeToggle
          isOrchestrator={isOrchestrator ?? false}
          onToggle={onOrchestratorToggle}
        />
      )}
    </div>
  );
});

export default StepTools;
