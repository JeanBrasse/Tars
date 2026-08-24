'use client';

import type { AgentEffort } from '@/types/agent';
import type { AgentProvider, TeamTemplateMember } from '@/types/electron';
import { PROVIDER_REGISTRY } from '@/lib/providers';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { Button, Dropdown, Input } from '@/components/ui';
import { EFFORT_LEVELS } from './logic';
import { branchSlug } from './team-defaults';

const EFFORT_DROPDOWN_OPTIONS = [
  { value: '', label: 'default' },
  ...EFFORT_LEVELS.map(e => ({ value: e, label: e })),
];

function MemberModelPicker({ provider, value, onChange }: {
  provider: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { models, loading } = useModelCatalog(provider);
  return (
    <Dropdown
      size="sm"
      mono
      ariaLabel="Model"
      value={value}
      placeholder={loading ? 'loading…' : 'default'}
      options={[{ value: '', label: 'default' }, ...models.map(m => ({ value: m.id, label: m.name, hint: m.description }))]}
      onChange={onChange}
    />
  );
}

/**
 * The columns line up across every row - that is the whole point. Two members
 * on the same model, or one with no branch and so no worktree, has to be
 * obvious at a glance, which a stack of per-member cards (the old
 * `DeployTeamDialog`) never gave you: you had to open five cards to notice.
 */
export function MembersTable({ members, selected, onToggleSelect, onPatch, onRemove, onAdd, availability }: {
  members: TeamTemplateMember[];
  selected: Set<number>;
  onToggleSelect: (i: number) => void;
  onPatch: (i: number, patch: Partial<TeamTemplateMember>) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
  availability: Record<string, boolean>;
}) {
  const providerOptions = PROVIDER_REGISTRY.filter(p => availability[p.id] !== false)
    .map(p => ({ value: p.id, label: p.label }));

  return (
    <div className="border border-border">
      <div className="grid grid-cols-[16px_1fr_1fr_1fr_1fr_1.4fr_28px] gap-2 px-2.5 py-1.5 border-b border-border">
        <span />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Role</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Provider</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Model</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Effort</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Branch</span>
        <span />
      </div>

      <div className="divide-y divide-border">
        {members.map((m, i) => {
          const isSelected = selected.has(i);
          return (
            <div
              key={i}
              className={`grid grid-cols-[16px_1fr_1fr_1fr_1fr_1.4fr_28px] gap-2 items-center px-2.5 py-1.5 ${isSelected ? '' : 'opacity-50'}`}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Deploy ${m.name}`}
                onClick={() => onToggleSelect(i)}
                className={`w-3 h-3 shrink-0 border ${isSelected ? 'bg-primary border-primary' : 'border-border-accent'}`}
              />
              <Input
                value={m.name}
                onChange={(e) => {
                  const name = e.target.value;
                  // Prefill the branch from the role name, same as typing over a
                  // suggestion - but only while the branch is still untouched, so
                  // this never overwrites one the user already set.
                  const patch: Partial<TeamTemplateMember> = { name };
                  if (!m.worktreeBranch) patch.worktreeBranch = branchSlug(name) || undefined;
                  onPatch(i, patch);
                }}
                placeholder="Role"
                compact
              />
              <Dropdown
                size="sm"
                value={m.provider || 'claude'}
                options={providerOptions}
                onChange={(v) => onPatch(i, { provider: v as AgentProvider, model: undefined })}
              />
              <MemberModelPicker
                provider={m.provider || 'claude'}
                value={m.model || ''}
                onChange={(v) => onPatch(i, { model: v || undefined })}
              />
              <Dropdown
                size="sm"
                value={m.effort || ''}
                options={EFFORT_DROPDOWN_OPTIONS}
                onChange={(v) => onPatch(i, { effort: (v || undefined) as AgentEffort | undefined })}
              />
              <Input
                mono
                value={m.worktreeBranch || ''}
                onChange={(e) => onPatch(i, { worktreeBranch: e.target.value.replace(/\s+/g, '-') || undefined })}
                placeholder={m.orchestratorMode ? 'main (no worktree)' : '(project root)'}
                compact
              />
              <button
                type="button"
                onClick={() => onRemove(i)}
                title="Remove this member"
                className="w-[26px] h-[26px] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="border-t border-border">
        <Button variant="ghost" size="sm" onClick={onAdd} className="w-full justify-start">
          + Add a member
        </Button>
      </div>
    </div>
  );
}
