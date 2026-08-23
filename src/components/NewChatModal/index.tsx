'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';

import type { NewChatModalProps, AgentPersonaValues } from './types';
import type { AgentProvider, AgentTemplate } from '@/types/electron';
import { CHARACTER_OPTIONS } from './constants';
import { computeProviderAvailability } from '@/lib/providers';
import { useElectronTemplates } from '@/hooks/useElectronTemplates';
import { useSkillInstall } from './hooks/useSkillInstall';
import { Button, Chip, DialogShell } from '@/components/ui';
import StepProject from './StepProject';
import StepModel from './StepModel';
import StepTools from './StepTools';
import StepTask from './StepTask';
import SkillInstallTerminal from './SkillInstallTerminal';

const STEPS = [
  { label: 'Project', number: 1 },
  { label: 'Model', number: 2 },
  { label: 'Tools', number: 3 },
  { label: 'Task', number: 4 },
] as const;

// The dialog subtitle is per-step: the title never changes, so the one line
// under it is what tells you where you are.
const STEP_SUBTITLE: Record<number, string> = {
  1: 'Where this agent works.',
  2: 'Which CLI runs it, and on which model.',
  3: 'What it can reach for while it works.',
  4: 'What it should do first.',
};

/**
 * The step row: four 32px chips at the top of the body, on the same gutter as
 * the fields under them. The old version was a centred track of circles joined
 * by 2px connector bars with a ring halo on the current one - three shapes the
 * design does not have. Active is the ordinary selected box; the only accent
 * on the row is the number square inside it.
 */
function StepIndicator({ currentStep, onStepClick }: { currentStep: number; onStepClick: (step: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((s) => {
        const isCompleted = currentStep > s.number;
        const isActive = currentStep === s.number;

        return (
          <Button
            key={s.number}
            size="md"
            variant="ghost"
            active={isActive}
            onClick={() => {
              if (isCompleted) onStepClick(s.number);
            }}
            // Only steps you have not reached are dead - disabling the current
            // one dimmed the chip you are standing on.
            disabled={currentStep < s.number}
          >
            <span
              className={`w-4 h-4 flex items-center justify-center font-mono text-[9.5px] leading-none ${
                isActive ? 'bg-primary text-primary-foreground' : 'bg-bg-tertiary text-muted-foreground'
              }`}
            >
              {s.number}
            </span>
            {s.label}
          </Button>
        );
      })}
    </div>
  );
}

