import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAllProviders } from '../providers';
import { getHooksPath } from '../utils/hooks-path';

/** The bundled hooks directory; in utils/hooks-path.ts, which statusline.ts imports too. */
export { getHooksPath };

/**
 * Configure hooks for all providers that support them.
 * Each provider configures its own hooks via its configureHooks() method.
 */
export async function configureStatusHooks(): Promise<void> {
  try {
    const hooksDir = getHooksPath();

    if (!fs.existsSync(hooksDir)) {
      console.log('Hooks directory not found at', hooksDir);
      return;
    }

    // Delegate to each provider that supports native hooks
    for (const provider of getAllProviders()) {
      const hookConfig = provider.getHookConfig();
      if (hookConfig.supportsNativeHooks) {
        try {
          await provider.configureHooks(hooksDir);
        } catch (err) {
          console.error(`Failed to configure ${provider.displayName} hooks:`, err);
        }
      }
    }
  } catch (err) {
    console.error('Failed to configure status hooks:', err);
  }
}

/** Where the hooks of 1.7.9 and before wrote their logs: shared /tmp, readable by every user. */
export const LEGACY_HOOK_LOGS = ['/tmp/dorothy-hooks.log', '/tmp/dorothy-hooks-debug.log'];

/**
 * Remove the logs the hooks wrote in /tmp before 1.8.0, which moved them to
 * ~/.dorothy/logs at 0600. They stayed behind after the update: about 4 MB of
 * every agent's session ids and prompts' first words, readable by any user of
 * the machine (the Audit, gate of #135).
 *
 * Only a regular file this user owns: nothing is followed or removed on
 * somebody else's behalf. And only when HOME is this user's own home: a
 * sandbox or a test run of Tars, whose HOME is a scratch folder, would
 * otherwise delete the logs a Tars still on 1.7.9 is writing beside it.
 *
 * On Windows this removes nothing, and that is right: no Tars ever ran its
 * hooks there before they moved (the .sh could not run, audit A7), so there
 * are no such logs, and `process.getuid` does not exist, so no file can pass
 * the owner check (audit A31). The hooks-path lookup above needs no change:
 * `app.asar` is spelled the same in a Windows install.
 */
export function removeLegacyHookLogs(files = LEGACY_HOOK_LOGS): string[] {
  const removed: string[] = [];
  let ownHome: string;
  try {
    ownHome = os.userInfo().homedir;
  } catch {
    return removed;
  }
  if (path.resolve(os.homedir()) !== path.resolve(ownHome)) return removed;
  const uid = process.getuid?.();
  for (const file of files) {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.uid !== uid) continue;
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      // Not there: the usual case once this has run.
    }
  }
  if (removed.length > 0) console.log(`[hooks] removed the logs of the old hooks: ${removed.join(', ')}`);
  return removed;
}
