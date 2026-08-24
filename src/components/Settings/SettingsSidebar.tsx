import Link from 'next/link';
import { Panel, Select, Dropdown } from '@/components/ui';
import { SECTION_GROUPS } from './constants';
import type { SettingsSection } from './types';

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

/**
 * One 12px square per group instead of six unrelated glyphs: the mark is the
 * brand's own language, and it says open or closed rather than naming the
 * section a second time.
 */
const GroupMark = ({ open }: { open: boolean }) => (
  <span className={`w-3 h-3 shrink-0 ${open ? 'bg-primary' : 'bg-border-accent'}`} />
);

/** Children sit flush under the parent label: 12px mark + 8px gap. */
const CHILD_INDENT = 'pl-5';

export const SettingsSidebar = ({ activeSection, onSectionChange }: SettingsSidebarProps) => {
  return (
    <>
      {/* Desktop Sidebar */}
      <Panel fill padded={false} className="w-[214px] shrink-0 hidden lg:flex">
        <nav data-testid="settings-nav" className="flex-1 min-h-0 overflow-y-auto p-2">
          <div className="space-y-1">
            {SECTION_GROUPS.map((group) => {
              const isOpen = group.children.some(c => c.id === activeSection);
              return (
                <div key={group.id}>
                  <button
                    onClick={() => onSectionChange(group.children[0].id)}
                    className={`w-full flex items-center gap-2 px-2 h-8 text-left text-sm transition-colors ${isOpen
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    <GroupMark open={isOpen} />
                    <span>{group.label}</span>
                  </button>

                  {isOpen && (
                    <div className="py-1 space-y-0.5">
                      {group.children.map((child) => (
                        <button
                          key={child.id}
                          onClick={() => onSectionChange(child.id)}
                          className={`w-full flex items-center gap-2 ${CHILD_INDENT} pr-2 h-[26px] text-left text-xs transition-colors ${child.id === activeSection
                            ? 'text-foreground bg-accent-dim'
                            : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                          {child.label}
                        </button>
                      ))}

                      {/* Schedules live on their own page: this is the bridge to it. */}
                      {group.id === 'hermes' && (
                        <Link
                          href="/crons"
                          className={`w-full flex items-center gap-2 ${CHILD_INDENT} pr-2 h-[26px] text-xs text-muted-foreground hover:text-foreground transition-colors`}
                        >
                          Schedules
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </nav>
      </Panel>

      {/* Mobile Section Selector */}
      <div className="lg:hidden mb-4 shrink-0">
        <Dropdown
          className="w-full"
          ariaLabel="Settings section"
          searchable
          value={activeSection}
          onChange={(v) => onSectionChange(v as SettingsSection)}
          options={SECTION_GROUPS.flatMap((group) =>
            group.children.map((child) => ({
              value: child.id,
              label: child.label,
              // Dropdown has no groups, so the group name rides along as the
              // hint rather than being lost with the optgroup.
              hint: group.label,
            })),
          )}
        />
      </div>
    </>
  );
};