export default function NewChatModal({
  open,
  onClose,
  onSubmit,
  onUpdate,
  editAgent,
  projects,
  onBrowseFolder,
  installedSkills = [],
  allInstalledSkills = [],
  onRefreshSkills,
  initialProjectPath,
  initialStep,
  initialOrchestrator,
  onManageTemplates,
  // `existingSuperAgent` is still accepted by the props type but no longer
  // read: the "an orchestrator already exists" note lived inside the step-1
  // Agent/Orchestrator picker, and the orchestrator is now chosen once, in the
  // Tools step.
}: NewChatModalProps) {
  const isEditMode = !!editAgent;
  // Step navigation
  const [step, setStep] = useState(initialStep || 1);

  // Step 1: Project selection
  const [selectedProject, setSelectedProject] = useState<string>(initialProjectPath || '');
  const [customPath, setCustomPath] = useState('');
  const [showSecondaryProject, setShowSecondaryProject] = useState(false);
  const [selectedSecondaryProject, setSelectedSecondaryProject] = useState<string>('');
  const [customSecondaryPath, setCustomSecondaryPath] = useState('');
  const [favoriteProjects, setFavoriteProjects] = useState<string[]>([]);
  const [hiddenProjects, setHiddenProjects] = useState<string[]>([]);
  const [defaultProjectPath, setDefaultProjectPath] = useState<string>('');

  // Step 2: Model
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [model, setModel] = useState<string>('default');
  const [localModel, setLocalModel] = useState('');
  const [tasmaniaEnabled, setTasmaniaEnabled] = useState(false);
  const [installedProviders, setInstalledProviders] = useState<Record<string, boolean>>({ claude: true, codex: true, gemini: true, grok: true, opencode: true, pi: true });
  const [cliPath, setCliPath] = useState('');
  const agentPersonaRef = useRef<AgentPersonaValues>({ character: 'robot', name: '' });
  // Armed when the open-effect programmatically changes the provider (edit
  // prepopulation) so the provider-change effect doesn't wipe the agent's
  // pre-filled skills.
  const skipNextSkillsClear = useRef(false);

  // Step 3: Tools
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [installedSkillsByProvider, setInstalledSkillsByProvider] = useState<Record<string, string[]>>({});
  const [selectedObsidianVaults, setSelectedObsidianVaults] = useState<string[]>([]);
  const [registeredVaults, setRegisteredVaults] = useState<string[]>([]);
  const [detectedVault, setDetectedVault] = useState<string | null>(null);

  // Template picker (create mode): applying a template prefills the form
  const { templates: agentTemplates, refresh: refreshTemplates } = useElectronTemplates();
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null);

  // Step 4: Task
  const [prompt, setPrompt] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [permissionMode, setPermissionMode] = useState<'normal' | 'auto' | 'bypass'>('normal');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('medium');
  const [isOrchestrator, setIsOrchestrator] = useState(false);

  const projectPath = selectedProject || customPath;

  // Refresh both parent skills and local provider-skill map
  const handleRefreshSkills = useCallback(() => {
    onRefreshSkills?.();
    window.electronAPI?.skill?.listInstalledAll().then((byProvider) => {
      if (byProvider) setInstalledSkillsByProvider(byProvider);
    });
  }, [onRefreshSkills]);

  // Skill installation hook
  const skillInstall = useSkillInstall(handleRefreshSkills);

  // Pre-compute installed skill names for the selected provider
  const installedSkillSet = useMemo(() => {
    const set = new Set<string>();
    const providerSkills = installedSkillsByProvider[provider] || [];
    for (const s of providerSkills) set.add(s.toLowerCase());
    return set;
  }, [installedSkillsByProvider, provider]);

  // Reset form when modal opens (or pre-populate in edit mode)
  useEffect(() => {
    if (open) {
      if (editAgent) {
        // Edit mode: pre-populate from existing agent
        setStep(initialStep || 1);
        setSelectedProject(editAgent.projectPath);
        setCustomPath('');
        setSelectedSkills(editAgent.skills || []);
        setPrompt(editAgent.savedPrompt || '');
        setModel(editAgent.model || 'default');
        setUseWorktree(!!editAgent.branchName);
        setBranchName(editAgent.branchName || '');
        agentPersonaRef.current = {
          character: editAgent.character || 'robot',
          name: editAgent.name || '',
        };
        setShowSecondaryProject(!!editAgent.secondaryProjectPath);
        setSelectedSecondaryProject(editAgent.secondaryProjectPath || '');
        setCustomSecondaryPath('');
        setPermissionMode(editAgent.permissionMode ?? (editAgent.skipPermissions ? 'auto' : 'normal'));
        setEffort(editAgent.effort || 'medium');
        if ((editAgent.provider || 'claude') !== provider) {
          skipNextSkillsClear.current = true;
        }
        setProvider(editAgent.provider || 'claude');
        setLocalModel(editAgent.localModel || '');
        setSelectedObsidianVaults(editAgent.obsidianVaultPaths || []);
        setIsOrchestrator(editAgent.orchestratorMode || false);
        setCliPath(editAgent.cliPath || '');
        setDetectedVault(null);
      } else {
        // Create mode: reset everything
        setStep(initialStep || 1);
        setSelectedProject(initialProjectPath || '');
        setCustomPath('');
        setSelectedSkills([]);
        setPrompt('');
        setUseWorktree(false);
        setBranchName('');
        setShowSecondaryProject(false);
        setSelectedSecondaryProject('');
        setCustomSecondaryPath('');
        setPermissionMode('normal');
        setEffort('medium');
        setProvider('claude');
        setModel('default');
        setLocalModel('');
        setCliPath('');
        setSelectedObsidianVaults([]);
        setDetectedVault(null);
        setAppliedTemplateId(null);

        if (initialOrchestrator) {
          agentPersonaRef.current = { character: 'wizard', name: 'Super Agent (Orchestrator)' };
          setPermissionMode('bypass');
          setIsOrchestrator(true);
        } else {
          agentPersonaRef.current = { character: 'robot', name: '' };
          setPermissionMode('normal');
          setIsOrchestrator(false);
        }
      }

      // Load app settings (Tasmania, favorites, default project)
      window.electronAPI?.appSettings?.get().then((settings) => {
        setTasmaniaEnabled(settings?.tasmaniaEnabled || false);
        if (Array.isArray(settings?.favoriteProjects)) {
          setFavoriteProjects(settings.favoriteProjects);
        }
        if (Array.isArray(settings?.hiddenProjects)) {
          setHiddenProjects(settings.hiddenProjects);
        }
        // Store default project path for sorting
        if (settings?.defaultProjectPath) {
          setDefaultProjectPath(settings.defaultProjectPath);
        }
        // Auto-select default project if no project pre-selected
        if (!initialProjectPath && !editAgent && settings?.defaultProjectPath) {
          setSelectedProject(settings.defaultProjectPath);
        }
      });

      // Load registered obsidian vaults
      window.electronAPI?.obsidian?.getVaultInfo().then((info) => {
        setRegisteredVaults(info?.vaultPaths || []);
      });

      // Detect installed CLI providers + API key availability + whether the
      // local Ollama server answers (it has neither a binary nor a key).
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

      // Fetch per-provider installed skills
      window.electronAPI?.skill?.listInstalledAll().then((byProvider) => {
        if (byProvider) setInstalledSkillsByProvider(byProvider);
      });

      // Templates may have been created/deleted elsewhere since page load
      refreshTemplates();
    }
  }, [open, initialProjectPath, initialStep, editAgent, initialOrchestrator, refreshTemplates]);

  // Clear selected skills when the USER changes provider - not when edit-mode
  // prepopulation does (that would wipe the agent's saved skills on open).
  //
  // The skipNextSkillsClear flag alone was not enough: it is only armed when the
  // edited agent's provider DIFFERS from the one in state, so editing a Claude
  // agent while the form already said "claude" armed nothing, and this effect's
  // own mount run cleared the skills that the reset effect had just restored.
  // Tracking the previous value makes the first run a no-op, which is the only
  // run that was ever wrong.
  const previousProvider = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousProvider.current;
    previousProvider.current = provider;
    if (previous === null) return;
    if (skipNextSkillsClear.current) {
      skipNextSkillsClear.current = false;
      return;
    }
    setSelectedSkills([]);
  }, [provider]);

  // Detect Obsidian vault when project path changes
  useEffect(() => {
    if (!projectPath || !open) return;
    window.electronAPI?.obsidian?.detectVault(projectPath).then(async (result) => {
      if (result?.detected && result.vaultPath) {
        setDetectedVault(result.vaultPath);
        // Auto-register if not already registered
        if (!registeredVaults.includes(result.vaultPath)) {
          await window.electronAPI?.obsidian?.addVault(result.vaultPath);
          setRegisteredVaults(prev => [...prev, result.vaultPath!]);
        }
        // Auto-select the detected vault
        setSelectedObsidianVaults(prev =>
          prev.includes(result.vaultPath!) ? prev : [...prev, result.vaultPath!]
        );
      } else {
        setDetectedVault(null);
      }
    });
  }, [projectPath, open, registeredVaults]);

  // Stable callbacks for child components
  const handleSelectProject = useCallback((path: string) => {
    setSelectedProject(path);
    setCustomPath('');
  }, []);

  const handleCustomPathChange = useCallback((path: string) => {
    setCustomPath(path);
    setSelectedProject('');
  }, []);

  const handleToggleSecondary = useCallback(() => {
    setShowSecondaryProject(prev => !prev);
  }, []);

  const handleSelectSecondaryProject = useCallback((path: string) => {
    setSelectedSecondaryProject(path);
    setCustomSecondaryPath('');
  }, []);

  const handleCustomSecondaryPathChange = useCallback((path: string) => {
    setCustomSecondaryPath(path);
    setSelectedSecondaryProject('');
  }, []);

  const handleClearSecondary = useCallback(() => {
    setSelectedSecondaryProject('');
    setCustomSecondaryPath('');
  }, []);

  const toggleSkill = useCallback((skillName: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillName) ? prev.filter((s) => s !== skillName) : [...prev, skillName]
    );
  }, []);

  const handleOrchestratorToggle = useCallback((enabled: boolean) => {
    setIsOrchestrator(enabled);
    if (enabled) {
      setPermissionMode('auto');
      agentPersonaRef.current = { ...agentPersonaRef.current, character: 'wizard' };
    } else {
      // Switching back must undo what the orchestrator preset forced.
      setPermissionMode('normal');
      if (agentPersonaRef.current.character === 'wizard') {
        agentPersonaRef.current = { ...agentPersonaRef.current, character: 'robot' };
      }
    }
  }, []);

  // Prefill the whole form from a template. Arms skipNextSkillsClear when the
  // provider changes so the provider-change effect doesn't wipe the template's
  // skills (same contract as edit-mode prepopulation).
  const applyTemplate = useCallback((t: AgentTemplate) => {
    if (t.provider !== provider) skipNextSkillsClear.current = true;
    setProvider(t.provider);
    setModel(t.model || 'default');
    setLocalModel(t.localModel || '');
    setCliPath('');
    setPermissionMode(t.permissionMode);
    setEffort(t.effort || 'medium');
    setSelectedSkills(t.skills || []);
    setSelectedObsidianVaults(t.obsidianVaultPaths ?? []);
    setPrompt(t.savedPrompt || '');
    agentPersonaRef.current = { character: t.character, name: t.displayName };
    setIsOrchestrator(false);
    setAppliedTemplateId(t.id);
  }, [provider]);

  const handleToggleVault = useCallback((vp: string) => {
    setSelectedObsidianVaults(prev =>
      prev.includes(vp) ? prev.filter(p => p !== vp) : [...prev, vp]
    );
  }, []);

  const handleSubmit = useCallback(() => {
    if (!projectPath) return;
    if (useWorktree && !branchName.trim()) return;

    const { character: agentCharacter, name: agentName } = agentPersonaRef.current;
    const projectName = projectPath.split('/').pop() || 'project';
    const finalName = agentName.trim() || `${CHARACTER_OPTIONS.find(c => c.id === agentCharacter)?.name || 'Agent'} on ${projectName}`;
    const secondaryPath = showSecondaryProject ? (selectedSecondaryProject || customSecondaryPath) : undefined;

    if (isEditMode && editAgent && onUpdate) {
      // Edit mode: update existing agent with all fields
      const worktreeConfig = useWorktree && !editAgent.branchName
        ? { enabled: true, branchName: branchName.trim() }
        : undefined;
      onUpdate(editAgent.id, {
        projectPath,
        skills: selectedSkills,
        secondaryProjectPath: secondaryPath || null,
        permissionMode,
        effort: effort || undefined,
        name: finalName,
        character: agentCharacter,
        model: (model && model !== 'default') ? model : null,
        provider,
        localModel: localModel || null,
        savedPrompt: prompt.trim() || null,
        obsidianVaultPaths: selectedObsidianVaults.length > 0 ? selectedObsidianVaults : [],
        worktree: worktreeConfig,
        orchestratorMode: isOrchestrator,
        cliPath: cliPath || null,
      });
      onClose();
      return;
    }

    // Create mode
    const finalPrompt = prompt.trim()
      || (selectedSkills.length > 0 ? `Use the following skills: ${selectedSkills.join(', ')}` : '');
    const worktreeConfig = useWorktree ? { enabled: true, branchName: branchName.trim() } : undefined;

    onSubmit(projectPath, selectedSkills, finalPrompt, model, worktreeConfig, agentCharacter, finalName, secondaryPath, permissionMode, provider, localModel, selectedObsidianVaults.length > 0 ? selectedObsidianVaults : undefined, effort, isOrchestrator, cliPath || undefined);

    // Reset form
    setStep(1);
    setSelectedProject('');
    setCustomPath('');
    setSelectedSkills([]);
    setPrompt('');
    setUseWorktree(false);
    setBranchName('');
    agentPersonaRef.current = { character: 'robot', name: '' };
    setShowSecondaryProject(false);
    setSelectedSecondaryProject('');
    setPermissionMode('normal');
    setEffort('medium');
    setCustomSecondaryPath('');
    setProvider('claude');
    setModel('default');
    setLocalModel('');
    setCliPath('');
    setSelectedObsidianVaults([]);
  }, [projectPath, prompt, selectedSkills, useWorktree, branchName, showSecondaryProject, selectedSecondaryProject, customSecondaryPath, model, permissionMode, effort, provider, localModel, cliPath, selectedObsidianVaults, onSubmit, isEditMode, editAgent, onUpdate, onClose]);

  // Can proceed from current step?
  const canContinue = step === 1 ? !!projectPath : true;
  const canStart = !useWorktree || !!branchName.trim();

  if (!open) return null;

  return (
    <>
      <DialogShell
        onClose={onClose}
        width={720}
        title={isEditMode ? 'Edit agent' : 'New agent'}
        subtitle={STEP_SUBTITLE[step]}
        className="[&_button:not(:disabled)]:cursor-pointer"
        footerLeft={
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        }
        footerRight={
          <>
            <Button
              variant="secondary"
              onClick={() => step > 1 && setStep(step - 1)}
              disabled={step === 1}
            >
              Back
            </Button>

            {step < 4 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!canContinue}>
                Next
              </Button>
            ) : (
              <Button variant="primary" onClick={handleSubmit} disabled={!canStart}>
                {isEditMode ? 'Save changes' : 'Start agent'}
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-5">
          <StepIndicator currentStep={step} onStepClick={setStep} />

          {step === 1 && !isEditMode && agentTemplates.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Start from a template <span className="normal-case font-normal">(optional)</span>
                </p>
                {onManageTemplates && (
                  <button
                    onClick={onManageTemplates}
                    className="text-[11px] text-primary hover:underline"
                  >
                    Manage templates
                  </button>
                )}
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {agentTemplates.map(t => {
                  const providerUnavailable = installedProviders[t.provider] === false;
                  return (
                    <Chip
                      key={t.id}
                      active={appliedTemplateId === t.id}
                      onClick={() => applyTemplate(t)}
                      disabled={providerUnavailable}
                      title={providerUnavailable
                        ? `${t.displayName}: provider "${t.provider}" is not installed/configured`
                        : t.description}
                      className="shrink-0 whitespace-nowrap"
                    >
                      <span>{t.icon}</span>
                      {t.displayName}
                    </Chip>
                  );
                })}
              </div>
            </div>
          )}

          {step === 1 && (
            <StepProject
              projects={projects}
              projectPath={projectPath}
              selectedProject={selectedProject}
              customPath={customPath}
              onSelectProject={handleSelectProject}
              onCustomPathChange={handleCustomPathChange}
              onBrowseFolder={onBrowseFolder}
              showSecondaryProject={showSecondaryProject}
              onToggleSecondary={handleToggleSecondary}
              selectedSecondaryProject={selectedSecondaryProject}
              onSelectSecondaryProject={handleSelectSecondaryProject}
              customSecondaryPath={customSecondaryPath}
              onCustomSecondaryPathChange={handleCustomSecondaryPathChange}
              onClearSecondary={handleClearSecondary}
              favoriteProjects={favoriteProjects}
              hiddenProjects={hiddenProjects}
              defaultProjectPath={defaultProjectPath}
            />
          )}

          {step === 2 && (
            <StepModel
              provider={provider}
              onProviderChange={setProvider}
              model={model}
              onModelChange={setModel}
              localModel={localModel}
              onLocalModelChange={setLocalModel}
              cliPath={cliPath}
              onCliPathChange={setCliPath}
              tasmaniaEnabled={tasmaniaEnabled}
              installedProviders={installedProviders}
              /* The effort ladder moved from the Task step to this step, but
                 these two props stayed behind on StepTask. StepModel then fell
                 back to its own default ("medium") with no change handler, so
                 the chips rendered enabled and every click was a no-op: effort
                 could not be changed, in create or in edit mode. */
              effort={effort}
              onEffortChange={setEffort}
              agentPersonaRef={agentPersonaRef}
              projectPath={projectPath}
            />
          )}

          {step === 3 && (
            <StepTools
              selectedSkills={selectedSkills}
              onToggleSkill={toggleSkill}
              allInstalledSkills={allInstalledSkills}
              installedSkillSet={installedSkillSet}
              onInstallSkill={skillInstall.handleInstallSkill}
              provider={provider}
              installedSkillsByProvider={installedSkillsByProvider}
              /* The toggle was handed to StepTask, which stopped rendering it
                 when the wizard was split into steps. StepTools is the step
                 that draws it, so nothing reached the screen and no agent
                 could be made an orchestrator from the UI. */
              isOrchestrator={isOrchestrator}
              onOrchestratorToggle={handleOrchestratorToggle}
            />
          )}

          {step === 4 && (
            <StepTask
              prompt={prompt}
              onPromptChange={setPrompt}
              selectedSkills={selectedSkills}
              useWorktree={useWorktree}
              onToggleWorktree={() => setUseWorktree(prev => !prev)}
              worktreeLocked={isEditMode && !!editAgent?.branchName}
              branchName={branchName}
              onBranchNameChange={setBranchName}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              /* Read-only here: the Task step only prints effort in its summary
                 line, the ladder itself lives on the Model step. */
              effort={effort}
              projectPath={projectPath}
              provider={provider}
              model={model}
            />
          )}
        </div>
      </DialogShell>

      {/* Skill installation terminal - its own overlay. It used to be nested
          inside the wizard's scrim; now that the wizard is a DialogShell at
          z-70 the terminal's own z-60 would land underneath it, so the wrapper
          lifts the whole group above the dialog. */}
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
