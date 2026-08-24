import { Fragment, type ReactNode } from 'react';

/**
 * The small amount of Markdown an overseer reply actually uses.
 *
 * The messages arrived as plain text, so `**stuck on you**` and `` `agent-3` ``
 * showed up with their asterisks and backticks, which is how a model writes
 * emphasis and is not how anyone wants to read it.
 *
 * This returns React nodes and never HTML. The text comes from a language
 * model reading agent output, which is the last thing that should reach
 * `dangerouslySetInnerHTML`: a reply quoting a log line containing a script tag
 * would execute it. Building elements means the content can only ever be text.
 *
 * Deliberately not a Markdown library. What a chat reply uses is bold, italic,
 * inline code, fenced code, bullets and the occasional heading; a parser for
 * the rest is a dependency and a bundle for grammar nobody sends here.
 */

/** `**bold**`, `*italic*`, `_italic_` and `` `code` ``, innermost first. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, one regex: whichever marker starts first wins, so `**a `b` c**`
  // does not have its code span swallowed by the bold run.
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9])|`[^`\n]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key} className="font-semibold text-foreground">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key} className="font-mono text-[11.5px] bg-secondary px-1 py-px text-foreground">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let bullets: string[] = [];
  let fence: string[] | null = null;

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={key} className="list-disc pl-4 space-y-0.5 my-1">
        {items.map((item, n) => <li key={n}>{inline(item, `${key}-${n}`)}</li>)}
      </ul>,
    );
  };

  for (const [n, line] of lines.entries()) {
    const key = `b${n}`;

    // A fenced block runs verbatim: nothing inside it is markup.
    if (line.trimStart().startsWith('```')) {
      if (fence === null) {
        flushBullets(`${key}-pre`);
        fence = [];
      } else {
        blocks.push(
          <pre key={key} className="font-mono text-[11.5px] bg-secondary text-foreground p-2 my-1.5 overflow-x-auto whitespace-pre">
            {fence.join('\n')}
          </pre>,
        );
        fence = null;
      }
      continue;
    }
    if (fence !== null) { fence.push(line); continue; }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { bullets.push(bullet[1]); continue; }
    flushBullets(`${key}-list`);

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <p key={key} className="font-semibold text-foreground mt-2 first:mt-0">
          {inline(heading[2], key)}
        </p>,
      );
      continue;
    }

    if (line.trim() === '') { blocks.push(<span key={key} className="block h-2" />); continue; }
    blocks.push(<p key={key}>{inline(line, key)}</p>);
  }

  // An unterminated fence still has to show its contents: a reply cut off
  // mid-block must not silently lose the block.
  if (fence && fence.length > 0) {
    const tail: string[] = fence;
    blocks.push(
      <pre key="tail" className="font-mono text-[11.5px] bg-secondary text-foreground p-2 my-1.5 overflow-x-auto whitespace-pre">
        {tail.join('\n')}
      </pre>,
    );
  }
  flushBullets('tail-list');

  return <Fragment>{blocks}</Fragment>;
}
