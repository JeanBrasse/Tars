import { Input } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import type { ClaudeSettings } from './types';

interface PermissionsSectionProps {
  settings: ClaudeSettings | null;
}

/**
 * The rules live in the CLI's own settings file and nothing here writes them
 * back yet: this section receives `settings` and no setter, so both fields are
 * read-only.
 *
 * "Edit the CLI's own settings file" was the whole explanation, which is not
 * actionable when the app runs fifteen different CLIs. The file is named now,
 * because these rules come from the one Tars actually reads.
 */
const SETTINGS_FILE = '~/.claude/settings.json';
export const PermissionsSection = ({ settings }: PermissionsSectionProps) => {
  const allow = settings?.permissions?.allow ?? [];
  const deny = settings?.permissions?.deny ?? [];

  return (
    <>
      <SettingsRow
        label="Always allow"
        description={`Actions every CLI agent may run without asking. Read from ${SETTINGS_FILE}.`}
        control={
          <Input
            mono
            width="control"
            readOnly
            value={allow.join(', ')}
            placeholder="nothing set"
            title={`Read-only here. Edit ${SETTINGS_FILE} to change it.`}
          />
        }
      />

      <SettingsRow
        label="Always deny"
        description={`Actions refused whatever the agent asks for. Read from ${SETTINGS_FILE}.`}
        control={
          <Input
            mono
            width="control"
            readOnly
            value={deny.join(', ')}
            placeholder="nothing set"
            title={`Read-only here. Edit ${SETTINGS_FILE} to change it.`}
          />
        }
      />
    </>
  );
};
