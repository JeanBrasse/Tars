'use client';

import { useMemo, useState } from 'react';
import type { AgentTemplate } from '@/types/electron';
import { useElectronAgents, useElectronFS } from '@/hooks/useElectron';
import { Button, DialogShell, Dropdown, Input, Label } from '@/components/ui';
import type { DropdownOption } from '@/components/ui';

interface InstantiateDialogProps {
  template: AgentTemplate;
  onClose: () => void;
  onCreated?: (agentId: string) => void;
}

export function InstantiateDialog({ template, onClose, onCreated }: InstantiateDialogProps) {
  const { createAgent, startAgent } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [name, setName] = useState(template.displayName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One control instead of a search field over a 224px scrolling list: the
  // remembered projects, plus whatever folder was just picked through the OS
  // dialog (it is not in the list yet but still has to be selectable here).
  const projectOptions = useMemo<DropdownOption[]>(() => {
    const options = projects.map(p => ({ value: p.path, label: p.name }));
    if (projectPath && !projects.some(p => p.path === projectPath)) {
      options.unshift({ value: projectPath, label: projectPath.split('/').pop() || projectPath });
    }
    return options;
  }, [projects, projectPath]);

  async function handlePickFolder() {
    try {
      const picked = await openFolderDialog();
      if (typeof picked === 'string' && picked) setProjectPath(picked);
    } catch (err) {
      console.error('openFolderDialog failed:', err);
    }
  }

  async function handleCreate() {
    if (!projectPath) {
      setError('Please pick a project first.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const resolvedModel = template.provider !== 'local' && template.model && template.model !== 'default'
        ? template.model
        : undefined;
      const agent = await createAgent({
        projectPath,
        skills: template.skills,
        character: template.character,
        name: name.trim() || template.displayName,
        permissionMode: template.permissionMode,
        effort: template.effort,
        provider: template.provider,
        model: resolvedModel,
        localModel: template.localModel,
        obsidianVaultPaths: template.obsidianVaultPaths,
      });
      const prompt = template.savedPrompt?.trim() ?? '';
      if (prompt) {
        await startAgent(agent.id, prompt, {
          model: resolvedModel,
          provider: template.provider,
          localModel: template.localModel,
        });
      }
      onCreated?.(agent.id);
      onClose();
    } catch (err) {
      console.error('Failed to create agent from template:', err);
      setError(err instanceof Error ? err.message : 'Failed to create agent');
      setSubmitting(false);
    }
  }

  return (
    <DialogShell
      onClose={onClose}
      title={`Use ${template.displayName}`}
      subtitle="Pick a project, name your agent, and we'll set the rest up."
      footerRight={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={!projectPath || submitting}>
            {submitting ? 'Creating…' : 'Create agent'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>Agent name</Label>
          <Input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={40}
            placeholder={template.displayName}
          />
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-1">
            <Label>Project</Label>
            <Button size="sm" variant="ghost" onClick={handlePickFolder}>
              Pick another folder…
            </Button>
          </div>
          <Dropdown
            value={projectPath ?? ''}
            options={projectOptions}
            onChange={setProjectPath}
            placeholder={projectOptions.length ? 'Select a project…' : 'No projects yet — pick a folder'}
          />
          {projectPath && (
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground truncate">{projectPath}</p>
          )}
        </div>

        {error && (
          <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 px-2 py-1.5">{error}</p>
        )}
      </div>
    </DialogShell>
  );
}
