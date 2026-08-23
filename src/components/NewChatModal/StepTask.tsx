import React, { useState } from 'react';
import type { AgentProvider } from '@/types/electron';
import type { AgentPermissionMode, AgentEffort } from '@/types/agent';
import { Input, Textarea, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';

interface StepTaskProps {
  /** Agent name. Moved here from the deleted persona editor; optional until the
   *  wizard shell wires it, so this step falls back to holding it locally. */
  name?: string;
  onNameChange?: (name: string) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  selectedSkills: string[];
  useWorktree: boolean;
  branchName: string;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  effort: AgentEffort;
  // Summary data
  provider: AgentProvider;
  model: string;
  /* Accepted but no longer rendered here: the worktree switch and branch field
   * live on the Project step, the effort ladder on the Model step, and the
   * orchestrator toggle on the Tools step. They stay in the interface only so
   * the wizard shell keeps compiling until it stops passing them. */
  onToggleWorktree?: () => void;
  worktreeLocked?: boolean;
  onBranchNameChange?: (name: string) => void;
  onEffortChange?: (effort: AgentEffort) => void;
  isOrchestrator?: boolean;
  onOrchestratorToggle?: (enabled: boolean) => void;
  projectPath?: string;
}

/** "Normal" reads like a default nobody chose; the design calls it Manual. */
const PERMISSION_MODES: readonly SegmentedOption<AgentPermissionMode>[] = [
  { value: 'normal', label: 'Manual', title: 'Asks before each tool' },
  { value: 'auto',   label: 'Auto',   title: 'Autonomous - recommended' },
  { value: 'bypass', label: 'Bypass', title: 'Skips all restrictions' },
];

const StepTask = React.memo(function StepTask({
  name,
  onNameChange,
  prompt,
  onPromptChange,
  selectedSkills,
  useWorktree,
  branchName,
  permissionMode,
  onPermissionModeChange,
  effort,
  provider,
  model,
}: StepTaskProps) {
  const [localName, setLocalName] = useState(name ?? '');
  const nameValue = name ?? localName;

  // One line of facts instead of a card of labelled rows.
  const summary = [
    provider,
    model,
    effort,
    useWorktree && branchName ? branchName : null,
    selectedSkills.length > 0 ? `${selectedSkills.length} skills` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-5">
      {/* Name */}
      <div>
        <MicroLabel>Name</MicroLabel>
        <Input
          mono
          value={nameValue}
          onChange={(e) => {
            setLocalName(e.target.value);
            onNameChange?.(e.target.value);
          }}
          placeholder="Frontend Engineer"
        />
      </div>

      {/* Prompt */}
      <div>
        <MicroLabel>Task</MicroLabel>
        <Textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="Describe the task, or leave empty to start an interactive session"
          rows={4}
        />
        {selectedSkills.length > 0 && !prompt && (
          <p className="text-[11px] text-muted-foreground mt-2">
            Agent will start with selected skills: {selectedSkills.slice(0, 3).join(', ')}{selectedSkills.length > 3 ? ` +${selectedSkills.length - 3} more` : ''}
          </p>
        )}
      </div>

      {/* Permissions */}
      <div>
        <MicroLabel>Permissions</MicroLabel>
        <SegmentedControl
          options={PERMISSION_MODES}
          value={permissionMode}
          onChange={onPermissionModeChange}
          ariaLabel="Permission mode"
        />
      </div>

      {/* Summary */}
      <div className="h-8 flex items-center gap-2 px-2.5 bg-bg-tertiary">
        <span className="w-1.5 h-1.5 bg-primary shrink-0" />
        <span className="font-mono text-[11px] text-muted-foreground truncate">{summary}</span>
      </div>
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

export default StepTask;
