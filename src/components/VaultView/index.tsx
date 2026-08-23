'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '@/store';
import { Archive } from 'lucide-react';
import type { VaultDocumentElectron, VaultFolderElectron, VaultAttachmentElectron } from '@/types/electron';

import { BrandSpinner, Button, PageHeader, Panel, PanelCaption } from '@/components/ui';
import FolderTree from './components/FolderTree';
import DocumentList from './components/DocumentList';
import DocumentViewer from './components/DocumentViewer';
import DocumentEditor from './components/DocumentEditor';
import { VaultEmptyState } from './shared';

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.vault;
}

// The list no longer leaves the screen when a document opens, so the mode only
// says what the right-hand panel is showing.
type ViewMode = 'list' | 'view' | 'edit';

const READ_DOCS_KEY = 'vault-read-docs';

function loadReadDocs(): Set<string> {
  try {
    const stored = localStorage.getItem(READ_DOCS_KEY);
    if (stored) return new Set(JSON.parse(stored));
    return new Set(); // First load - will be populated after initial fetch
  } catch {
    return new Set();
  }
}

function isFirstLoad(): boolean {
  return localStorage.getItem(READ_DOCS_KEY) === null;
}

function saveReadDocs(ids: Set<string>) {
  localStorage.setItem(READ_DOCS_KEY, JSON.stringify([...ids]));
}

