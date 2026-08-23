'use client';

import { useState, useEffect } from 'react';
import { Button, DialogShell, Input, Select, Textarea } from '@/components/ui';
import type { KanbanTaskCreate } from '@/types/kanban';
import { isElectron } from '@/hooks/useElectron';

interface NewTaskModalProps {
  onClose: () => void;
  onCreate: (data: KanbanTaskCreate) => Promise<void>;
}

interface Project {
  path: string;
  name: string;
  lastModified?: string;
}

/** Field captions, on the same 10px uppercase rhythm as `PanelCaption`. */
const CAPTION = 'block mb-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground';

/**
 * One task, four fields.
 *
 * The dialog used to open on a Quick/Manual tab pair - two solid-orange pills
 * competing with the Create button underneath - and the Manual side then asked
 * for a priority, a skill list, a label list and a file tray before it would
 * take a title. A task is a sentence and where it goes; everything else is the
 * board's job once an agent picks it up.
 */
export function NewTaskModal({ onClose, onCreate }: NewTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tag, setTag] = useState('');
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load projects + hidden + default project. The favourite badges above the
  // dropdown are gone, but favourites still rank the list.
  useEffect(() => {
    const loadProjects = async () => {
      if (isElectron() && window.electronAPI?.fs?.listProjects) {
        const rawProjects = await window.electronAPI.fs.listProjects();
        // Filter out worktree paths to avoid duplicate React keys
        const projectList = rawProjects.filter((p: Project) => !p.path.includes('/.worktrees/'));

        const settings = await window.electronAPI?.appSettings?.get();
        const hidden: string[] = Array.isArray(settings?.hiddenProjects) ? settings.hiddenProjects : [];

        // Filter out hidden projects
        const favorites: string[] = Array.isArray(settings?.favoriteProjects) ? settings.favoriteProjects : [];
        const defaultPath = settings?.defaultProjectPath || '';
        const visibleProjects = projectList
          .filter((p: Project) => !hidden.includes(p.path))
          .sort((a: Project, b: Project) => {
            const aRank = a.path === defaultPath ? 0 : favorites.includes(a.path) ? 1 : 2;
            const bRank = b.path === defaultPath ? 0 : favorites.includes(b.path) ? 1 : 2;
            return aRank - bRank;
          });
        setProjects(visibleProjects);

        // Use default project if set, otherwise first visible project
        if (settings?.defaultProjectPath && visibleProjects.some((p: Project) => p.path === settings.defaultProjectPath)) {
          setSelectedProjectPath(settings.defaultProjectPath);
        } else if (visibleProjects.length > 0) {
          setSelectedProjectPath(visibleProjects[0].path);
        }
      }
    };
    loadProjects();
  }, []);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    if (!title.trim() || !selectedProjectPath || isSubmitting) {
      return;
    }

    setIsSubmitting(true);

    try {
      const projectId = selectedProjectPath.replace(/[^a-zA-Z0-9]/g, '-');

      await onCreate({
        title: title.trim(),
        description: description.trim(),
        projectId,
        projectPath: selectedProjectPath,
        labels: tag.trim() ? [tag.trim()] : [],
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DialogShell
      onClose={onClose}
      title="New task"
      subtitle="It goes to the Hermes board. An agent picks it up from there."
      footerRight={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!title.trim() || !selectedProjectPath || isSubmitting}
            onClick={() => handleSubmit()}
          >
            {isSubmitting ? 'Creating...' : 'Create task'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={CAPTION} htmlFor="new-task-title">Title</label>
          <Input
            id="new-task-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            autoFocus
          />
        </div>

        <div>
          <label className={CAPTION} htmlFor="new-task-detail">Detail</label>
          <Textarea
            id="new-task-detail"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detailed instructions for the agent..."
            rows={4}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={CAPTION} htmlFor="new-task-project">Project</label>
            <Select
              id="new-task-project"
              value={selectedProjectPath}
              onChange={(e) => setSelectedProjectPath(e.target.value)}
            >
              {projects.length === 0 && <option value="">Select a project</option>}
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className={CAPTION} htmlFor="new-task-tag">Tag</label>
            <Input
              id="new-task-tag"
              type="text"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="bug, feature"
            />
          </div>
        </div>

        {/* The footer owns the submit; this only keeps Enter working in a field. */}
        <button type="submit" className="hidden" />
      </form>
    </DialogShell>
  );
}
