/**
 * A path segment Win32 would not keep as written (audit B W-01).
 *
 * Win32 drops a trailing dot or space from every segment, so `a.` and `a ` are
 * `a` to git, Explorer and every program that does not use `\\?\` paths, while
 * Node's own calls see them literally: one name for two folders, or two for
 * one. And a device name opens the device, not a folder, with or without an
 * extension and in any case: `nul`, `feat/NUL.txt`, `COM1.log`.
 * https://learn.microsoft.com/windows/win32/fileio/naming-a-file
 *
 * darwin/linux: nothing is unsafe here; those names are ordinary there.
 */
const DEVICE = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i;

export function isUnsafePathSegment(segment: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  if (/[. ]$/.test(segment)) return true;
  // The name before its first dot, trailing spaces dropped as Win32 drops them: `nul .txt` is NUL.
  return DEVICE.test(segment.split('.')[0].replace(/ +$/, ''));
}
