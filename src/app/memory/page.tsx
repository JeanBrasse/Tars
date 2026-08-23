'use client';

import { useState, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useMemory, formatBytes, timeAgo } from '@/hooks/useMemory';
import type { ProjectMemory, MemoryFile } from '@/types/electron';
import AgentKnowledgeGraph from '@/components/Memory/AgentKnowledgeGraph';
import { getProviderDef } from '@/lib/providers';
import {
  Button,
  DialogShell,
  Input,
  PageHeader,
  Panel,
  PanelCaption,
  SegmentedControl,
  StatusBadge,
  StatusSquare,
} from '@/components/ui';

type Tab = 'projects' | 'agents' | 'backends';

const TABS = [
  { value: 'projects' as const, label: 'Projects' },
  { value: 'agents' as const, label: 'Agents' },
  { value: 'backends' as const, label: 'Backends' },
];

// ─── File pane (always editable) ────────────────────────────────────────────

/**
 * The right pane. There is no view/edit toggle any more: the file is open, and
 * the three words at the top of it are everything you can do to it. Mount it
 * with `key={file.path}` - the draft lives here.
 */
function FilePane({
  file,
  saving,
  deleting,
  onSave,
  onNewFile,
  onDelete,
}: {
  file: MemoryFile;
  saving: boolean;
  deleting: boolean;
  onSave: (content: string) => void;
  onNewFile: () => void;
  onDelete: () => void;
}) {
  const [content, setContent] = useState(file.content);
  const dirty = content !== file.content;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border shrink-0">
        <span className="font-mono text-xs text-foreground truncate">
          {file.name}
          {dirty && <span className="text-warning"> •</span>}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" className="font-mono" onClick={() => onSave(content)} disabled={!dirty || saving}>
            save
          </Button>
          <Button size="sm" className="font-mono" onClick={onNewFile}>
            new file
          </Button>
          <Button
            size="sm"
            className="font-mono"
            onClick={onDelete}
            disabled={file.isEntrypoint || deleting}
            title={file.isEntrypoint ? 'The entrypoint file cannot be deleted' : undefined}
          >
            delete
          </Button>
        </div>
      </div>
      <textarea
        className="flex-1 w-full resize-none bg-card font-mono text-xs leading-relaxed p-3 focus:outline-none text-foreground"
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

// ─── Project row ─────────────────────────────────────────────────────────────

function ProjectRow({
  project,
  isSelected,
  activeAgents,
  onClick,
}: {
  project: ProjectMemory;
  isSelected: boolean;
  activeAgents: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-2 border transition-colors ${isSelected
        ? 'bg-secondary border-border-accent text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'
        }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium truncate">{project.projectName}</span>
          {project.provider && project.provider !== 'claude' && (
            <span className={`text-[9px] px-1 py-0.5 font-medium uppercase tracking-wider shrink-0 ${
              getProviderDef(project.provider)?.badgeClass ?? 'bg-secondary text-muted-foreground'
            }`}>
              {project.provider}
            </span>
          )}
        </div>
        {activeAgents > 0 && (
          <span className="flex items-center gap-1 shrink-0 font-mono text-[10px] text-status-running">
            <StatusSquare tone="running" />
            {activeAgents}
          </span>
        )}
      </div>
      {/* The counts the stats bar used to hold, on the row they belong to. */}
      <p className="mt-1 font-mono text-[10px] text-muted-foreground truncate">
        {project.hasMemory
          ? `${project.files.length} files · ${formatBytes(project.totalSize)} · ${timeAgo(project.lastModified)}`
          : 'no memory yet'}
      </p>
    </button>
  );
}

// ─── New file dialog ─────────────────────────────────────────────────────────

function NewFileDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <DialogShell
      onClose={onClose}
      title="New memory file"
      subtitle="A topic file beside MEMORY.md. .md is appended automatically."
      footerRight={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        mono
        placeholder="e.g. debugging or api-conventions"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose(); }}
      />
    </DialogShell>
  );
}

