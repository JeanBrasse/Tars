'use client';

import { useState } from 'react';
import type { AgentTemplate, AgentTemplateInput, AgentCharacter, AgentProvider } from '@/types/electron';
import { Button, Chip, DialogShell, Input, Label, SegmentedControl, Select, Textarea } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';

const CHARACTERS: AgentCharacter[] = ['robot', 'ninja', 'wizard', 'astronaut', 'knight', 'pirate', 'alien', 'viking'];
const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'gemini'];

type PermissionMode = 'normal' | 'auto' | 'bypass';
const PERMISSION_MODES: SegmentedOption<PermissionMode>[] = [
  { value: 'normal', label: 'Ask each time' },
  { value: 'auto', label: 'Run freely' },
  { value: 'bypass', label: 'Skip all checks' },
];

interface TemplateFormDialogProps {
  initialTemplate?: AgentTemplate | null;
  installedSkills: string[];
  onClose: () => void;
  onSubmit: (input: AgentTemplateInput) => Promise<{ success: boolean; error?: string }>;
  /** Only for a built-in that has been overridden - drops the override. */
  onReset?: () => void;
}

export function TemplateFormDialog({ initialTemplate, installedSkills, onClose, onSubmit, onReset }: TemplateFormDialogProps) {
  const [displayName, setDisplayName] = useState(initialTemplate?.displayName ?? '');
  const [description, setDescription] = useState(initialTemplate?.description ?? '');
  const [icon, setIcon] = useState(initialTemplate?.icon ?? '🤖');
  const [character, setCharacter] = useState<AgentCharacter>(initialTemplate?.character ?? 'robot');
  const [provider, setProvider] = useState<AgentProvider>(initialTemplate?.provider ?? 'claude');
  // Model is preserved when editing an existing template, but not asked on create -
  // it falls back to the provider's default.
  const initialModel = initialTemplate?.model;
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initialTemplate?.permissionMode ?? 'normal');
  const [skills, setSkills] = useState<string[]>(initialTemplate?.skills ?? []);
  const [savedPrompt, setSavedPrompt] = useState(initialTemplate?.savedPrompt ?? '');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleSkill(name: string) {
    setSkills(prev => prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name]);
  }

  async function handleSubmit() {
    if (!displayName.trim()) {
      setError('Name is required');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await onSubmit({
        displayName: displayName.trim(),
        description: description.trim(),
        icon: icon.trim() || '🤖',
        character,
        provider,
        model: initialModel,
        permissionMode,
        skills,
        savedPrompt: savedPrompt.trim() || undefined,
      });
      if (!result.success) {
        setError(result.error ?? 'Failed to save template');
        return;
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSubmitting(false);
    }
  }

  const allSkills = Array.from(new Set([...installedSkills, ...skills])).sort();

  return (
    <DialogShell
      onClose={onClose}
      width={680}
      title={initialTemplate ? 'Edit template' : 'New template'}
      subtitle={initialTemplate
        ? 'Changes apply to the agents you start from it next.'
        : 'It becomes an option wherever you create an agent.'}
      footerLeft={onReset && (
        <Button variant="secondary" size="md" onClick={onReset} disabled={submitting}>
          Reset to built-in
        </Button>
      )}
      footerRight={
        <>
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleSubmit}
            disabled={submitting || !displayName.trim()}
          >
            {submitting ? 'Saving…' : initialTemplate ? 'Save changes' : 'Create template'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[80px_1fr] gap-3">
          <div>
            <Label>Icon</Label>
            <Input
              value={icon}
              onChange={e => setIcon(e.target.value)}
              maxLength={4}
              className="text-center text-base"
            />
          </div>
          <div>
            <Label>Name</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              maxLength={40}
              placeholder="e.g. Mobile App Engineer"
            />
          </div>
        </div>

        <div>
          <Label>Short description</Label>
          <Input
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={120}
            placeholder="What does this agent do? (one sentence)"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Character</Label>
            <Select value={character} onChange={e => setCharacter(e.target.value as AgentCharacter)}>
              {CHARACTERS.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          <div>
            <Label>Provider</Label>
            <Select value={provider} onChange={e => setProvider(e.target.value as AgentProvider)}>
              {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
            </Select>
          </div>
        </div>

        <div>
          <Label>How careful?</Label>
          <SegmentedControl
            options={PERMISSION_MODES}
            value={permissionMode}
            onChange={setPermissionMode}
            ariaLabel="How careful?"
          />
        </div>

        <div>
          <Label>
            Skills <span className="text-muted-foreground font-normal">({skills.length} selected)</span>
          </Label>
          {allSkills.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No skills installed yet - visit the Skills page to install some.</p>
          ) : (
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-2 border border-border bg-secondary/30">
              {allSkills.map(skill => {
                const installed = installedSkills.includes(skill);
                return (
                  <Chip
                    key={skill}
                    active={skills.includes(skill)}
                    // A square, not a colour on the label: the chip's own box
                    // already carries the selected state.
                    marker={installed ? undefined : 'bg-status-waiting'}
                    onClick={() => toggleSkill(skill)}
                    title={installed ? undefined : 'Skill not installed'}
                  >
                    {skill}
                  </Chip>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <Label>System prompt (optional)</Label>
          <Textarea
            value={savedPrompt}
            onChange={e => setSavedPrompt(e.target.value)}
            rows={4}
            placeholder="Tell the agent how to behave. e.g. 'You are a senior frontend engineer…'"
          />
        </div>

        {error && (
          <p className="text-[11px] text-danger bg-danger/10 border border-danger/30 px-2 py-1.5">{error}</p>
        )}
      </div>
    </DialogShell>
  );
}
