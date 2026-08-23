'use client';

import { useEffect, useMemo, useState } from 'react';
import { useElectronSkills } from '@/hooks/useElectron';
import { useElectronTemplates } from '@/hooks/useElectronTemplates';
import type { AgentTemplate, AgentTemplateInput } from '@/types/electron';
import { BrandSpinner, Button, DialogShell, Input, MetaChip } from '@/components/ui';
import { InstantiateDialog } from './InstantiateDialog';
import { TemplateFormDialog } from './TemplateFormDialog';
import { ImportDialog } from './ImportDialog';

interface TemplatesManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

/** `built-in` until the user touches it, then `customised`; anything they made is `yours`. */
function templateOrigin(template: AgentTemplate): string {
  if (!template.builtin) return 'yours';
  return template.overridden ? 'customised' : 'built-in';
}

export function TemplatesManagerDialog({ open, onClose }: TemplatesManagerDialogProps) {
  const { builtinTemplates, userTemplates, isLoading, refresh: refreshTemplates, create, update, remove, duplicate, exportTemplates, importTemplates } = useElectronTemplates();
  const { installedSkills } = useElectronSkills();

  const [instantiateTarget, setInstantiateTarget] = useState<AgentTemplate | null>(null);
  const [editTarget, setEditTarget] = useState<AgentTemplate | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [query, setQuery] = useState('');

  const hasNestedDialog = !!instantiateTarget || !!editTarget || showCreate || showImport;

  // Built-ins first, then the user's own - one list, no section headings.
  const templates = useMemo(
    () => [...builtinTemplates, ...userTemplates],
    [builtinTemplates, userTemplates],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(t =>
      t.displayName.toLowerCase().includes(q)
      || t.description.toLowerCase().includes(q)
      || t.tags.some(tag => tag.toLowerCase().includes(q)),
    );
  }, [templates, query]);

  const customisedCount = builtinTemplates.filter(t => t.overridden).length;

  useEffect(() => {
    if (!open) return;
    // The dialog stays mounted on the Agents page, so refetch on every open -
    // templates saved elsewhere (e.g. "Save as template" on a card) must show.
    refreshTemplates();
  }, [open, refreshTemplates]);

  if (!open) return null;

  async function handleCreate(input: AgentTemplateInput) {
    const result = await create(input);
    return { success: result.success, error: result.error };
  }

  async function handleUpdate(input: AgentTemplateInput) {
    if (!editTarget) return { success: false, error: 'No template selected' };
    const result = await update({ id: editTarget.id, ...input });
    return { success: result.success, error: result.error };
  }

  async function handleDelete(template: AgentTemplate) {
    if (!confirm(`Delete template "${template.displayName}"? This cannot be undone.`)) return;
    await remove(template.id);
  }

  async function handleReset(template: AgentTemplate) {
    if (!confirm(`Reset "${template.displayName}" to its default settings?`)) return;
    await remove(template.id);
  }

  async function handleDuplicate(template: AgentTemplate) {
    await duplicate(template.id);
  }

  async function handleExport(template: AgentTemplate) {
    const result = await exportTemplates([template.id]);
    if (!result.success || !result.payload) return;
    const filename = `${template.displayName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'template'}.dorothy-template.json`;
    const blob = new Blob([JSON.stringify(result.payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Escape and the scrim close the manager - but only when no nested dialog is
  // open, otherwise both layers would go on one keypress.
  const closeIfTopmost = () => { if (!hasNestedDialog) onClose(); };

  return (
    <>
      <DialogShell
        width={760}
        onClose={closeIfTopmost}
        title="Agent templates"
        subtitle="Pick a role, point it at a project, get an agent. No setup required."
        footerLeft={
          <span className="font-mono text-[11px] text-muted-foreground">
            {templates.length} {templates.length === 1 ? 'template' : 'templates'} · {customisedCount} customised
          </span>
        }
        footerRight={<Button size="md" onClick={onClose}>Close</Button>}
      >
        <div className="flex items-center gap-2 mb-3">
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="search templates"
            className="flex-1"
          />
          <Button size="md" variant="secondary" onClick={() => setShowImport(true)}>Import</Button>
          <Button size="md" variant="primary" onClick={() => setShowCreate(true)}>+ New template</Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <BrandSpinner size={14} className="mr-2" />
            Loading templates
          </div>
        ) : visible.length === 0 ? (
          <p className="py-16 text-center text-xs text-muted-foreground">
            {templates.length === 0
              ? 'No templates yet. Duplicate a built-in role to customise it, or create a blank one.'
              : 'Nothing matches that.'}
          </p>
        ) : (
          /* Rows share their edges - without the pull-up every seam is 2px. */
          <div className="flex flex-col -space-y-px">
            {visible.map(t => (
              <div
                key={t.id}
                className="flex items-center gap-3 border border-border bg-card px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] text-foreground truncate">{t.displayName}</span>
                    <MetaChip>{templateOrigin(t)}</MetaChip>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
                    {t.description || [t.provider, t.model].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0 font-mono lowercase">
                  <Button size="sm" variant="ghost" onClick={() => setInstantiateTarget(t)}>use</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditTarget(t)}>edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => handleDuplicate(t)}>duplicate</Button>
                  <Button size="sm" variant="ghost" onClick={() => handleExport(t)}>export</Button>
                  {t.builtin
                    ? t.overridden && <Button size="sm" variant="ghost" onClick={() => handleReset(t)}>reset</Button>
                    : <Button size="sm" variant="ghost" onClick={() => handleDelete(t)}>delete</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogShell>

      {instantiateTarget && (
        <InstantiateDialog
          template={instantiateTarget}
          onClose={() => setInstantiateTarget(null)}
          onCreated={() => { setInstantiateTarget(null); onClose(); }}
        />
      )}

      {showCreate && (
        <TemplateFormDialog
          installedSkills={installedSkills}
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}

      {editTarget && (
        <TemplateFormDialog
          initialTemplate={editTarget}
          installedSkills={installedSkills}
          onClose={() => setEditTarget(null)}
          onSubmit={handleUpdate}
        />
      )}

      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onImport={importTemplates}
        />
      )}
    </>
  );
}