// ─── Shared memory backends (gbrain / Honcho) status ───────────────────────

interface SourceStatus {
  id: string;
  label: string;
  configured: boolean;
  reachable: boolean;
  detail: string;
  tools?: string[];
}

/** Probing state and the Re-check action both live on the page - the header owns them. */
function BackendsTab({ sources }: { sources: SourceStatus[] | null }) {
  if (!sources) {
    return (
      <div className="flex items-center justify-center py-16 text-xs text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Probing memory sources…
      </div>
    );
  }

  return (
    <Panel fill className="flex-1 min-h-0">
      <p className="text-xs text-muted-foreground shrink-0">
        Each source below was contacted just now. Every agent reaches them through the
        memory tools, whatever CLI it runs.
      </p>
      <div className="flex-1 min-h-0 overflow-y-auto mt-3 space-y-3">
        {sources.map(s => {
          const tone = !s.configured ? 'idle' : s.reachable ? 'running' : 'error';
          const state = !s.configured ? 'not configured' : s.reachable ? 'reachable' : 'unreachable';
          return (
            <div key={s.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusSquare tone={tone} />
                  <span className="text-xs font-medium text-foreground">{s.label}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground font-mono break-all">{s.detail}</p>
                {s.tools && s.tools.length > 0 && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground font-mono break-all">
                    tools: {s.tools.join(', ')}
                  </p>
                )}
              </div>
              <StatusBadge tone={tone} className="shrink-0 font-mono">{state}</StatusBadge>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function MemoryPage() {
  const {
    filteredProjects,
    agentCountByPath,
    selectedProject,
    selectedFile,
    loading,
    saving,
    error,
    isElectron,
    selectProject,
    selectFile,
    saveFile,
    createFile,
    deleteFile,
    refresh,
  } = useMemory();

  const [activeTab, setActiveTab] = useState<Tab>('projects');
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  // Remounting the canvas is how the graph re-reads; it owns its own fetch.
  const [graphKey, setGraphKey] = useState(0);

  // ── Backends probe: hoisted so the page header can carry the Re-check ──
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const projectPath = selectedProject?.projectPath;

  const probeSources = useCallback(async () => {
    setChecking(true);
    try {
      const res = await window.electronAPI?.memoryHub?.sources(projectPath);
      setSources(res?.sources ?? []);
    } catch {
      setSources([]);
    } finally {
      setChecking(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (activeTab !== 'backends') return;
    void probeSources();
  }, [activeTab, probeSources]);

  const handleDelete = useCallback(async (filePath: string) => {
    setDeletingFile(filePath);
    await deleteFile(filePath);
    setDeletingFile(null);
  }, [deleteFile]);

  const handleCreateFile = useCallback(async (name: string) => {
    if (!selectedProject) return;
    setShowNewFileDialog(false);
    await createFile(selectedProject.memoryDir, name);
  }, [selectedProject, createFile]);

  if (!isElectron) {
    return (
      <div className="flex items-center justify-center h-[60vh] text-center">
        <p className="text-sm text-muted-foreground">Memory is only available in the desktop app.</p>
      </div>
    );
  }

  // Exactly one action, whichever tab is open.
  const headerAction = activeTab === 'backends' ? (
    <Button onClick={probeSources} disabled={checking}>Re-check</Button>
  ) : activeTab === 'agents' ? (
    <Button onClick={() => setGraphKey(k => k + 1)}>Refresh</Button>
  ) : (
    <Button onClick={refresh} disabled={loading}>Refresh</Button>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] pt-[22px] overflow-hidden">

      <PageHeader
        title="Brain"
        subtitle="What your agents know — native project memory plus shared backends (gbrain, Honcho)."
        actions={headerAction}
      />

      {/* ── Tabs ── */}
      <div className="mb-3 shrink-0">
        <SegmentedControl
          options={TABS}
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel="Brain section"
        />
      </div>

      {/* ── Agents graph tab ── */}
      {activeTab === 'agents' && (
        <div className="flex-1 min-h-0">
          <AgentKnowledgeGraph key={graphKey} />
        </div>
      )}

      {/* ── Shared backends tab ── */}
      {activeTab === 'backends' && <BackendsTab sources={sources} />}

      {/* ── Projects tab content ── */}
      {activeTab === 'projects' && <>

        {/* ── Error ── */}
        {error && (
          <div className="mb-3 p-3 bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2 shrink-0">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* ── Three panels ── */}
        <div className="flex-1 flex gap-2 min-h-0">

          {/* ── Left: projects ── */}
          <Panel fill className="w-56 lg:w-64 shrink-0">
            <PanelCaption className="shrink-0">Projects with memory</PanelCaption>
            <div className="flex-1 overflow-y-auto mt-2">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : filteredProjects.length === 0 ? (
                <div className="px-1 py-8 text-center">
                  <p className="text-xs text-muted-foreground">No Claude projects found</p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Memory is created automatically as you work with Claude Code
                  </p>
                </div>
              ) : (
                <motion.div
                  initial="hidden"
                  animate="visible"
                  variants={{
                    visible: { transition: { staggerChildren: 0.04 } },
                    hidden: {},
                  }}
                >
                  {filteredProjects.map((project) => (
                    <motion.div
                      key={project.id}
                      variants={{
                        hidden: { opacity: 0, x: -8 },
                        visible: { opacity: 1, x: 0 },
                      }}
                    >
                      <ProjectRow
                        project={project}
                        isSelected={selectedProject?.id === project.id}
                        activeAgents={agentCountByPath.get(project.projectPath) ?? 0}
                        onClick={() => selectProject(project)}
                      />
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </div>
          </Panel>

          {/* ── Middle: files ── */}
          <Panel fill className="w-44 lg:w-52 shrink-0">
            <PanelCaption className="shrink-0">
              {selectedProject ? `${selectedProject.files.length} files` : 'Files'}
            </PanelCaption>
            <div className="flex-1 overflow-y-auto mt-2">
              {!selectedProject ? (
                <p className="px-1 py-8 text-center text-xs text-muted-foreground">Select a project</p>
              ) : !selectedProject.hasMemory ? (
                <p className="px-1 py-8 text-center text-xs text-muted-foreground">No memory files yet</p>
              ) : (
                selectedProject.files.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => selectFile(file)}
                    className={`w-full text-left px-2 py-1.5 border transition-colors ${selectedFile?.path === file.path
                      ? 'bg-secondary border-border-accent text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'
                      }`}
                  >
                    <span className="block text-xs font-mono truncate">{file.name}</span>
                    {file.isEntrypoint && (
                      <span className="block text-[10px] text-muted-foreground mt-0.5">entrypoint</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </Panel>

          {/* ── Right: file ── */}
          <Panel fill padded={false} className="flex-1 min-w-0">
            {selectedFile ? (
              <FilePane
                key={selectedFile.path}
                file={selectedFile}
                saving={saving}
                deleting={deletingFile === selectedFile.path}
                onSave={(content) => { void saveFile(selectedFile.path, content); }}
                onNewFile={() => setShowNewFileDialog(true)}
                onDelete={() => handleDelete(selectedFile.path)}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
                <p className="text-sm text-muted-foreground">
                  {selectedProject
                    ? 'Select a memory file to read or edit'
                    : 'Select a project to explore its memory'}
                </p>
                {selectedProject && (
                  <Button size="sm" className="font-mono" onClick={() => setShowNewFileDialog(true)}>
                    new file
                  </Button>
                )}
              </div>
            )}
          </Panel>
        </div>

        {showNewFileDialog && (
          <NewFileDialog
            onConfirm={handleCreateFile}
            onClose={() => setShowNewFileDialog(false)}
          />
        )}

      </>}
    </div>
  );
}
