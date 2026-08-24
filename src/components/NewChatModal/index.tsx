'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';

import type { NewChatModalProps, AgentPersonaValues } from './types';
import type { AgentProvider, TeamTemplateMember } from '@/types/electron';
import type { AgentPermissionMode } from '@/types/agent';
import { CHARACTER_OPTIONS } from './constants';
import { computeProviderAvailability } from '@/lib/providers';
import { useElectronAgents } from '@/hooks/useElectron';
import { useElectronTeamTemplates } from '@/hooks/useElectronTeamTemplates';
import { useSkillInstall } from './hooks/useSkillInstall';
import { Button, DialogShell, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import { AgentPanel } from './AgentPanel';
import { TeamPanel } from './TeamPanel';
import SkillInstallTerminal from './SkillInstallTerminal';
import { blankMember } from './team-defaults';
import { canSubmitAgent, canSubmitTeam, deployButtonLabel } from './logic';
import type { CreationMode } from './types';

const MODE_OPTIONS: SegmentedOption<CreationMode>[] = [
  { value: 'agent', label: 'One agent' },
  { value: 'team', label: 'A team' },
];

/**
 * New agent / new team, one modal.
 *
 * The old wizard spent four steps - Project, Model, Tools, Task - getting a
 * folder, a CLI, and a sentence out of the user, which made the common case
 * cost as much as the rare one. This is that same information on one screen,
 * with everything else (skills, effort, permissions, worktree, orchestrator,
 * CLI override) folded into a single Options row that reads out its own
 * contents. A team is the same screen with the header switch flipped: the
 * member table replaces the single set of tiles, and deploying one agent per
 * row replaces the three dialogs (`DeployTeamDialog` plus its inline
 * save/edit/delete team affairs) that used to be the only way to do it.
 */
export default function NewChatModal({
  open,
  onClose,
  onSubmit,
  onUpdate,
  onTeamDeployed,
  editAgent,
  projects,
  onBrowseFolder,
  // `installedSkills` is still accepted (all three call sites pass it) but
  // unused: the picker now reads `allInstalledSkills` plus the per-provider
  // map fetched below, same as before this rewrite.
  allInstalledSkills = [],
  onRefreshSkills,
  initialProjectPath,
  initialOrchestrator,
  initialMode,
  // `initialStep`, `onManageTemplates` and `existingSuperAgent` are still
  // accepted by the props type but no longer read - see types.ts for why each
  // one lost its home in the one-screen redesign.
}: NewChatModalProps) {
  const isEditMode = !!editAgent;
  const [mode, setMode] = useState<CreationMode>(initialMode || 'agent');

  /* ── shared: project, availability ───────────────────────────────── */
  const [projectPath, setProjectPath] = useState<string>(initialProjectPath || '');
  const [favoriteProjects, setFavoriteProjects] = useState<string[]>([]);
  const [hiddenProjects, setHiddenProjects] = useState<string[]>([]);
  const [defaultProjectPath, setDefaultProjectPath] = useState<string>('');
  const [installedProviders, setInstalledProviders] = useState<Record<string, boolean>>({ claude: true, codex: true, gemini: true, grok: true });

  /* ── agent mode ───────────────────────────────────────────────────── */
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [model, setModel] = useState<string>('default');
  const [cliPath, setCliPath] = useState('');
  const agentPersonaRef = useRef<AgentPersonaValues>({ character: 'robot', name: '' });
  // Not shown anywhere in the new screen (no Name field, no persona picker -
  // the frame has neither), but still round-tripped: an agent being edited
  // keeps the name it already has unless something here changes it, which
  // nothing does. Dropping this would silently rename every agent to its
  // auto-generated default the next time it is edited and saved.
  const [agentName, setAgentName] = useState('');
  const skipNextSkillsClear = useRef(false);

  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [installedSkillsByProvider, setInstalledSkillsByProvider] = useState<Record<string, string[]>>({});

  const [prompt, setPrompt] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('normal');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('medium');
  const [isOrchestrator, setIsOrchestrator] = useState(false);
  const [agentOptionsOpen, setAgentOptionsOpen] = useState(false);

  const handleRefreshSkills = useCallback(() => {
    onRefreshSkills?.();
    window.electronAPI?.skill?.listInstalledAll().then((byProvider) => {
      if (byProvider) setInstalledSkillsByProvider(byProvider);
    });
  }, [onRefreshSkills]);
  const skillInstall = useSkillInstall(handleRefreshSkills);

  // The skills this agent can actually reach: what the provider has on disk,
  // plus anything already selected (edit mode can carry a skill the provider
  // no longer reports).
  const availableSkills = useMemo(() => {
    const byName = new Map<string, string>();
    for (const name of installedSkillsByProvider[provider] ?? []) byName.set(name.toLowerCase(), name);
    for (const s of allInstalledSkills) if (!byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s.name);
    for (const name of selectedSkills) if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), name);
    return [...byName.values()].sort((a, b) => a.localeCompare(b));
  }, [installedSkillsByProvider, provider, allInstalledSkills, selectedSkills]);

  // The one-line description under each skill's name in the picker - lost if
  // this isn't carried alongside the bare name list above, since
  // `installedSkillsByProvider` only ever reports names.
  const skillDescriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of allInstalledSkills) if (s.description) map.set(s.name.toLowerCase(), s.description);
    return map;
  }, [allInstalledSkills]);

  /* ── team mode ────────────────────────────────────────────────────── */
  const { agents: existingAgents, createAgent, updateAgent, startAgent } = useElectronAgents();
  const { teams } = useElectronTeamTemplates();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [editedMembers, setEditedMembers] = useState<TeamTemplateMember[]>([]);
  const [selectedMemberIdx, setSelectedMemberIdx] = useState<Set<number>>(new Set());
  const [teamBrief, setTeamBrief] = useState('');
  const [teamOptionsOpen, setTeamOptionsOpen] = useState(false);
  const [teamPermissionOverride, setTeamPermissionOverride] = useState<AgentPermissionMode>('auto');
  const [startOnDeploy, setStartOnDeploy] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployErrors, setDeployErrors] = useState<string[]>([]);

  // Loading a preset replaces the working roster with a fresh copy of its
  // members - editing them here never writes back to the saved team.
  const loadTeam = useCallback((id: string) => {
    setSelectedTeamId(id);
    const team = teams.find(t => t.id === id);
    const members = team ? team.members.map(m => ({ ...m })) : [];
    setEditedMembers(members);
    setSelectedMemberIdx(new Set(members.map((_, i) => i)));
    setTeamPermissionOverride(members[0]?.permissionMode ?? 'auto');
  }, [teams]);

  // The team half opens with a roster already in view rather than an empty
  // table waiting for a pick - one team exists on every install (the built-in
  // full project team), so there is always something to default to.
  useEffect(() => {
    if (mode === 'team' && !selectedTeamId && teams.length > 0) loadTeam(teams[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, teams]);

  const patchMember = useCallback((i: number, patch: Partial<TeamTemplateMember>) => {
    setEditedMembers(prev => prev.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  }, []);
  const toggleMemberSelected = useCallback((i: number) => {
    setSelectedMemberIdx(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);
  const removeMember = useCallback((i: number) => {
    setEditedMembers(prev => prev.filter((_, idx) => idx !== i));
    setSelectedMemberIdx(prev => new Set(Array.from(prev).filter(x => x !== i).map(x => (x > i ? x - 1 : x))));
  }, []);
  const addMember = useCallback(() => {
    setEditedMembers(prev => {
      const next = [...prev, blankMember(prev.length)];
      setSelectedMemberIdx(sel => new Set([...sel, next.length - 1]));
      return next;
    });
  }, []);
  const applyPermissionOverride = useCallback((mode: AgentPermissionMode) => {
    setTeamPermissionOverride(mode);
    setEditedMembers(prev => prev.map(m => ({ ...m, permissionMode: mode })));
  }, []);

  /* ── reset / prepopulate on open ─────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    setMode(isEditMode ? 'agent' : (initialMode || 'agent'));

    if (editAgent) {
      setProjectPath(editAgent.projectPath);
      setSelectedSkills(editAgent.skills || []);
      setPrompt(editAgent.savedPrompt || '');
      setModel(editAgent.model || 'default');
      setUseWorktree(!!editAgent.branchName);
      setBranchName(editAgent.branchName || '');
      agentPersonaRef.current = { character: editAgent.character || 'robot', name: editAgent.name || '' };
      setAgentName(editAgent.name || '');
      setPermissionMode(editAgent.permissionMode ?? (editAgent.skipPermissions ? 'auto' : 'normal'));
      setEffort(editAgent.effort || 'medium');
      if ((editAgent.provider || 'claude') !== provider) skipNextSkillsClear.current = true;
      setProvider(editAgent.provider || 'claude');
      setIsOrchestrator(editAgent.orchestratorMode || false);
      setCliPath(editAgent.cliPath || '');
    } else {
      setProjectPath(initialProjectPath || '');
      setSelectedSkills([]);
      setPrompt('');
      setUseWorktree(false);
      setBranchName('');
      setPermissionMode('normal');
      setEffort('medium');
      setProvider('claude');
      setModel('default');
      setCliPath('');

      if (initialOrchestrator) {
        agentPersonaRef.current = { character: 'wizard', name: 'Super Agent (Orchestrator)' };
        setAgentName('Super Agent (Orchestrator)');
        setPermissionMode('bypass');
        setIsOrchestrator(true);
      } else {
        agentPersonaRef.current = { character: 'robot', name: '' };
        setAgentName('');
        setIsOrchestrator(false);
      }
    }
    setAgentOptionsOpen(false);
    setTeamOptionsOpen(false);
    setDeployErrors([]);

    window.electronAPI?.appSettings?.get().then((settings) => {
      if (Array.isArray(settings?.favoriteProjects)) setFavoriteProjects(settings.favoriteProjects);
      if (Array.isArray(settings?.hiddenProjects)) setHiddenProjects(settings.hiddenProjects);
      if (settings?.defaultProjectPath) {
        setDefaultProjectPath(settings.defaultProjectPath);
        if (!initialProjectPath && !editAgent) setProjectPath(settings.defaultProjectPath);
      }
    });

    Promise.all([
      window.electronAPI?.cliPaths?.detect(),
      window.electronAPI?.appSettings?.get(),
      window.electronAPI?.ollama?.test(),
    ]).then(([paths, settings, ollama]) => {
      setInstalledProviders(computeProviderAvailability(
        paths as Record<string, string | undefined> | undefined,
        settings,
        ollama?.reachable,
      ));
    });

    window.electronAPI?.skill?.listInstalledAll().then((byProvider) => {
      if (byProvider) setInstalledSkillsByProvider(byProvider);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialProjectPath, editAgent, initialOrchestrator, initialMode]);

  // Clear selected skills when the USER changes provider - not when edit-mode
  // prepopulation does (that would wipe the agent's saved skills on open).
  const previousProvider = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousProvider.current;
    previousProvider.current = provider;
    if (previous === null) return;
    if (skipNextSkillsClear.current) { skipNextSkillsClear.current = false; return; }
    setSelectedSkills([]);
  }, [provider]);

  const toggleSkill = useCallback((skillName: string) => {
    setSelectedSkills((prev) => prev.includes(skillName) ? prev.filter((s) => s !== skillName) : [...prev, skillName]);
  }, []);

  const handleOrchestratorToggle = useCallback((enabled: boolean) => {
    setIsOrchestrator(enabled);
    if (enabled) {
      setPermissionMode('auto');
      agentPersonaRef.current = { ...agentPersonaRef.current, character: 'wizard' };
    } else {
      setPermissionMode('normal');
      if (agentPersonaRef.current.character === 'wizard') {
        agentPersonaRef.current = { ...agentPersonaRef.current, character: 'robot' };
      }
    }
  }, []);

  /* ── submit: one agent ───────────────────────────────────────────── */
  const [isSubmitting, setIsSubmitting] = useState(false);
  const handleSubmitAgent = useCallback(async () => {
    if (!canSubmitAgent({ projectPath, useWorktree, branchName })) return;

    const agentCharacter = agentPersonaRef.current.character;
    const projectName = projectPath.split('/').pop() || 'project';
    const finalName = agentName.trim() || `${CHARACTER_OPTIONS.find(c => c.id === agentCharacter)?.name || 'Agent'} on ${projectName}`;

    setIsSubmitting(true);
    try {
      if (isEditMode && editAgent && onUpdate) {
        const worktreeConfig = useWorktree && !editAgent.branchName
          ? { enabled: true, branchName: branchName.trim() }
          : undefined;
        const result = await onUpdate(editAgent.id, {
          projectPath,
          skills: selectedSkills,
          permissionMode,
          effort: effort || undefined,
          name: finalName,
          character: agentCharacter,
          model: (model && model !== 'default') ? model : null,
          provider,
          savedPrompt: prompt.trim() || null,
          worktree: worktreeConfig,
          orchestratorMode: isOrchestrator,
          cliPath: cliPath || null,
        });
        if (result === false) return;
        onClose();
        return;
      }

      const finalPrompt = prompt.trim()
        || (selectedSkills.length > 0 ? `Use the following skills: ${selectedSkills.join(', ')}` : '');
      const worktreeConfig = useWorktree ? { enabled: true, branchName: branchName.trim() } : undefined;

      const result = await onSubmit(projectPath, selectedSkills, finalPrompt, model, worktreeConfig, agentCharacter, finalName, undefined, permissionMode, provider, undefined, undefined, effort, isOrchestrator, cliPath || undefined);
      if (result === false) return;

      setProjectPath('');
      setSelectedSkills([]);
      setPrompt('');
      setUseWorktree(false);
      setBranchName('');
      agentPersonaRef.current = { character: 'robot', name: '' };
      setAgentName('');
      setPermissionMode('normal');
      setEffort('medium');
      setProvider('claude');
      setModel('default');
      setCliPath('');
      setAgentOptionsOpen(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [projectPath, prompt, selectedSkills, useWorktree, branchName, model, permissionMode, effort, provider, cliPath, agentName, onSubmit, isEditMode, editAgent, onUpdate, onClose, isOrchestrator]);

  /* ── submit: a team ──────────────────────────────────────────────── */
  const selectedMembers = useMemo(
    () => editedMembers.filter((_, i) => selectedMemberIdx.has(i)),
    [editedMembers, selectedMemberIdx],
  );

  const handleDeployTeam = useCallback(async () => {
    if (!canSubmitTeam({ projectPath, selectedCount: selectedMembers.length })) return;
    setDeploying(true);
    setDeployErrors([]);
    const projectName = projectPath.split('/').pop() || 'project';
    const existingNames = new Set(existingAgents.filter(a => a.projectPath === projectPath).map(a => a.name));
    const createdIds: string[] = [];
    const issues: string[] = [];

    for (const member of selectedMembers) {
      const agentDisplayName = `${member.name} - ${projectName}`;
      if (existingNames.has(agentDisplayName)) {
        issues.push(`${member.name}: already deployed on this project - skipped.`);
        continue;
      }
      try {
        const resolvedModel = member.provider !== 'local' && member.model && member.model !== 'default' ? member.model : undefined;
        const agent = await createAgent({
          projectPath,
          skills: member.skills,
          character: member.character,
          name: agentDisplayName,
          permissionMode: member.permissionMode,
          effort: member.effort,
          provider: member.provider,
          model: resolvedModel,
          localModel: member.localModel,
          worktree: member.worktreeBranch ? { enabled: true, branchName: member.worktreeBranch } : undefined,
          orchestratorMode: member.orchestratorMode,
        });
        createdIds.push(agent.id);
        if (member.worktreeBranch && !agent.branchName) {
          issues.push(`${member.name}: worktree "${member.worktreeBranch}" could not be created - agent works in the project root.`);
        }
        const combinedBrief = [teamBrief.trim(), member.savedPrompt?.trim()].filter(Boolean).join('\n\n');
        if (startOnDeploy && combinedBrief) {
          await startAgent(agent.id, combinedBrief, { model: resolvedModel, provider: member.provider, localModel: member.localModel });
        } else if (combinedBrief) {
          await updateAgent({ id: agent.id, savedPrompt: combinedBrief });
        }
      } catch (err) {
        console.error(`Failed to create team member "${member.name}":`, err);
        issues.push(`${member.name}: ${err instanceof Error ? err.message : 'creation failed'}`);
      }
    }

    setDeploying(false);
    if (issues.length > 0) setDeployErrors(issues);
    if (createdIds.length > 0) onTeamDeployed?.(createdIds);
    if (issues.length === 0) onClose();
  }, [projectPath, selectedMembers, existingAgents, createAgent, updateAgent, startAgent, teamBrief, startOnDeploy, onTeamDeployed, onClose]);

  const canStartAgent = canSubmitAgent({ projectPath, useWorktree, branchName });
  const canDeployTeam = canSubmitTeam({ projectPath, selectedCount: selectedMembers.length }) && !deploying;

  if (!open) return null;

  const width = mode === 'team' ? 920 : 760;

  return (
    <>
      <DialogShell
        onClose={onClose}
        width={width}
        title={isEditMode ? 'Edit agent' : mode === 'team' ? 'New team' : 'New agent'}
        subtitle={isEditMode
          ? 'Everything about this agent, on one screen.'
          : mode === 'team'
            ? 'Several agents on one project, each on its own branch.'
            : 'A folder, a CLI, and what you want done.'}
        headerRight={!isEditMode && (
          <SegmentedControl size="md" ariaLabel="Creation mode" options={MODE_OPTIONS} value={mode} onChange={setMode} />
        )}
        className="[&_button:not(:disabled)]:cursor-pointer"
        footerLeft={
          mode === 'team' && !isEditMode
            ? <span className="text-xs text-muted-foreground">Five worktrees are created under the project. Nothing is pushed.</span>
            : <span className="text-xs text-muted-foreground">It starts as soon as you create it.</span>
        }
        footerRight={
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            {mode === 'team' && !isEditMode ? (
              <Button variant="primary" onClick={handleDeployTeam} disabled={!canDeployTeam}>
                {deploying ? 'Deploying…' : deployButtonLabel(selectedMembers.length)}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleSubmitAgent} disabled={!canStartAgent || isSubmitting}>
                {isSubmitting ? 'Working...' : isEditMode ? 'Save changes' : 'Create and start'}
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-5">
          {deployErrors.length > 0 && (
            <div className="border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger space-y-0.5">
              {deployErrors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          {mode === 'agent' || isEditMode ? (
            <AgentPanel
              projects={projects}
              projectPath={projectPath}
              onSelectProject={setProjectPath}
              onBrowseFolder={onBrowseFolder}
              favoriteProjects={favoriteProjects}
              hiddenProjects={hiddenProjects}
              defaultProjectPath={defaultProjectPath}
              provider={provider}
              onProviderChange={setProvider}
              model={model}
              onModelChange={setModel}
              installedProviders={installedProviders}
              prompt={prompt}
              onPromptChange={setPrompt}
              optionsOpen={agentOptionsOpen}
              onToggleOptions={() => setAgentOptionsOpen(v => !v)}
              skills={availableSkills}
              skillDescriptions={skillDescriptions}
              selectedSkills={selectedSkills}
              onToggleSkill={toggleSkill}
              effort={effort}
              onEffortChange={setEffort}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              useWorktree={useWorktree}
              onToggleWorktree={() => setUseWorktree(v => !v)}
              worktreeLocked={isEditMode && !!editAgent?.branchName}
              branchName={branchName}
              onBranchNameChange={setBranchName}
              isOrchestrator={isOrchestrator}
              onOrchestratorToggle={handleOrchestratorToggle}
              cliPath={cliPath}
              onCliPathChange={setCliPath}
            />
          ) : (
            <TeamPanel
              projects={projects}
              projectPath={projectPath}
              onSelectProject={setProjectPath}
              teams={teams}
              selectedTeamId={selectedTeamId}
              onSelectTeam={loadTeam}
              members={editedMembers}
              selected={selectedMemberIdx}
              onToggleSelect={toggleMemberSelected}
              onPatchMember={patchMember}
              onRemoveMember={removeMember}
              onAddMember={addMember}
              availability={installedProviders}
              brief={teamBrief}
              onBriefChange={setTeamBrief}
              optionsOpen={teamOptionsOpen}
              onToggleOptions={() => setTeamOptionsOpen(v => !v)}
              permissionOverride={teamPermissionOverride}
              onPermissionOverride={applyPermissionOverride}
              startOnDeploy={startOnDeploy}
              onToggleStartOnDeploy={() => setStartOnDeploy(v => !v)}
            />
          )}
        </div>
      </DialogShell>

      {/* Skill installation terminal - its own overlay, lifted above the
          dialog's z-70 the same way the old wizard did. */}
      <div className="relative z-[80]">
        <SkillInstallTerminal
          show={skillInstall.showInstallTerminal}
          installingSkill={skillInstall.installingSkill}
          installComplete={skillInstall.installComplete}
          installExitCode={skillInstall.installExitCode}
          terminalRef={skillInstall.terminalRef}
          onClose={skillInstall.closeInstallTerminal}
        />
      </div>
    </>
  );
}
