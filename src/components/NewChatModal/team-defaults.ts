import type { TeamTemplateMember } from '@/types/electron';

/**
 * A blank row for the "Add a member" action in the team table.
 *
 * Numbered rather than named after a role - the role column is free text the
 * user types over immediately, and a default like "Engineer" would just be
 * one more thing to delete before typing the real one.
 */
export function blankMember(existingCount: number): TeamTemplateMember {
  return {
    name: `Member ${existingCount + 1}`,
    character: 'robot',
    provider: 'claude',
    permissionMode: 'auto',
    skills: [],
  };
}

/**
 * `feat/frontend-engineer` from `Frontend Engineer`. Only used to prefill the
 * branch field when a member's role name changes and the branch is still
 * blank - typing over a suggestion is faster than typing a slug from scratch,
 * and it never overwrites a branch the user already set.
 */
export function branchSlug(roleName: string): string {
  const slug = roleName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `feat/${slug}` : '';
}
