import { createElement, Fragment, type ReactNode } from 'react';

/**
 * The markdown of the site's two legal documents (src/content/), and no more:
 * `#` headings, paragraphs, `- ` lists nested by two spaces with the paragraphs
 * that continue an item, `**bold**` and `` `code` ``. It builds React elements,
 * so nothing in a document can become HTML. The classes are the frame
 * `Landing · privacy and terms`, in design/landing.pen.
 */

export interface Span {
  text: string;
  strong: boolean;
  code: boolean;
}

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'list'; items: Block[][] };

const HEADING = /^(#{1,6}) (.*)$/;
const ITEM = /^- /;

/** Bold and code runs. A marker with no partner further on is text. */
function parseInline(line: string): Span[] {
  const spans: Span[] = [];
  let strong = false;
  let code = false;
  let text = '';
  const flush = () => {
    if (text) spans.push({ text, strong, code });
    text = '';
  };
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '`' && (code || line.includes('`', i + 1))) {
      flush();
      code = !code;
    } else if (!code && line.startsWith('**', i) && (strong || line.includes('**', i + 2))) {
      flush();
      strong = !strong;
      i += 1;
    } else {
      text += line[i];
    }
  }
  flush();
  return spans;
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const heading = HEADING.exec(lines[i]);
    if (!lines[i].trim()) {
      i += 1;
    } else if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseInline(heading[2]) });
      i += 1;
    } else if (ITEM.test(lines[i])) {
      const items: Block[][] = [];
      while (i < lines.length && ITEM.test(lines[i])) {
        // An item is its line, then every blank or two-space indented line after it.
        const body = [lines[i].slice(2)];
        for (i += 1; i < lines.length && (!lines[i].trim() || lines[i].startsWith('  ')); i += 1) body.push(lines[i].slice(2));
        items.push(parseLines(body));
      }
      blocks.push({ kind: 'list', items });
    } else {
      const text: string[] = [];
      for (; i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !ITEM.test(lines[i]); i += 1) text.push(lines[i].trim());
      blocks.push({ kind: 'paragraph', spans: parseInline(text.join(' ')) });
    }
  }
  return blocks;
}

export function parseMarkdown(source: string): Block[] {
  return parseLines(source.split(/\r?\n/));
}

function inline(spans: Span[]): ReactNode[] {
  return spans.map((span, k) => {
    let node: ReactNode = span.text;
    if (span.code) node = <code className="font-mono text-[13.5px] text-ink">{node}</code>;
    if (span.strong) node = <strong className="font-medium text-ink">{node}</strong>;
    return <Fragment key={k}>{node}</Fragment>;
  });
}

/** The space above a block: 36 above a heading, 14 under one, 12 between the rest, 8 above an item's own list. */
function space(block: Block, prev: Block | undefined, inItem: boolean): string {
  if (!prev) return '';
  if (block.kind === 'heading') return 'mt-9';
  if (prev.kind === 'heading') return 'mt-3.5';
  return inItem && block.kind === 'list' ? 'mt-2' : 'mt-3';
}

const cx = (...names: string[]) => names.filter(Boolean).join(' ');

function renderBlocks(blocks: Block[], inItem: boolean, from = 0): ReactNode[] {
  return blocks.slice(from).map((block, k) => {
    const above = space(block, blocks[from + k - 1], inItem);
    if (block.kind === 'heading') {
      const size = block.level === 1 ? 'text-[44px] leading-[1.1]' : 'text-[28px] leading-[1.2]';
      return createElement(`h${block.level}`, { key: k, className: cx(above, 'font-display text-ink', size) }, inline(block.spans));
    }
    if (block.kind === 'paragraph') {
      return <p key={k} className={cx(above, 'text-[15px] leading-[1.7] text-ink-soft')}>{inline(block.spans)}</p>;
    }
    return (
      <ul key={k} className={cx(above, 'flex flex-col gap-2 text-[15px] leading-[1.7] text-ink-soft')}>
        {block.items.map((item, j) => {
          // An item's first line sits beside its bullet, not in a paragraph of its own.
          const line = item[0]?.kind === 'paragraph' ? item[0] : null;
          return (
            <li key={j} className="flex gap-3">
              <span aria-hidden className="mt-[11px] w-1 h-1 shrink-0 bg-ink-muted" />
              <div className="min-w-0">
                {line && inline(line.spans)}
                {renderBlocks(item, true, line ? 1 : 0)}
              </div>
            </li>
          );
        })}
      </ul>
    );
  });
}

export function Markdown({ source }: { source: string }) {
  return <>{renderBlocks(parseMarkdown(source), false)}</>;
}
