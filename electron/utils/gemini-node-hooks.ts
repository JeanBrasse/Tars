import * as path from 'path';
import { updateSharedJsonSync } from './shared-file';
import { mergeNodeHooks, legacyShCommand, type HookTable } from './hook-command';

/**
 * GeminiProvider.configureHooks on win32: the Node runner, on Gemini's own
 * event names, and the agent token let through Gemini's environment redaction.
 * A file of its own so the provider keeps a one-call early return.
 *
 * - `BeforeAgent`, where the .sh wiring says `UserPromptSubmit`, which Gemini
 *   CLI does not fire (https://geminicli.com/docs/hooks/, audit A12). The old
 *   entry is removed.
 * - The token. Gemini runs a hook with `sanitizeEnvironment(process.env)`
 *   (packages/core/src/hooks/hookRunner.ts). Redaction is off by default, but
 *   once a user turns on `security.environmentVariableRedaction.enabled`,
 *   every name matching /TOKEN/ is dropped unless listed in
 *   `security.environmentVariableRedaction.allowed`
 *   (packages/core/src/services/environmentSanitization.ts; the keys the CLI
 *   reads, google-gemini/gemini-cli#29007, the docs' flat
 *   `security.allowedEnvironmentVariables` does not exist). Without it every
 *   hook post is refused (403). A per-hook `env` cannot carry it: this file
 *   is shared by every agent and the token is per terminal.
 * - Written through updateSharedJsonSync: a file that is not JSON is left
 *   as it is rather than replaced by the hooks alone.
 */
export function configureGeminiNodeHooks(configDir: string, hooksDir: string): void {
  const settingsPath = path.join(configDir, 'settings.json');
  const TOKEN_VAR = 'CLAUDE_MGR_API_TOKEN';
  const specs = [
    { type: 'AfterTool', file: 'post-tool-use.sh', matcher: '*' },
    { type: 'AfterAgent', file: 'on-stop.sh', matcher: undefined },
    { type: 'SessionStart', file: 'session-start.sh', matcher: '*' },
    { type: 'SessionEnd', file: 'session-end.sh', matcher: '*' },
    { type: 'Notification', file: 'notification.sh', matcher: '*' },
    { type: 'BeforeAgent', file: 'user-prompt-submit.sh', matcher: undefined, formerTypes: ['UserPromptSubmit'] },
  ].map(({ file, ...rest }) => ({
    ...rest, event: `gemini/${file.replace(/\.sh$/, '')}`, isLegacy: legacyShCommand(`gemini/${file}`, configDir, hooksDir),
  }));

  type Settings = { hooks?: HookTable; security?: Record<string, unknown>; [key: string]: unknown };
  const outcome = updateSharedJsonSync<Settings>(settingsPath, current => {
    const settings: Settings = current ?? {};
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    let updated = mergeNodeHooks(settings.hooks, specs, hooksDir, 10000);

    const security = (settings.security && typeof settings.security === 'object') ? settings.security : {};
    const redaction = (security.environmentVariableRedaction && typeof security.environmentVariableRedaction === 'object')
      ? security.environmentVariableRedaction as { allowed?: unknown; [key: string]: unknown }
      : {};
    const allowed = Array.isArray(redaction.allowed) ? redaction.allowed : [];
    if (!allowed.includes(TOKEN_VAR)) {
      settings.security = { ...security, environmentVariableRedaction: { ...redaction, allowed: [...allowed, TOKEN_VAR] } };
      updated = true;
    }
    return updated ? settings : undefined;
  }, { createMode: 0o644 });

  if (outcome === 'written') console.log('Gemini hooks configured/updated in', settingsPath);
  else if (outcome === 'unchanged') console.log('Gemini hooks already configured');
  else if (outcome === 'unreadable') console.warn(`Gemini hooks not configured: ${settingsPath} is not valid JSON, left untouched`);
  else console.warn(`Gemini hooks not configured: ${settingsPath} kept changing`);
}
