import { rendererPlatform } from '@/lib/display-path';
import type { SettingsGroup } from '@/components/Settings/constants';

/**
 * Whether this window offers several Claude accounts: not on a Windows build
 * until they are ported (main holds the same line in
 * electron/platform/claude-accounts.ts and reads the option as off there).
 */
function claudeAccountsOffered(platform: string): boolean {
  return platform !== 'win32';
}

/** The Settings groups this window lists: all of them, or all but Claude accounts on win32. */
export function offeredSettingsGroups(groups: SettingsGroup[], platform: string = rendererPlatform()): SettingsGroup[] {
  if (claudeAccountsOffered(platform)) return groups;
  return groups.map(g => ({ ...g, children: g.children.filter(c => c.id !== 'claude-accounts') }));
}

/** Whether a link may open this Settings section in this window. */
export function settingsSectionOffered(id: string, platform: string = rendererPlatform()): boolean {
  return id !== 'claude-accounts' || claudeAccountsOffered(platform);
}
