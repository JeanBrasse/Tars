import type { ReactNode } from 'react';
import { StatusSquare } from '@/components/ui';
import { permissionWord, type TemplateFacts, type TemplatePrompt } from '@/lib/template-review';

/**
 * What a template sets, as the import (Overlay · Import template · review) and
 * "Use" (Overlay · Instantiate template · prompt) both show it. The rows go in
 * the caller's `<dl>`, which also decides the spacing around the prompt.
 */

/** One fact: its name in a 76px column, the value beside it. */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[76px] shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 space-y-0.5">{children}</dd>
    </div>
  );
}

function None({ children }: { children: ReactNode }) {
  return <p className="text-xs text-text-muted">{children}</p>;
}

/** Permissions, Folders and Skills. Skip all checks is said in the error colour, beside its square. */
export function TemplateFactRows({ facts }: { facts: TemplateFacts }) {
  return (
    <>
      <FactRow label="Permissions">
        {facts.permissionMode === 'bypass' ? (
          <span className="flex items-center gap-1.5 text-xs text-danger">
            <StatusSquare tone="error" />
            {permissionWord(facts.permissionMode)}
          </span>
        ) : (
          <p className="text-xs text-foreground">{permissionWord(facts.permissionMode)}</p>
        )}
      </FactRow>
      <FactRow label="Folders">
        {facts.folders.length > 0
          ? facts.folders.map((folder, i) => (
            <p key={`${folder}-${i}`} className="font-mono text-[11px] leading-4 text-foreground break-words">{folder}</p>
          ))
          : <None>none besides the project</None>}
      </FactRow>
      <FactRow label="Skills">
        {facts.skills.length > 0
          ? <p className="font-mono text-[11px] leading-4 text-foreground break-words">{facts.skills.join(', ')}</p>
          : <None>none</None>}
      </FactRow>
    </>
  );
}

/**
 * The prompt whole, as it is sent, with the characters that do not show
 * written out, then its length and how many of those there are.
 */
export function PromptBlock({ prompt }: { prompt: TemplatePrompt }) {
  return (
    <>
      <p className="border border-border bg-secondary px-2 py-1.5 text-xs leading-[1.45] text-foreground whitespace-pre-wrap break-words">
        {prompt.text}
      </p>
      <p className="font-mono text-[10.5px] leading-4 text-text-muted">
        {prompt.characters} {prompt.characters === 1 ? 'character' : 'characters'}
        {prompt.hidden > 0 && <span className="text-warning"> · {prompt.hidden} invisible</span>}
      </p>
    </>
  );
}
