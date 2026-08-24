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
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Credentials in the URL would be sent to whatever host it names, and end up
  // in logs and error messages. There is no OpenAI-compatible vendor that
  // authenticates this way - they all use the API key field beside this one.
  if (parsed.username || parsed.password) return false;

  // The link-local range is where every cloud provider parks its instance
  // metadata service (169.254.169.254 on AWS, GCP and Azure alike), and the
  // stored vendor key would be attached to the call. Nothing that serves
  // completions lives there.
  //
  // Loopback and the private LAN ranges are deliberately allowed: pointing
  // this at LM Studio on 127.0.0.1, or at a vLLM box on the LAN, is the main
  // reason the custom provider exists. Blocking them to say "SSRF" would
  // remove the feature and protect nothing the user did not choose.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^169\.254\./.test(host)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
  if (host === 'metadata.google.internal') return false;

  return true;
}