export default function VaultView({ embedded }: { embedded?: boolean } = {}) {
  // Data state
  const [documents, setDocuments] = useState<VaultDocumentElectron[]>([]);
  const [allDocuments, setAllDocuments] = useState<VaultDocumentElectron[]>([]);
  const [folders, setFolders] = useState<VaultFolderElectron[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<VaultDocumentElectron | null>(null);
  const [selectedDocAttachments, setSelectedDocAttachments] = useState<VaultAttachmentElectron[]>([]);
  const [readDocIds, setReadDocIds] = useState<Set<string>>(() => loadReadDocs());

  // UI state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const setVaultUnreadCount = useStore(s => s.setVaultUnreadCount);

  // Sync unread count to global store for sidebar badge
  const unreadCount = useMemo(
    () => allDocuments.filter(d => !readDocIds.has(d.id)).length,
    [allDocuments, readDocIds]
  );
  useEffect(() => {
    setVaultUnreadCount(unreadCount);
  }, [unreadCount, setVaultUnreadCount]);

  const markAsRead = useCallback((id: string) => {
    setReadDocIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      saveReadDocs(next);
      return next;
    });
  }, []);

  // Load documents and folders
  const loadDocuments = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const params = selectedFolderId ? { folder_id: selectedFolderId } : undefined;
      const result = await window.electronAPI!.vault!.listDocuments(params);
      if (result.documents) {
        setDocuments(result.documents);
      }
    } catch (err) {
      console.error('Failed to load documents:', err);
    }
  }, [selectedFolderId]);

  const loadAllDocuments = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.listDocuments();
      if (result.documents) {
        setAllDocuments(result.documents);
      }
    } catch (err) {
      console.error('Failed to load all documents:', err);
    }
  }, []);

  const loadFolders = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.listFolders();
      if (result.folders) {
        setFolders(result.folders);
      }
    } catch (err) {
      console.error('Failed to load folders:', err);
    }
  }, []);

  // The initial load must run exactly once, so it reads the loaders from a ref
  // captured at mount instead of depending on them. It used to depend on
  // [loadDocuments, loadAllDocuments, loadFolders], and `loadDocuments` is keyed
  // on `selectedFolderId`, so every folder click recreated it and re-ran this
  // whole init path: four vault IPC round-trips instead of one, plus `loading`
  // flipping back to true, which unmounted the document pane and flashed the
  // spinner on each click. The `if (!loading)` guard below could not catch it
  // either, since both effects flush together and that closure always saw
  // `loading === false`.
  const initialLoadersRef = useRef({ loadDocuments, loadAllDocuments, loadFolders });

  // Initial load - on first ever load, mark all existing docs as read
  useEffect(() => {
    const firstLoad = isFirstLoad();
    const loaders = initialLoadersRef.current;
    const init = async () => {
      setLoading(true);
      await Promise.all([loaders.loadDocuments(), loaders.loadAllDocuments(), loaders.loadFolders()]);
      // On first load, mark all existing documents as already read
      if (firstLoad) {
        const result = await window.electronAPI?.vault?.listDocuments();
        if (result?.documents) {
          const ids = new Set(result.documents.map((d: VaultDocumentElectron) => d.id));
          setReadDocIds(ids);
          saveReadDocs(ids);
        }
      }
      setLoading(false);
    };
    init();
  }, []);

  // Reload documents when folder changes. Seeded with the initial folder id so
  // it does not re-fetch what the init effect above already loaded (and so a
  // StrictMode double-mount stays a single fetch).
  const loadedFolderIdRef = useRef<string | null>(selectedFolderId);
  useEffect(() => {
    if (loadedFolderIdRef.current === selectedFolderId) return;
    loadedFolderIdRef.current = selectedFolderId;
    loadDocuments();
  }, [loadDocuments, selectedFolderId]);

  // Real-time event listeners
  useEffect(() => {
    if (!isElectron()) return;

    const unsubCreated = window.electronAPI!.vault!.onDocumentCreated((doc) => {
      setDocuments(prev => [doc, ...prev]);
      setAllDocuments(prev => [doc, ...prev]);
    });

    const unsubUpdated = window.electronAPI!.vault!.onDocumentUpdated((doc) => {
      setDocuments(prev => prev.map(d => d.id === doc.id ? doc : d));
      setAllDocuments(prev => prev.map(d => d.id === doc.id ? doc : d));
      if (selectedDoc?.id === doc.id) {
        setSelectedDoc(doc);
      }
    });

    const unsubDeleted = window.electronAPI!.vault!.onDocumentDeleted(({ id }) => {
      setDocuments(prev => prev.filter(d => d.id !== id));
      setAllDocuments(prev => prev.filter(d => d.id !== id));
      if (selectedDoc?.id === id) {
        setSelectedDoc(null);
        setViewMode('list');
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
    };
  }, [selectedDoc?.id]);

  // Select document
  const handleSelectDocument = async (id: string) => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.getDocument(id);
      if (result.document) {
        setSelectedDoc(result.document);
        setSelectedDocAttachments(result.attachments || []);
        setViewMode('view');
        markAsRead(id);
      }
    } catch (err) {
      console.error('Failed to load document:', err);
    }
  };

  // Attach pending files to a document
  const attachPendingFiles = async (documentId: string, files: string[]) => {
    if (!isElectron() || files.length === 0) return;
    for (const filePath of files) {
      try {
        await window.electronAPI!.vault!.attachFile({ document_id: documentId, file_path: filePath });
      } catch (err) {
        console.error('Failed to attach file:', filePath, err);
      }
    }
  };

  // Create document
  const handleCreateDocument = async (data: { title: string; content: string; tags: string[]; folder_id: string | null; pendingFiles?: string[] }) => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.createDocument({
        title: data.title,
        content: data.content,
        folder_id: data.folder_id || undefined,
        author: 'user',
        tags: data.tags,
      });
      if (result.document) {
        markAsRead(result.document.id);
        if (data.pendingFiles?.length) {
          await attachPendingFiles(result.document.id, data.pendingFiles);
        }
      }
      setViewMode('list');
      loadDocuments();
      loadAllDocuments();
    } catch (err) {
      console.error('Failed to create document:', err);
    }
  };

  // Update document
  const handleUpdateDocument = async (data: { title: string; content: string; tags: string[]; folder_id: string | null; pendingFiles?: string[] }) => {
    if (!isElectron() || !selectedDoc) return;
    try {
      await window.electronAPI!.vault!.updateDocument({
        id: selectedDoc.id,
        title: data.title,
        content: data.content,
        tags: data.tags,
        folder_id: data.folder_id,
      });
      if (data.pendingFiles?.length) {
        await attachPendingFiles(selectedDoc.id, data.pendingFiles);
      }
      setViewMode('view');
      // Reload to get updated doc
      const result = await window.electronAPI!.vault!.getDocument(selectedDoc.id);
      if (result.document) {
        setSelectedDoc(result.document);
        setSelectedDocAttachments(result.attachments || []);
      }
    } catch (err) {
      console.error('Failed to update document:', err);
    }
  };

  // Delete document
  const handleDeleteDocument = async (id: string) => {
    if (!isElectron()) return;
    try {
      await window.electronAPI!.vault!.deleteDocument(id);
      setSelectedDoc(null);
      setViewMode('list');
      loadDocuments();
      loadAllDocuments();
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  // Create folder
  const handleCreateFolder = async (name: string, parentId?: string) => {
    if (!isElectron()) return;
    try {
      await window.electronAPI!.vault!.createFolder({ name, parent_id: parentId });
      loadFolders();
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  };

  // Delete folder
  const handleDeleteFolder = async (id: string) => {
    if (!isElectron()) return;
    try {
      await window.electronAPI!.vault!.deleteFolder({ id });
      if (selectedFolderId === id) {
        setSelectedFolderId(null);
      }
      loadFolders();
      loadDocuments();
      loadAllDocuments();
    } catch (err) {
      console.error('Failed to delete folder:', err);
    }
  };

  // Non-electron fallback
  if (!isElectron()) {
    return (
      <VaultEmptyState
        icon={Archive}
        title="Vault"
        description="Available in the desktop app"
      />
    );
  }

  // Below lg there is no room for three columns, so the body takes the list's
  // place while a document is open - the two panels swap instead of stacking.
  const showBody = viewMode === 'edit' || !!selectedDoc;

  const newDocumentButton = (
    <Button
      variant="primary"
      size="md"
      onClick={() => {
        setSelectedDoc(null);
        setViewMode('edit');
      }}
    >
      + Document
    </Button>
  );

  return (
    <div className={embedded ? 'flex flex-col h-full overflow-hidden' : 'flex flex-col h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] overflow-hidden'}>
      {embedded ? (
        // The route already carries the page header; this only holds the action.
        <div className="flex justify-end pb-3.5 shrink-0">{newDocumentButton}</div>
      ) : (
        <PageHeader
          title="Vault"
          subtitle="Agent reports and working documents."
          actions={newDocumentButton}
        />
      )}

      {/* Three panels sharing one top and one bottom edge: folders, the list of
          documents, and the document itself. The list stays on screen while a
          document is open - it used to unmount and the reader lost their place. */}
      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">
        {/* Folders */}
        <Panel fill padded={false} className="w-[236px] shrink-0 max-lg:hidden">
          <PanelCaption className="px-3 pt-3 pb-2">FOLDERS</PanelCaption>
          <div className="flex-1 overflow-y-auto pb-2">
            <FolderTree
              folders={folders}
              documents={allDocuments}
              selectedFolderId={selectedFolderId}
              selectedDocId={selectedDoc?.id || null}
              readDocIds={readDocIds}
              onSelectFolder={(id) => {
                setSelectedFolderId(id);
                setViewMode('list');
                setSelectedDoc(null);
              }}
              onSelectDocument={handleSelectDocument}
              onCreateFolder={handleCreateFolder}
              onDeleteFolder={handleDeleteFolder}
            />
          </div>
        </Panel>

        {/* Document list - the opened row stays boxed as active */}
        <Panel
          fill
          padded={false}
          className={`w-[300px] shrink-0 min-w-0 max-lg:w-auto max-lg:flex-1 ${showBody ? 'max-lg:hidden' : ''}`}
        >
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <BrandSpinner size={30} label="Loading documents" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <DocumentList
                documents={documents}
                selectedDocId={selectedDoc?.id || null}
                onSelectDocument={handleSelectDocument}
                onCreateDocument={() => {
                  setSelectedDoc(null);
                  setViewMode('edit');
                }}
              />
            </div>
          )}
        </Panel>

        {/* Document body */}
        <Panel fill padded={false} className={`flex-1 min-w-0 ${showBody ? '' : 'max-lg:hidden'}`}>
          <AnimatePresence mode="wait">
            {viewMode === 'edit' ? (
              <motion.div
                key="edit"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.15 }}
                className="h-full overflow-y-auto"
              >
                <DocumentEditor
                  document={selectedDoc}
                  folders={folders}
                  defaultFolderId={!selectedDoc ? selectedFolderId : undefined}
                  onSave={selectedDoc ? handleUpdateDocument : handleCreateDocument}
                  onCancel={() => {
                    setViewMode(selectedDoc ? 'view' : 'list');
                  }}
                />
              </motion.div>
            ) : selectedDoc ? (
              <motion.div
                key={`view-${selectedDoc.id}`}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.15 }}
                className="h-full overflow-y-auto"
              >
                <DocumentViewer
                  document={selectedDoc}
                  attachments={selectedDocAttachments}
                  onBack={() => {
                    setSelectedDoc(null);
                    setViewMode('list');
                  }}
                  onEdit={() => setViewMode('edit')}
                  onDelete={handleDeleteDocument}
                />
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
              >
                Pick a document on the left to read it.
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>
      </div>
    </div>
  );
}
