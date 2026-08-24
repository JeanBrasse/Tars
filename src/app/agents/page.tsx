'use client';

import { useState, useCallback, useMemo } from 'react';
import { Bot } from 'lucide-react';
import { useElectronAgents, useElectronFS, useElectronSkills, isElectron } from '@/hooks/useElectron';
import { useElectronTemplates } from '@/hooks/useElectronTemplates';
import { useClaude } from '@/hooks/useClaude';
import { useAgentFiltering } from '@/hooks/useAgentFiltering';
import { useSuperAgent } from '@/hooks/useSuperAgent';
import type { AgentCharacter, AgentProvider } from '@/types/electron';
import NewChatModal from '@/components/NewChatModal';
import type { EditAgentData, CreationMode } from '@/components/NewChatModal/types';
import AgentTerminalDialog from '@/components/AgentWorld/AgentTerminalDialog';
import { TemplatesManagerDialog } from '@/components/Templates/TemplatesManagerDialog';
import {
  DesktopRequiredMessage,
  AgentListHeader,
  AgentManagementCard,
} from '@/components/AgentList';
import { Chip, LoadingState } from '@/components/ui';
import { STATUS_COLORS } from './constants';

export default function AgentsPage() {
  const {
    agents,
    isLoading: agentsLoading,
    isElectron: hasElectron,
    createAgent,
    updateAgent,
    startAgent,
    stopAgent,
    removeAgent,
  } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();
  const { installedSkills, refresh: refreshSkills } = useElectronSkills();
  const { create: createTemplate } = useElectronTemplates();
  const { data: claudeData } = useClaude();

  // Local state
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [newChatMode, setNewChatMode] = useState<CreationMode>('agent');
  const [showTemplatesDialog, setShowTemplatesDialog] = useState(false);
  const [viewAgentId, setViewAgentId] = useState<string | null>(null);  // terminal dialog
  const [editAgentId, setEditAgentId] = useState<string | null>(null);  // edit dialog
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');


  // Custom hooks
  const { superAgent } = useSuperAgent({
    agents,
    startAgent,
    onAgentCreated: (id) => setEditAgentId(id),
    onCreateNew: () => setShowNewChatModal(true),
  });

  // No project narrowing any more: the filter field below covers it, so the
  // hook keeps its project pass-through inert.
  const { filteredAgents } = useAgentFiltering({
    agents,
    projectFilter: null,
    statusFilter,
    searchQuery,
  });

  // Build edit agent data from editAgentId
  const editAgentData: EditAgentData | null = useMemo(() => {
    if (!editAgentId) return null;
    const agent = agents.find(a => a.id === editAgentId);
    if (!agent) return null;
    return {
      id: agent.id,
      name: agent.name,
      character: agent.character,
      projectPath: agent.projectPath,
      secondaryProjectPath: agent.secondaryProjectPath,
      skills: agent.skills,
      permissionMode: agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal'),
      effort: agent.effort,
      provider: agent.provider,
      model: agent.model,
      localModel: agent.localModel,
      branchName: agent.branchName,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      savedPrompt: agent.savedPrompt,
      orchestratorMode: agent.orchestratorMode,
      cliPath: agent.cliPath,
    };
  // Snapshot on open: depending on `agents` would rebuild this object on every
  // status tick and reset the edit form mid-typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editAgentId]);

  // Handlers
  const handleCreateAgent = useCallback(async (
    projectPath: string,
    skills: string[],
    prompt: string,
    model?: string,
    worktree?: { enabled: boolean; branchName: string },
    character?: AgentCharacter,
    name?: string,
    secondaryProjectPath?: string,
    permissionMode?: 'normal' | 'auto' | 'bypass',
    provider?: AgentProvider,
    localModel?: string,
    obsidianVaultPaths?: string[],
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    orchestratorMode?: boolean,
    cliPath?: string,
  ) => {
    try {
      const resolvedModel = (provider !== 'local' && model && model !== 'default') ? model : undefined;
      const agent = await createAgent({ projectPath, skills, worktree, character, name, secondaryProjectPath, permissionMode, effort, provider, model: resolvedModel, localModel, obsidianVaultPaths, orchestratorMode, cliPath });
      if (prompt) {
        const options = { model: resolvedModel, provider, localModel };
        await startAgent(agent.id, prompt, options);
      }
      setShowNewChatModal(false);
    } catch (error) {
      console.error('Failed to create agent:', error);
      // Tells the modal not to wipe what the user typed - there is nothing to
      // resume into otherwise, since the failure never reaches the screen.
      return false;
    }
  }, [createAgent, startAgent]);

  const handleUpdateAgent = useCallback(async (id: string, updates: {
    projectPath?: string;
    skills?: string[];
    secondaryProjectPath?: string | null;
    permissionMode?: 'normal' | 'auto' | 'bypass';
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    name?: string;
    character?: AgentCharacter;
    model?: string | null;
    provider?: AgentProvider;
    localModel?: string | null;
    savedPrompt?: string | null;
    obsidianVaultPaths?: string[];
    worktree?: { enabled: boolean; branchName: string };
    orchestratorMode?: boolean;
    cliPath?: string | null;
  }) => {
    try {
      await updateAgent({ id, ...updates });
      setEditAgentId(null);
    } catch (error) {
      console.error('Failed to update agent:', error);
      return false;
    }
  }, [updateAgent]);

  const handleStartAgent = useCallback(async (agentId: string, prompt?: string) => {
    await startAgent(agentId, prompt || '');
  }, [startAgent]);

  const handleRemoveAgent = useCallback((agentId: string) => {
    removeAgent(agentId);
  }, [removeAgent]);

  const handleSaveAsTemplate = useCallback(async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;
    // window.prompt throws in Electron renderers; confirm() works. The name
    // can be edited afterwards in the Templates manager.
    const name = agent.name?.trim() || `Agent ${agent.id.slice(0, 4)}`;
    if (!window.confirm(`Save "${name}" as a template? (You can rename it in Templates.)`)) return;
    const result = await createTemplate({
      displayName: name.trim(),
      description: `Saved from agent "${agent.name ?? ''}"`.trim(),
      icon: '📦',
      character: agent.character,
      provider: agent.provider,
      model: agent.model,
      localModel: agent.localModel,
      permissionMode: agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal'),
      effort: agent.effort,
      skills: agent.skills,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      savedPrompt: agent.savedPrompt,
    });
    if (!result.success) {
      alert(`Could not save template: ${result.error ?? 'unknown error'}`);
    }
  }, [agents, createTemplate]);

  // Early returns
  if (!hasElectron && typeof window !== 'undefined') {
    return <DesktopRequiredMessage />;
  }

  if (agentsLoading && agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <LoadingState loading rows={5} what="Still loading your agents…" detail="reading ~/.dorothy/agents.json" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <AgentListHeader
        onNewAgentClick={() => { setNewChatMode('agent'); setShowNewChatModal(true); }}
        onDeployTeamClick={() => { setNewChatMode('team'); setShowNewChatModal(true); }}
        onManageTemplatesClick={() => setShowTemplatesDialog(true)}
      />

      {/* One filter row: the status chips carry their own counts, and the
          filter field on the right is what narrows by project or branch. */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Chip active={!statusFilter} onClick={() => setStatusFilter(null)}>
          All ({agents.length})
        </Chip>
        {Object.keys(STATUS_COLORS).map((key) => {
          const count = agents.filter(a => a.status === key).length;
          return (
            <Chip
              key={key}
              active={statusFilter === key}
              onClick={() => setStatusFilter(statusFilter === key ? null : key)}
              className="capitalize"
            >
              {key} ({count})
            </Chip>
          );
        })}

        <input
          type="text"
          placeholder="filter by name or branch"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="ml-auto w-full max-w-xs h-7 px-2.5 text-sm border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
        />
      </div>

      {/* Agent Grid */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {filteredAgents.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 pb-4">
            {filteredAgents.map((agent) => (
              <AgentManagementCard
                key={agent.id}
                agent={agent}
                onClick={() => setViewAgentId(agent.id)}
                onEdit={() => setEditAgentId(agent.id)}
                onStart={() => handleStartAgent(agent.id)}
                onStop={() => stopAgent(agent.id)}
                onRemove={() => handleRemoveAgent(agent.id)}
                onSaveAsTemplate={() => handleSaveAsTemplate(agent.id)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20">
            <Bot className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground text-sm mb-2">
              {agents.length === 0 ? 'No agents yet' : 'No agents match your filters'}
            </p>
            {agents.length === 0 ? (
              <button
                onClick={() => setShowNewChatModal(true)}
                className="text-primary text-sm hover:underline cursor-pointer"
              >
                Create your first agent
              </button>
            ) : (
              <button
                onClick={() => { setStatusFilter(null); setSearchQuery(''); }}
                className="text-primary text-sm hover:underline cursor-pointer"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Create Modal - opens on the agent or team half of the switch
          depending on which header button was clicked; also the whole of
          what used to be DeployTeamDialog, folded into the team half. */}
      <NewChatModal
        open={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onSubmit={handleCreateAgent}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        allInstalledSkills={claudeData?.skills || []}
        onRefreshSkills={refreshSkills}
        onManageTemplates={() => setShowTemplatesDialog(true)}
        existingSuperAgent={superAgent}
        initialMode={newChatMode}
      />

      {/* Edit Modal - reuses NewChatModal pre-filled with agent data */}
      <NewChatModal
        open={!!editAgentId}
        onClose={() => setEditAgentId(null)}
        onSubmit={handleCreateAgent}
        onUpdate={handleUpdateAgent}
        editAgent={editAgentData}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        allInstalledSkills={claudeData?.skills || []}
        onRefreshSkills={refreshSkills}
        initialStep={1}
      />

      {/* Templates manager - browse, edit, and instantiate agent templates */}
      <TemplatesManagerDialog
        open={showTemplatesDialog}
        onClose={() => setShowTemplatesDialog(false)}
      />

      {/* Terminal Dialog - click card body to view */}
      <AgentTerminalDialog
        agent={viewAgentId ? agents.find(a => a.id === viewAgentId) || null : null}
        open={!!viewAgentId}
        onClose={() => setViewAgentId(null)}
        onStart={(id, prompt) => handleStartAgent(id, prompt)}
        onStop={stopAgent}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        agents={agents}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
      />
    </div>
  );
}
