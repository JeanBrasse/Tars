'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { TeamTemplate, TeamTemplateMember } from '@/types/electron';
import { useElectronAgents, useElectronFS } from '@/hooks/useElectron';
import { useElectronTeamTemplates } from '@/hooks/useElectronTeamTemplates';
import { PROVIDER_REGISTRY, computeProviderAvailability } from '@/lib/providers';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { Button, DialogShell, Dropdown, Input, StatusSquare } from '@/components/ui';

/** The value the project dropdown uses for its "choose a folder" row. */
const BROWSE = '__browse__';

interface DeployTeamDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful deployment with the ids of the created agents. */
  onDeployed?: (agentIds: string[]) => void;
}

/** 10px uppercase caption over a control - the only label form in this dialog. */
function Caption({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{children}</p>;
}

/**
 * The one muted line under a member's name: the role it was saved with, or -
 * failing that - how it is going to run.
 */
function roleLine(m: TeamTemplateMember) {
  const prompt = m.savedPrompt?.trim();
  if (prompt) return prompt.split('\n')[0];
  return `${m.permissionMode} permissions${m.orchestratorMode ? ' · orchestrator' : ''}`;
}

/**
 * A member's model list, from the live catalogue rather than the snapshot
 * compiled into the release - a team deployed today should be able to use a
 * model released today.
 */
function MemberModelPicker({ provider, value, onChange }: {
  provider: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { models, loading } = useModelCatalog(provider);

  return (
    <Dropdown
      value={value}
      placeholder={loading ? 'Loading…' : 'Default'}
      options={[
        { value: '', label: 'Default' },
        ...models.map(mo => ({ value: mo.id, label: mo.name, hint: mo.description })),
      ]}
      onChange={onChange}
    />
  );
}

export function DeployTeamDialog({ open, onClose, onDeployed }: DeployTeamDialogProps) {
  const { agents, createAgent, updateAgent } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();
  const { teams, create: createTeam, remove: removeTeam } = useElectronTeamTemplates();

  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!open) return;
    Promise.all([
      window.electronAPI?.cliPaths?.detect(),
      window.electronAPI?.appSettings?.get(),
    ]).then(([paths, settings]) => {
      setAvailability(computeProviderAvailability(paths as Record<string, string | undefined> | undefined, settings));
    });
  }, [open]);

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  // Non-null while the inline "save as team" name input is showing.
  // (window.prompt is not available in Electron renderers.)
  const [pendingTeamName, setPendingTeamName] = useState<string | null>(null);

  // Reset transient state each time the dialog opens
  useEffect(() => {
    if (open) {
      setDeploying(false);
      setProgress(null);
      setErrors([]);
      setSaveMessage(null);
      setPendingTeamName(null);
    }
  }, [open]);

  const selectedTeam = useMemo(
    () => teams.find(t => t.id === selectedTeamId) ?? null,
    [teams, selectedTeamId]
  );

  // Editable working copy of the selected team's members: every deploy
  // parameter (model, effort, branch, name) can be tuned per member before
  // deploying, and optionally saved back as a custom team.
  const [editedMembers, setEditedMembers] = useState<TeamTemplateMember[]>([]);
  // Which members actually get deployed; extras can be appended too.
  const [selectedIdx, setSelectedIdx] = useState<Set<number>>(new Set());
  useEffect(() => {
    const members = selectedTeam ? selectedTeam.members.map(m => ({ ...m })) : [];
    setEditedMembers(members);
    setSelectedIdx(new Set(members.map((_, i) => i)));
  }, [selectedTeam]);

  function toggleMember(i: number) {
    setSelectedIdx(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function addExtraMember() {
    setEditedMembers(prev => {
      const next = [...prev, {
        name: `Engineer ${prev.length + 1}`,
        character: 'robot' as const,
        provider: 'claude' as const,
        permissionMode: 'auto' as const,
        skills: [],
      }];
      setSelectedIdx(sel => new Set([...sel, next.length - 1]));
      return next;
    });
  }

  function removeMember(i: number) {
    setEditedMembers(prev => prev.filter((_, idx) => idx !== i));
    setSelectedIdx(prev => new Set(Array.from(prev).filter(x => x !== i).map(x => (x > i ? x - 1 : x))));
  }

  const membersDirty = useMemo(
    () => !!selectedTeam && JSON.stringify(editedMembers) !== JSON.stringify(selectedTeam.members),
    [selectedTeam, editedMembers]
  );

  function patchMember(i: number, patch: Partial<TeamTemplateMember>) {
    setEditedMembers(prev => prev.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  }

  const rosterMembers = useMemo(
    () => (editedMembers.length > 0 ? editedMembers : selectedTeam?.members ?? []),
    [editedMembers, selectedTeam]
  );

  // The button counts what it is actually going to create: unchecking a member
  // used to leave the label promising the template's full roster.
  const membersToDeploy = useMemo(
    () => rosterMembers.filter((_, i) => selectedIdx.size === 0 || selectedIdx.has(i)),
    [rosterMembers, selectedIdx]
  );

  const projectAgents = useMemo(
    () => (projectPath ? agents.filter(a => a.projectPath === projectPath) : []),
    [agents, projectPath]
  );

  const teamOptions = useMemo(
    () => teams.map(t => ({
      value: t.id,
      label: t.name,
      hint: `${t.members.length} agent${t.members.length === 1 ? '' : 's'}`,
    })),
    [teams]
  );

  // A folder picked through the OS dialog is not in `projects`, so it is added
  // to the list explicitly - otherwise the trigger would fall back to its
  // placeholder right after the user chose it.
  const projectOptions = useMemo(() => {
    const known = projects.map(p => ({ value: p.path, label: p.name, hint: p.path }));
    if (projectPath && !projects.some(p => p.path === projectPath)) {
      known.unshift({ value: projectPath, label: projectPath.split('/').pop() || projectPath, hint: projectPath });
    }
    return [...known, { value: BROWSE, label: 'Choose a folder…', hint: '' }];
  }, [projects, projectPath]);

  if (!open) return null;

  async function handlePickFolder() {
    try {
      const picked = await openFolderDialog();
      if (typeof picked === 'string' && picked) setProjectPath(picked);
    } catch (err) {
      console.error('openFolderDialog failed:', err);
    }
  }

  async function handleDeploy() {
    if (!selectedTeam || !projectPath) return;
    setDeploying(true);
    setErrors([]);
    const projectName = projectPath.split('/').pop() || 'project';
    const existingNames = new Set(projectAgents.map(a => a.name));
    const createdIds: string[] = [];
    const issues: string[] = [];

    for (const member of membersToDeploy) {
      const agentName = `${member.name} - ${projectName}`;
      // Re-deploying the same team must not double up agents: two agents with
      // the same name would share one worktree/branch and fight over files.
      if (existingNames.has(agentName)) {
        issues.push(`${member.name}: already deployed on this project - skipped.`);
        continue;
      }
      setProgress(`Creating ${member.name}…`);
      try {
        const resolvedModel = member.provider !== 'local' && member.model && member.model !== 'default'
          ? member.model
          : undefined;
        const agent = await createAgent({
          projectPath,
          skills: member.skills,
          character: member.character,
          name: agentName,
          permissionMode: member.permissionMode,
          effort: member.effort,
          provider: member.provider,
          model: resolvedModel,
          localModel: member.localModel,
          worktree: member.worktreeBranch
            ? { enabled: true, branchName: member.worktreeBranch }
            : undefined,
          orchestratorMode: member.orchestratorMode,
        });
        createdIds.push(agent.id);
        // agent:create swallows git-worktree failures and falls back to the
        // project root - surface that instead of reporting a clean deploy.
        if (member.worktreeBranch && !agent.branchName) {
          issues.push(`${member.name}: worktree "${member.worktreeBranch}" could not be created (not a git repo, or branch busy) - agent works in the project root.`);
        }
        if (member.savedPrompt?.trim()) {
          await updateAgent({ id: agent.id, savedPrompt: member.savedPrompt });
        }
      } catch (err) {
        console.error(`Failed to create team member "${member.name}":`, err);
        issues.push(`${member.name}: ${err instanceof Error ? err.message : 'creation failed'}`);
      }
    }

    setProgress(null);
    setDeploying(false);
    if (issues.length > 0) {
      setErrors(issues);
      if (createdIds.length > 0) {
        setSaveMessage(`${createdIds.length} agent${createdIds.length === 1 ? '' : 's'} created.`);
        onDeployed?.(createdIds);
      }
      return;
    }
    onDeployed?.(createdIds);
    onClose();
  }

  async function handleConfirmSaveTeam() {
    const name = pendingTeamName?.trim();
    if (!name) return;

    if (membersDirty && editedMembers.length > 0) {
      try {
        const result = await createTeam({ name, members: editedMembers });
        if (result.success && result.team) {
          setSelectedTeamId(result.team.id);
          setSaveMessage(`Saved "${result.team.name}" (${editedMembers.length} members).`);
          setPendingTeamName(null);
        } else {
          setErrors([result.error ?? 'Failed to save team']);
        }
      } catch (err) {
        setErrors([err instanceof Error ? err.message : 'Failed to save team']);
      }
      return;
    }

    if (!projectPath || projectAgents.length === 0) return;
    const projectName = projectPath.split('/').pop() || 'project';
    // Deployed agents are named "<role> - <project>"; strip the suffix so
    // save>redeploy cycles don't accrete " - projA - projB" onto member names.
    const suffix = ` - ${projectName}`;

    const members: Partial<TeamTemplateMember>[] = projectAgents.map(a => {
      const rawName = a.name || `Agent ${a.id.slice(0, 4)}`;
      return {
        name: rawName.endsWith(suffix) ? rawName.slice(0, -suffix.length) : rawName,
        character: a.character,
        provider: a.provider,
        model: a.model,
        localModel: a.localModel,
        permissionMode: a.permissionMode ?? (a.skipPermissions ? 'auto' : 'normal'),
        effort: a.effort,
        skills: a.skills,
        savedPrompt: a.savedPrompt,
        worktreeBranch: a.branchName,
        orchestratorMode: a.orchestratorMode,
      };
    });

    try {
      const result = await createTeam({ name, members });
      if (result.success && result.team) {
        setSelectedTeamId(result.team.id);
        setSaveMessage(`Saved "${result.team.name}" (${members.length} member${members.length === 1 ? '' : 's'}).`);
        setPendingTeamName(null);
      } else {
        setErrors([result.error ?? 'Failed to save team']);
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Failed to save team']);
    }
  }

  async function handleDeleteTeam(team: TeamTemplate) {
    if (!confirm(`Delete team "${team.name}"?`)) return;
    await removeTeam(team.id);
    if (selectedTeamId === team.id) setSelectedTeamId(null);
  }

  const canSaveTeam = membersDirty ? true : !!projectPath && projectAgents.length > 0;

  return (
    <DialogShell
      width={720}
      onClose={() => { if (!deploying) onClose(); }}
      title="Deploy a team"
      subtitle="Pick a team and a project - every member is created in one go, each on its own worktree branch."
      footerLeft={rosterMembers.length > 0 ? (
        <span className="text-xs text-muted-foreground">
          {membersToDeploy.length} of {rosterMembers.length} member{rosterMembers.length === 1 ? '' : 's'} selected
        </span>
      ) : undefined}
      footerRight={
        <>
          <Button variant="ghost" onClick={onClose} disabled={deploying}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleDeploy}
            disabled={!selectedTeam || !projectPath || deploying}
          >
            {deploying
              ? (progress ?? 'Deploying…')
              : `Deploy${membersToDeploy.length > 0 ? ` ${membersToDeploy.length} agent${membersToDeploy.length === 1 ? '' : 's'}` : ''}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* What to deploy, where, and the one control that grows the roster */}
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <Caption>Template</Caption>
            <Dropdown
              value={selectedTeamId ?? ''}
              placeholder="Pick a team"
              options={teamOptions}
              onChange={v => setSelectedTeamId(v)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <Caption>Project</Caption>
            <Dropdown
              value={projectPath ?? ''}
              placeholder="Pick a project"
              options={projectOptions}
              onChange={v => { if (v === BROWSE) handlePickFolder(); else setProjectPath(v); }}
            />
          </div>
          <Button variant="secondary" onClick={addExtraMember} disabled={!selectedTeam}>
            + Add member
          </Button>
        </div>

        {/* Members - every card open, every deploy parameter in reach */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Members{rosterMembers.length > 0 ? ` (${rosterMembers.length})` : ''}
            </p>
            <div className="flex items-center gap-2">
              {membersDirty && <span className="font-mono text-[10px] text-muted-foreground">edited</span>}
              {selectedTeam && !selectedTeam.builtin && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="font-mono"
                  onClick={() => handleDeleteTeam(selectedTeam)}
                  disabled={deploying}
                >
                  delete team
                </Button>
              )}
              {pendingTeamName === null && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="font-mono"
                  onClick={() => {
                    const base = membersDirty && selectedTeam
                      ? `${selectedTeam.name} (custom)`
                      : `${projectPath?.split('/').pop() || 'project'} team`;
                    setPendingTeamName(base);
                  }}
                  disabled={deploying || !canSaveTeam}
                  title={membersDirty
                    ? 'Save your edited members as a reusable custom team'
                    : (projectPath ? `Save the ${projectAgents.length} agent(s) of this project as a reusable team` : 'Pick a project first - or edit a team\'s members to save a custom team')}
                >
                  save as team
                </Button>
              )}
            </div>
          </div>

          {pendingTeamName !== null && (
            <div className="flex items-center gap-2 mb-2">
              <div className="w-44">
                <Input
                  autoFocus
                  value={pendingTeamName}
                  onChange={e => setPendingTeamName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleConfirmSaveTeam(); }}
                  placeholder="Team name"
                  maxLength={40}
                />
              </div>
              <Button variant="primary" onClick={handleConfirmSaveTeam} disabled={!pendingTeamName.trim()}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setPendingTeamName(null)}>Cancel</Button>
            </div>
          )}

          {editedMembers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {selectedTeam ? 'No members left - add one to deploy something.' : 'Pick a team above to see its members.'}
            </p>
          ) : (
            <div className="space-y-2">
              {editedMembers.map((m, i) => {
                const selected = selectedIdx.has(i);
                return (
                  // An unchecked member is not going to be created, so the whole
                  // card recedes rather than just its checkbox.
                  <div key={i} className={`border border-border bg-secondary/30 p-3 space-y-2.5 ${selected ? '' : 'opacity-50'}`}>
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleMember(i)}
                        className="accent-[var(--primary)] shrink-0 mt-0.5"
                        title="Deploy this member"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground truncate">{m.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{roleLine(m)}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="font-mono"
                        onClick={() => removeMember(i)}
                        title="Remove from this deployment"
                      >
                        remove
                      </Button>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="min-w-0">
                        <Caption>Provider</Caption>
                        <Dropdown
                          value={m.provider || 'claude'}
                          options={PROVIDER_REGISTRY.filter(p => availability[p.id] !== false).map(p => ({ value: p.id, label: p.label }))}
                          onChange={v => patchMember(i, { provider: v as TeamTemplateMember['provider'], model: undefined })}
                        />
                      </div>
                      <div className="min-w-0">
                        <Caption>Model</Caption>
                        <MemberModelPicker
                          provider={m.provider || 'claude'}
                          value={m.model || ''}
                          onChange={v => patchMember(i, { model: v || undefined })}
                        />
                      </div>
                      <div className="min-w-0">
                        <Caption>Effort</Caption>
                        <Dropdown
                          value={m.effort || ''}
                          placeholder="Default"
                          options={[{ value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'X-High' }, { value: 'max', label: 'Max' }]}
                          onChange={v => patchMember(i, { effort: (v || undefined) as TeamTemplateMember['effort'] })}
                        />
                      </div>
                      <div className="min-w-0">
                        <Caption>Branch</Caption>
                        <Input
                          mono
                          value={m.worktreeBranch || ''}
                          onChange={e => patchMember(i, { worktreeBranch: e.target.value || undefined })}
                          placeholder="(project root)"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {saveMessage && (
          <p className="flex items-center gap-2 border border-border bg-bg-tertiary px-2 py-1.5 text-xs text-foreground">
            <StatusSquare tone="running" />
            {saveMessage}
          </p>
        )}

        {errors.length > 0 && (
          <div className="flex items-start gap-2 border border-border bg-bg-tertiary px-2 py-1.5 text-xs text-danger">
            <StatusSquare tone="error" className="mt-1.5" />
            <div className="space-y-0.5">
              {errors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          </div>
        )}
      </div>
    </DialogShell>
  );
}
