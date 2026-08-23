'use client';

import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Button, DialogShell, StatusSquare } from '@/components/ui';

interface ImportDialogProps {
  onClose: () => void;
  onImport: (payload: unknown) => Promise<{ success: boolean; imported?: number; skipped?: number; errors?: string[]; error?: string }>;
}

interface ParsedPreview {
  count: number;
  names: string[];
}

interface ChosenFile {
  name: string;
  size: number;
}

export function ImportDialog({ onClose, onImport }: ImportDialogProps) {
  const [parsed, setParsed] = useState<unknown>(null);
  const [preview, setPreview] = useState<ParsedPreview | null>(null);
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function tryParse(value: string) {
    setParseError(null);
    setSubmitError(null);
    if (!value.trim()) {
      setParsed(null);
      setPreview(null);
      return;
    }
    try {
      const json = JSON.parse(value);
      if (!json || typeof json !== 'object') {
        setParseError('JSON must be an object');
        setParsed(null);
        setPreview(null);
        return;
      }
      if (json.kind !== 'tars.agent-template') {
        setParseError('Not a Tars template file (missing kind: "tars.agent-template")');
        setParsed(null);
        setPreview(null);
        return;
      }
      if (!Array.isArray(json.templates)) {
        setParseError('Missing or invalid "templates" array');
        setParsed(null);
        setPreview(null);
        return;
      }
      const items = json.templates as unknown[];
      const names = items
        .filter((t): t is { displayName: string } =>
          !!t && typeof t === 'object' && typeof (t as { displayName?: unknown }).displayName === 'string'
        )
        .map(t => t.displayName);
      setParsed(json);
      setPreview({ count: names.length, names });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON');
      setParsed(null);
      setPreview(null);
    }
  }

  // The file itself is what the dialog shows back to you, so its name and size
  // are kept - reading `.text()` used to be the last anyone saw of it.
  async function handleFile(f: File) {
    setFile({ name: f.name, size: f.size });
    const content = await f.text();
    tryParse(content);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  async function handleSubmit() {
    if (!parsed) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await onImport(parsed);
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
      subtitle="Imported templates land under Your templates."
      footerRight={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!parsed || submitting}>
            {submitting ? 'Importing…' : 'Import'}
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
            <p className="font-mono text-xs text-primary">
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

        {preview && (
          <div className="border border-border bg-bg-tertiary px-3 py-2.5">
            <p className="text-xs text-foreground">
              {preview.count} template{preview.count === 1 ? '' : 's'} ready to import
            </p>
            <div className="mt-1.5 space-y-0.5 font-mono text-xs text-muted-foreground">
              {preview.names.slice(0, 8).map((n, i) => <p key={`${n}-${i}`}>{n}</p>)}
              {preview.names.length > 8 && <p>…and {preview.names.length - 8} more</p>}
            </div>
          </div>
        )}

        {/* Notices sit directly above the footer, marked by a status square
            rather than a tinted panel of their own. */}
        {parseError && (
          <div className="flex items-start gap-2 border border-border bg-secondary px-3 py-2">
            <StatusSquare tone="waiting" className="mt-[5px]" />
            <p className="text-xs text-foreground">{parseError}</p>
          </div>
        )}

        {submitError && (
          <div className="flex items-start gap-2 border border-border bg-secondary px-3 py-2">
            <StatusSquare tone="error" className="mt-[5px]" />
            <p className="text-xs text-foreground">{submitError}</p>
          </div>
        )}
      </div>
    </DialogShell>
  );
}
