'use client';

import { motion } from 'framer-motion';
import { FileText } from 'lucide-react';
import { Button, MetaChip, StatusSquare } from '@/components/ui';
import type { VaultDocumentElectron } from '@/types/electron';

interface DocumentListProps {
  documents: VaultDocumentElectron[];
  selectedDocId: string | null;
  onSelectDocument: (id: string) => void;
  onCreateDocument?: () => void;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'today';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
}

export default function DocumentList({ documents, selectedDocId, onSelectDocument, onCreateDocument }: DocumentListProps) {
  if (documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <FileText className="w-14 h-14 mb-4 opacity-30" />
        <p className="text-base font-medium">No documents yet</p>
        <p className="text-sm mt-1 opacity-70">Create one or let an agent write a report</p>
        {onCreateDocument && (
          <Button variant="primary" size="md" onClick={onCreateDocument} className="mt-4">
            New Document
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-px">
      {documents.map((doc, index) => {
        const isSelected = selectedDocId === doc.id;

        return (
          <motion.button
            key={doc.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.03 }}
            onClick={() => onSelectDocument(doc.id)}
            className={`
              w-full flex items-center gap-2 h-8 px-2 text-left border transition-colors
              ${isSelected
                ? 'bg-secondary border-border-accent'
                : 'border-transparent hover:bg-secondary'
              }
            `}
          >
            <StatusSquare tone="idle" />
            <span className="flex-1 min-w-0 truncate text-xs text-foreground">
              {doc.title}
            </span>
            {/* Every vault document is markdown; the chip names the format, not a per-doc field. */}
            <MetaChip>md</MetaChip>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
              {formatDate(doc.updated_at)}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
