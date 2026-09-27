'use client';

import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Button, DialogShell, StatusSquare } from '@/components/ui';
import { importButtonLabel, reviewTemplateFile, skipsChecksNotice, type TemplateFileReview } from '@/lib/template-review';
import { FactRow, PromptBlock, TemplateFactRows } from './TemplateReview';

interface ImportDialogProps {
  onClose: () => void;
  onImport: (payload: unknown) => Promise<{ success: boolean; imported?: number; skipped?: number; errors?: string[]; error?: string }>;
}

interface ChosenFile {
  name: string;
  size: number;
}

/** A notice above the footer, marked by a status square rather than a tinted panel of its own. */
function notice(tone: 'waiting' | 'error', text: string) {
  return (
    <div className="flex items-start gap-2 border border-border bg-secondary px-3 py-2">
      <StatusSquare tone={tone} className="mt-[5px]" />
      <p className="text-xs text-foreground">{text}</p>
    </div>
  );
}

/**
 * Overlay · Import template · review. Nothing is saved until Import is
 * pressed, and what is saved is what the review showed: each template's
 * permission mode, the folders it adds, its skills and its whole prompt. A
 * file the review cannot show as it will be used is refused whole.
 */
export function ImportDialog({ onClose, onImport }: ImportDialogProps) {
  const [review, setReview] = useState<TemplateFileReview | null>(null);
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function read(content: string) {
    setSubmitError(null);
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      setReview({ ok: false, error: 'Not imported: this file is not JSON.' });
      return;
    }
    setReview(reviewTemplateFile(json));
  }

  // The file itself is what the dialog shows back to you, so its name and size
  // are kept - reading `.text()` used to be the last anyone saw of it.
  async function handleFile(f: File) {
    setFile({ name: f.name, size: f.size });
    read(await f.text());
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  const accepted = review?.ok ? review : null;
  const skipping = accepted?.templates.filter(t => t.facts.permissionMode === 'bypass').map(t => t.facts.name) ?? [];
  const skipsChecks = skipsChecksNotice(skipping);

  async function handleSubmit() {
    if (!accepted) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await onImport(accepted.payload);
      if (!result.success) {
        setSubmitError(result.error ?? 'Import failed');
        return;
      }
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogShell
      onClose={onClose}
      title="Import templates"
      subtitle="Imported templates land under Your templates. Nothing runs when you import them."
      footerRight={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!accepted || submitting}>
            {submitting ? 'Importing…' : importButtonLabel(accepted?.templates.length ?? 0)}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          className={`flex flex-col items-center justify-center gap-2.5 py-10 px-4 border cursor-pointer transition-colors ${dragging ? 'border-border-accent bg-accent-dim' : 'border-border bg-secondary'}`}
        >
          <span className="w-3 h-3 bg-border-accent" />
          <p className="text-xs text-muted-foreground">Drop a template file here, or choose one</p>
          {file && (
            <p className="font-mono text-xs text-foreground">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </p>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />

        {accepted && (
          <>
            <p className="text-xs text-foreground">
              {accepted.templates.length} template{accepted.templates.length === 1 ? '' : 's'} ready to import
            </p>
            {accepted.templates.map(({ facts }, i) => (
              <div key={i} className="space-y-2 border border-border bg-card px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 text-[12.5px] font-medium leading-4 text-foreground break-words">{facts.name}</p>
                  <p className="shrink-0 font-mono text-[11px] leading-4 text-text-muted">{facts.runs}</p>
                </div>
                <dl className="space-y-1.5">
                  <TemplateFactRows facts={facts} />
                  <FactRow label="Prompt">
                    {facts.prompt
                      ? <PromptBlock prompt={facts.prompt} />
                      : <p className="text-xs text-text-muted">none</p>}
                  </FactRow>
                </dl>
              </div>
            ))}
            {skipsChecks && notice('waiting', skipsChecks)}
          </>
        )}

        {review && !review.ok && notice('waiting', review.error)}
        {submitError && notice('error', submitError)}
      </div>
    </DialogShell>
  );
}
