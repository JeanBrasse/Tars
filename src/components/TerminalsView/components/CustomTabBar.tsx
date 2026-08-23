'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { CustomTab, ActiveTab } from '../types';

interface CustomTabBarProps {
  tabs: CustomTab[];
  activeTab: ActiveTab;
  onSelectTab: (tabId: string) => void;
  onCreateTab: (name: string) => void;
  /** Project folders that have agents - offered as one-click boards. */
  projectGroups?: { name: string; path: string; agentIds: string[] }[];
  onCreateFromProject?: (name: string, agentIds: string[]) => void;
  onDeleteTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  onReorderTabs: (fromIndex: number, toIndex: number) => void;
}

export default function CustomTabBar({
  tabs,
  activeTab,
  onSelectTab,
  onCreateTab,
  projectGroups,
  onCreateFromProject,
  onDeleteTab,
  onRenameTab,
  onReorderTabs,
}: CustomTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createName, setCreateName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createDialogRef = useRef<HTMLDivElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Focus create input when dialog opens
  useEffect(() => {
    if (showCreateDialog && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [showCreateDialog]);

  // Close create dialog on click outside
  useEffect(() => {
    if (!showCreateDialog) return;
    const handler = (e: MouseEvent) => {
      if (createDialogRef.current && !createDialogRef.current.contains(e.target as Node)) {
        setShowCreateDialog(false);
        setCreateName('');
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [showCreateDialog]);

  const startEditing = useCallback((tab: CustomTab) => {
    setEditingId(tab.id);
    setEditValue(tab.name);
  }, []);

  const commitEdit = useCallback(() => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim());
    }
    setEditingId(null);
  }, [editingId, editValue, onRenameTab]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') cancelEdit();
  }, [commitEdit, cancelEdit]);

  const handleCreateSubmit = useCallback(() => {
    const name = createName.trim();
    if (name) {
      onCreateTab(name);
    }
    setShowCreateDialog(false);
    setCreateName('');
  }, [createName, onCreateTab]);

  const handleCreateKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreateSubmit();
    else if (e.key === 'Escape') {
      setShowCreateDialog(false);
      setCreateName('');
    }
  }, [handleCreateSubmit]);

  // Drag handlers for reorder
  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIdx: number) => {
    e.preventDefault();
    if (dragIdx !== null && dragIdx !== toIdx) {
      onReorderTabs(dragIdx, toIdx);
    }
    setDragIdx(null);
    setDragOverIdx(null);
  }, [dragIdx, onReorderTabs]);

  const handleDragEnd = useCallback(() => {
    setDragIdx(null);
    setDragOverIdx(null);
  }, []);

  const isActive = (tabId: string) =>
    activeTab.type === 'custom' && activeTab.tabId === tabId;

  // same strip as ProjectTabBar - 40px tall, one full-width hairline the active
  // tab's fill breaks. The two bars have to be indistinguishable.
  return (
    <div className="relative flex items-end h-10 [&_button]:cursor-pointer">
      {/* full-width hairline; the active tab's fill breaks it */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-border" />

      <div className="relative flex items-end gap-0.5 h-full flex-1 overflow-x-auto scrollbar-none">
        {tabs.map((tab, idx) => (
          <div
            key={tab.id}
            draggable={editingId !== tab.id}
            onDragStart={e => handleDragStart(e, idx)}
            onDragOver={e => handleDragOver(e, idx)}
            onDrop={e => handleDrop(e, idx)}
            onDragEnd={handleDragEnd}
            className={`
              flex items-center gap-1.5 h-full px-3 text-xs whitespace-nowrap transition-colors shrink-0 cursor-pointer group
              ${isActive(tab.id)
                ? 'bg-card border border-border border-b-transparent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }
              ${dragOverIdx === idx && dragIdx !== idx ? 'border-l border-l-border-accent' : ''}
            `}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={e => { e.stopPropagation(); startEditing(tab); }}
          >
            {editingId === tab.id ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={handleKeyDown}
                onClick={e => e.stopPropagation()}
                className="bg-transparent text-xs text-foreground outline-none border-b border-border w-[80px]"
                maxLength={20}
              />
            ) : (
              <span>{tab.name}</span>
            )}

            {/* Agent count badge */}
            <span className="text-[10px] text-muted-foreground">{tab.agentIds.length}</span>

            {/* Delete button */}
            <button
              onClick={e => { e.stopPropagation(); onDeleteTab(tab.id); }}
              className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 transition-all text-muted-foreground hover:text-destructive"
              title="Delete board"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Create tab button + dialog - outside the scroller so the popover is not clipped */}
      <div className="relative shrink-0">
        <button
          onClick={() => { setShowCreateDialog(true); setCreateName(''); }}
          className="flex items-center h-8 px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="Create new board"
        >
          + board
        </button>

        {showCreateDialog && (
          <div
            ref={createDialogRef}
            className="absolute top-full right-0 mt-1 bg-card border border-border z-50 p-3 min-w-[260px]"
          >
            {projectGroups && projectGroups.length > 0 && onCreateFromProject && (
              <div className="mb-3">
                <p className="text-xs text-muted-foreground mb-1.5">From a project - board named after it, agents included</p>
                <div className="max-h-40 overflow-y-auto space-y-0.5">
                  {projectGroups.map(g => (
                    <button
                      key={g.path}
                      onClick={() => { onCreateFromProject(g.name, g.agentIds); setShowCreateDialog(false); setCreateName(''); }}
                      className="w-full flex items-center justify-between h-8 px-2 text-xs text-foreground hover:bg-secondary transition-colors"
                    >
                      <span className="truncate">{g.name}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0 ml-2">{g.agentIds.length} agent{g.agentIds.length > 1 ? 's' : ''}</span>
                    </button>
                  ))}
                </div>
                <div className="border-t border-border mt-2 pt-2" />
              </div>
            )}
            <p className="text-xs text-muted-foreground mb-2">Empty board</p>
            <input
              ref={createInputRef}
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              onKeyDown={handleCreateKeyDown}
              placeholder="e.g. Frontend, Backend..."
              className="w-full h-8 px-2 bg-secondary border border-border text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary mb-2"
              maxLength={20}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => { setShowCreateDialog(false); setCreateName(''); }}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleCreateSubmit} disabled={!createName.trim()}>
                Create
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
