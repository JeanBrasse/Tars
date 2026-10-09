/**
 * Whether this platform's build offers several Claude accounts at all.
 *
 * Upstream 1.9.2's accounts are not ported to Windows yet: their folders'
 * owner-only checks are POSIX modes, and their sign-in starts claude by its
 * bare name (WINDOWS-PORT.md). So on win32 the option reads as off whatever
 * the registry says, and Settings does not offer it (decision D17, Nicolas,
 * 2026-10-02).
 * darwin and linux are upstream's, unchanged. The renderer holds the same line
 * in src/lib/claude-accounts-offered.ts, which cannot import this file.
 */
export function claudeAccountsAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}
