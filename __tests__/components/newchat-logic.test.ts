import { describe, it, expect } from 'vitest';
import {
  agentOptionsSummary,
  canSubmitAgent,
  canSubmitTeam,
  deployButtonLabel,
  teamSelectionSummary,
  worktreeCount,
} from '@/components/NewChatModal/logic';

/**
 * The one-screen creation flow reads its own state back as the collapsed
 * Options row's summary and the footer's submit gate - both used to be spread
 * across the wizard's Next/Back wiring, hidden inside JSX. Pulled out here so
 * a wrong summary or a submit button that enables too early is a red test,
 * not a screenshot diff nobody looks at closely.
 */

describe('agentOptionsSummary', () => {
  it('drops the skills segment when nothing is selected', () => {
    expect(agentOptionsSummary({ skillsCount: 0, effort: 'medium', useWorktree: false, permissionMode: 'normal' }))
      .toBe('medium effort · normal');
  });

  it('reads the exact form the design frame shows', () => {
    expect(agentOptionsSummary({ skillsCount: 2, effort: 'medium', useWorktree: true, permissionMode: 'auto' }))
      .toBe('2 skills · medium effort · own worktree · auto');
  });

  it('singularises one skill', () => {
    expect(agentOptionsSummary({ skillsCount: 1, effort: 'low', useWorktree: false, permissionMode: 'bypass' }))
      .toBe('1 skill · low effort · bypass');
  });

  it('omits "own worktree" when there is none', () => {
    expect(agentOptionsSummary({ skillsCount: 3, effort: 'high', useWorktree: false, permissionMode: 'auto' }))
      .toBe('3 skills · high effort · auto');
  });
});

describe('canSubmitAgent', () => {
  it('requires a project', () => {
    expect(canSubmitAgent({ projectPath: '', useWorktree: false, branchName: '' })).toBe(false);
  });

  it('allows submit with no worktree once a project is picked', () => {
    expect(canSubmitAgent({ projectPath: '/repo', useWorktree: false, branchName: '' })).toBe(true);
  });

  it('blocks a worktree with a blank branch', () => {
    expect(canSubmitAgent({ projectPath: '/repo', useWorktree: true, branchName: '   ' })).toBe(false);
  });

  it('allows a worktree once the branch has real content', () => {
    expect(canSubmitAgent({ projectPath: '/repo', useWorktree: true, branchName: 'feat/x' })).toBe(true);
  });
});

describe('worktreeCount', () => {
  it('counts only members with a non-blank branch', () => {
    expect(worktreeCount([
      { worktreeBranch: 'feat/frontend' },
      { worktreeBranch: '' },
      { worktreeBranch: undefined },
      { worktreeBranch: '  ' },
      { worktreeBranch: 'feat/backend' },
    ])).toBe(2);
  });

  it('is zero for an empty roster', () => {
    expect(worktreeCount([])).toBe(0);
  });
});

describe('teamSelectionSummary', () => {
  it('matches the design frame exactly', () => {
    expect(teamSelectionSummary({ totalMembers: 6, selectedCount: 5, worktrees: 5 })).toBe('5 of 6 selected · 5 worktrees');
  });

  it('singularises one worktree', () => {
    expect(teamSelectionSummary({ totalMembers: 2, selectedCount: 1, worktrees: 1 })).toBe('1 of 2 selected · 1 worktree');
  });
});

describe('canSubmitTeam', () => {
  it('requires a project and at least one selected member', () => {
    expect(canSubmitTeam({ projectPath: '', selectedCount: 3 })).toBe(false);
    expect(canSubmitTeam({ projectPath: '/repo', selectedCount: 0 })).toBe(false);
    expect(canSubmitTeam({ projectPath: '/repo', selectedCount: 1 })).toBe(true);
  });
});

describe('deployButtonLabel', () => {
  it('falls back to a neutral label when nothing is selected yet', () => {
    expect(deployButtonLabel(0)).toBe('Deploy a team');
  });

  it('pluralises the count', () => {
    expect(deployButtonLabel(1)).toBe('Deploy 1 agent');
    expect(deployButtonLabel(5)).toBe('Deploy 5 agents');
  });
});
