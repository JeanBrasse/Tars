/**
 * Whether a user-supplied string is a usable OpenAI-compatible base URL:
 * parses at all, and is http/https. Deliberately the same check as
 * electron/providers/cli-provider.ts's isValidOpenAIBaseUrl - the renderer
 * cannot import electron/ code, so this is a second, independent copy of the
 * same small rule rather than trusting whatever the main process decides
 * after the fact. Used by AIProvidersSection to keep an invalid base URL
 * from ever reaching Settings persistence.
 */
export function isValidOpenAIBaseUrl(value: string | undefined): boolean {
  if (!value || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
