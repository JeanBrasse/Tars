'use client';

import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Button, PanelCaption } from '@/components/ui';

/**
 * SKILLS, inside the open Options panel: the picked ones as removable chips,
 * a "pick from N" button that reveals the rest, and the count on the right of
 * the caption. This is the same picker StepTools drew as an always-open
 * search-and-checklist panel - here it starts closed, because most agents
 * take zero or one skill and the panel cost a fifth of the modal's height for
 * nothing to look at.
 */
export function SkillsField({ skills, descriptions, selected, onToggle }: {
  /** Every skill this provider has installed, already deduped and sorted. */
  skills: string[];
  /** Name (lowercase) to one-line description, where one is known. */
  descriptions: Map<string, string>;
  selected: string[];
  onToggle: (name: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');

  const selectedLower = useMemo(() => new Set(selected.map(s => s.toLowerCase())), [selected]);
  // Name and description both match, because half of these are named after
  // the tool they wrap rather than after the job they do.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(name =>
      name.toLowerCase().includes(q) || (descriptions.get(name.toLowerCase()) ?? '').toLowerCase().includes(q),
    );
  }, [skills, query, descriptions]);

  return (
    <div className="px-2.5 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <PanelCaption>Skills</PanelCaption>
        {skills.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {selected.length} of {skills.length} selected
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map(name => (
          <button
            key={name}
            type="button"
            onClick={() => onToggle(name)}
            title={`Remove ${name}`}
            className="h-[26px] pl-2 pr-1.5 flex items-center gap-1.5 border border-primary bg-accent-dim text-xs text-foreground hover:bg-secondary transition-colors"
          >
            <span className="font-mono truncate max-w-[180px]">{name}</span>
            <X className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
          </button>
        ))}
        {skills.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No skills installed for this provider.</span>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setPicking(v => !v)}>
            pick from {skills.length}
          </Button>
        )}
      </div>

      {picking && skills.length > 0 && (
        <div className="mt-2 border border-border">
          <div className="flex items-center gap-2 h-8 px-2.5 border-b border-border">
            <Search className="w-3 h-3 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`filter ${skills.length} skills`}
              aria-label="Filter skills"
              className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
          <div className="max-h-[10rem] overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2.5 py-3 text-[11px] text-muted-foreground">No skill matches &ldquo;{query.trim()}&rdquo;.</p>
            ) : visible.map(name => {
              const isSelected = selectedLower.has(name.toLowerCase());
              const description = descriptions.get(name.toLowerCase());
              return (
                <button
                  key={name}
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  onClick={() => onToggle(name)}
                  className={`w-full px-2.5 py-1.5 flex items-start gap-2.5 text-left border-b border-border last:border-b-0 transition-colors ${
                    isSelected ? 'bg-accent-dim' : 'hover:bg-secondary'
                  }`}
                >
                  <span className={`w-3 h-3 mt-0.5 shrink-0 border ${isSelected ? 'bg-primary border-primary' : 'border-border-accent'}`} />
                  <span className="min-w-0">
                    <span className="block text-xs text-foreground truncate">{name}</span>
                    {description && (
                      <span className="block text-[10px] text-muted-foreground line-clamp-2">{description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
