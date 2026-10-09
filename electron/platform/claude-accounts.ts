/**
 * Whether this platform's build offers several Claude accounts at all.
 *
 * The accounts are not ported to Windows yet: their folders' owner-only
 * checks are POSIX modes, and their sign-in starts claude by its bare name.
 * So on win32 the option reads as off whatever the registry says, and the
 * accounts it lists are kept. Settings still shows the switch there: turned
 * on, it reads as off again; hiding it is a renderer change, not made here.
 * darwin and linux: unchanged.
 */
export function claudeAccountsAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}
