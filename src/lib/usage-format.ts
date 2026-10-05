/**
 * How the Usage page writes a model, a count of tokens and a sum of money, in
 * one place: its tiles, charts and provider rows, and the cost of each task.
 */

/** A model's id as the page names it: claude-opus-5-5 reads Opus 5.5. */
export function getModelDisplayName(modelId: string): string {
  const lower = modelId.toLowerCase();
  // The fifth generation by family and version, the minor one included:
  // claude-opus-5-5 read as "Opus 5". A minor is one or two digits, so a date
  // suffix such as -20260101 is never taken for one.
  const fifth = lower.match(/(fable|mythos|opus|sonnet)[-.]?5(?:[-.](\d{1,2})(?!\d))?/);
  if (fifth) return `${fifth[1][0].toUpperCase()}${fifth[1].slice(1)} 5${fifth[2] ? `.${fifth[2]}` : ''}`;
  if (lower.includes('fable')) return 'Fable 5';
  if (lower.includes('mythos')) return 'Mythos 5';
  const lowerModel = modelId.toLowerCase();
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus-4.6')) return 'Claude Opus 4.6';
  if (lowerModel.includes('opus-4-5') || lowerModel.includes('opus-4.5')) return 'Claude Opus 4.5';
  if (lowerModel.includes('opus-4-1') || lowerModel.includes('opus-4.1')) return 'Claude Opus 4.1';
  if (lowerModel.includes('opus-4') || lowerModel.includes('opus4')) return 'Claude Opus 4';
  if (lowerModel.includes('opus-3') || lowerModel.includes('opus3')) return 'Claude Opus 3';
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet-4.6')) return 'Claude Sonnet 4.6';
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet-4.5')) return 'Claude Sonnet 4.5';
  if (lowerModel.includes('sonnet-4') || lowerModel.includes('sonnet4')) return 'Claude Sonnet 4';
  if (lowerModel.includes('sonnet-3') || lowerModel.includes('sonnet3')) return 'Claude Sonnet 3.7';
  if (lowerModel.includes('haiku-4-5') || lowerModel.includes('haiku-4.5')) return 'Claude Haiku 4.5';
  if (lowerModel.includes('haiku-3-5') || lowerModel.includes('haiku-3.5')) return 'Claude Haiku 3.5';
  if (lowerModel.includes('haiku-3') || lowerModel.includes('haiku3')) return 'Claude Haiku 3';
  return modelId;
}

/**
 * 4200000 reads as 4.2M. Shared by the tiles, the charts and the provider
 * table. Counted with the cache, a fortnight runs to billions: without the B,
 * a provider row printed 111342.2M and ran into the column beside it.
 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** $10,227.39: the tiles, the provider rows and the cost card. */
export function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
