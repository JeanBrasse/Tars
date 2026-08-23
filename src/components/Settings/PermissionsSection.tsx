import { Input } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import type { ClaudeSettings } from './types';

interface PermissionsSectionProps {
  settings: ClaudeSettings | null;
}

/**
 * The rules live in the CLI's own settings file and nothing here writes them
 * back yet - this section receives `settings` and no setter - so both fields are
 * read-only for now and say so on hover.
 */
export const PermissionsSection = ({ settings }: PermissionsSectionProps) => {
  const allow = settings?.permissions?.allow ?? [];
  const deny = settings?.permissions?.deny ?? [];

  return (
    <>
      <SettingsRow
        label="Always allow"
        description="Actions every CLI agent may run without asking."
        control={
          <Input
            mono
            width="control"
            readOnly
            value={allow.join(', ')}
            placeholder="nothing set"
            title="Read-only here - edit the CLI's own settings file."
          />
        }
      />

      <SettingsRow
        label="Always deny"
        description="Actions refused whatever the agent asks for."
        control={
          <Input
            mono
            width="control"
            readOnly
            value={deny.join(', ')}
            placeholder="nothing set"
            title="Read-only here - edit the CLI's own settings file."
          />
        }
      />
    </>
  );
};
