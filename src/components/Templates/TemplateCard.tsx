'use client';

import { Button } from '@/components/ui';
import type { AgentTemplate } from '@/types/electron';

interface TemplateCardProps {
  template: AgentTemplate;
  installedSkills: string[];
  onUse: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onReset?: () => void;
  onExport?: () => void;
  /** Accepted for call-site compatibility. The row no longer renders skill
   *  chips, so installing a missing skill happens on the Skills page. */
  onInstallSkill?: (skillName: string) => void;
}

/**
 * One template as a full-width row: name, what it is, and the words for what
 * you can do to it. The emoji tile, the description paragraph, the skill chips
 * and the full-width "Use this template" slab are gone - the row is the card.
 */
export function TemplateCard({ template, installedSkills, onUse, onEdit, onDuplicate, onDelete, onReset, onExport }: TemplateCardProps) {
  const installedSet = new Set(installedSkills.map(s => s.toLowerCase()));
  const missingSkills = template.skills.filter(s => !installedSet.has(s.toLowerCase()));

  // built-in / customised / yours - the three states a template can be in.
  const origin = !template.builtin ? 'yours' : template.overridden ? 'customised' : 'built-in';

  const providerLabel = template.provider.charAt(0).toUpperCase() + template.provider.slice(1);
  const meta = [
    providerLabel + (template.model ? ` · ${template.model}` : ''),
    template.skills.length > 0 ? `${template.skills.length} skill${template.skills.length > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex items-center gap-3 border border-border bg-card px-3 py-2 hover:bg-secondary transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] text-foreground truncate" title={template.description}>
            {template.displayName}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">{origin}</span>
        </div>
        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
          {meta}
          {missingSkills.length > 0 && (
            <span className="text-warning"> · {missingSkills.length} not installed</span>
          )}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" variant="ghost" className="font-mono" onClick={onUse}>use</Button>
        {onEdit && <Button size="sm" variant="ghost" className="font-mono" onClick={onEdit}>edit</Button>}
        {onDuplicate && <Button size="sm" variant="ghost" className="font-mono" onClick={onDuplicate}>duplicate</Button>}
        {onExport && <Button size="sm" variant="ghost" className="font-mono" onClick={onExport}>export</Button>}
        {onReset && <Button size="sm" variant="ghost" className="font-mono" onClick={onReset}>reset</Button>}
        {onDelete && <Button size="sm" variant="ghost" className="font-mono" onClick={onDelete}>delete</Button>}
      </div>
    </div>
  );
}
