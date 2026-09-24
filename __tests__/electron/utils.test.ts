import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron before importing utils
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/mock/app/path',
  },
  Notification: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    show: vi.fn(),
  })),
  BrowserWindow: vi.fn(),
}));

import {
  isSuperAgent,
  getSuperAgent,
  formatAgentStatus,
  formatSlackAgentStatus,
} from '../../electron/utils';
import type { AgentStatus } from '../../electron/types';

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'test-id',
    status: 'idle',
    projectPath: '/home/user/projects/my-app',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

describe('isSuperAgent', () => {
  // The role is the Orchestrator toggle's, and the name decides nothing
  // (core/agent-role.ts): renaming "Tars-Orchestrator" to "Tars-Lead" must not
  // demote it, and a worker called "Orchestrator docs" is still a worker.
  it('is true for the role, whatever the name', () => {
    expect(isSuperAgent(makeAgent({ name: 'Tars', role: 'orchestrator' }))).toBe(true);
    expect(isSuperAgent(makeAgent({ name: undefined, role: 'orchestrator' }))).toBe(true);
  });

  it('never reads the name', () => {
    expect(isSuperAgent(makeAgent({ name: 'Super Agent' }))).toBe(false);
    expect(isSuperAgent(makeAgent({ name: 'My super agent' }))).toBe(false);
    expect(isSuperAgent(makeAgent({ name: 'orchestrator' }))).toBe(false);
    expect(isSuperAgent(makeAgent({ name: 'orchestrator docs writer', role: 'worker' }))).toBe(false);
  });

  it('is false for a worker and for a record with no role', () => {
    expect(isSuperAgent(makeAgent({ name: 'Backend Worker', role: 'worker' }))).toBe(false);
    expect(isSuperAgent(makeAgent({ name: undefined }))).toBe(false);
  });

  it('does not take the old toggle field for the role', () => {
    // Always equal to the role on a record Tars wrote; the role is what counts.
    expect(isSuperAgent(makeAgent({ role: 'worker', orchestratorMode: true }))).toBe(false);
  });
});

describe('getSuperAgent', () => {
  it('finds the super agent in a map', () => {
    const agents = new Map<string, AgentStatus>();
    agents.set('1', makeAgent({ id: '1', name: 'Orchestrator docs', role: 'worker' }));
    agents.set('2', makeAgent({ id: '2', name: 'Lead', role: 'orchestrator' }));
    agents.set('3', makeAgent({ id: '3', name: 'Tester', role: 'worker' }));

    const result = getSuperAgent(agents);
    expect(result?.id).toBe('2');
  });

  it('returns undefined when no super agent exists', () => {
    const agents = new Map<string, AgentStatus>();
    agents.set('1', makeAgent({ id: '1', name: 'Worker' }));

    expect(getSuperAgent(agents)).toBeUndefined();
  });

  it('returns undefined for empty map', () => {
    expect(getSuperAgent(new Map())).toBeUndefined();
  });

  it('scopes to the requested project when projectPath is given', () => {
    // The old cross-project bug: three orchestrators (one per project) and
    // getSuperAgent returned whichever came first in the map.
    const agents = new Map<string, AgentStatus>();
    agents.set('1', makeAgent({ id: '1', name: 'Orchestrator', role: 'orchestrator', projectPath: '/proj/beta' }));
    agents.set('2', makeAgent({ id: '2', name: 'Orchestrator', role: 'orchestrator', projectPath: '/proj/alpha' }));

    expect(getSuperAgent(agents, '/proj/alpha')?.id).toBe('2');
    expect(getSuperAgent(agents, '/proj/beta')?.id).toBe('1');
    expect(getSuperAgent(agents, '/proj/unknown')).toBeUndefined();
    // Without a project (Telegram/Slack context), first orchestrator wins.
    expect(getSuperAgent(agents)?.id).toBe('1');
  });
});

describe('formatAgentStatus', () => {
  it('formats super agent with crown emoji', () => {
    const agent = makeAgent({ name: 'Super Agent', role: 'orchestrator', status: 'running' });
    const result = formatAgentStatus(agent);
    expect(result).toContain('👑');
    expect(result).toContain('*Super Agent*');
    expect(result).toContain('🟢');
  });

  it('formats regular agent with character emoji', () => {
    const agent = makeAgent({ name: 'Worker', character: 'ninja', status: 'idle' });
    const result = formatAgentStatus(agent);
    expect(result).toContain('🥷');
    expect(result).toContain('*Worker*');
    expect(result).toContain('⚪');
  });

  it('shows status emojis correctly', () => {
    expect(formatAgentStatus(makeAgent({ name: 'A', status: 'idle' }))).toContain('⚪');
    expect(formatAgentStatus(makeAgent({ name: 'A', status: 'running' }))).toContain('🟢');
    expect(formatAgentStatus(makeAgent({ name: 'A', status: 'completed' }))).toContain('✅');
    expect(formatAgentStatus(makeAgent({ name: 'A', status: 'error' }))).toContain('🔴');
    expect(formatAgentStatus(makeAgent({ name: 'A', status: 'waiting' }))).toContain('🟡');
  });

  it('truncates long task names', () => {
    const agent = makeAgent({ name: 'A', currentTask: 'A'.repeat(100) });
    const result = formatAgentStatus(agent);
    expect(result).toContain('...');
  });

  it('shows project for non-super agents', () => {
    const agent = makeAgent({ name: 'Worker', projectPath: '/home/user/my-project' });
    const result = formatAgentStatus(agent);
    expect(result).toContain('`my-project`');
  });

  it('hides project for super agents', () => {
    const agent = makeAgent({ name: 'Super Agent', role: 'orchestrator', projectPath: '/home/user/my-project' });
    const result = formatAgentStatus(agent);
    expect(result).not.toContain('Project:');
  });
});

describe('formatSlackAgentStatus', () => {
  it('uses Slack emoji codes', () => {
    const agent = makeAgent({ name: 'Worker', character: 'robot', status: 'running', skills: [] });
    const result = formatSlackAgentStatus(agent);
    expect(result).toContain(':robot_face:');
    expect(result).toContain(':large_green_circle:');
  });

  it('shows skills when present', () => {
    const agent = makeAgent({ name: 'Worker', skills: ['skill1', 'skill2'], status: 'idle' });
    const result = formatSlackAgentStatus(agent);
    expect(result).toContain(':wrench:');
    expect(result).toContain('skill1');
  });

  it('truncates skills list beyond 3', () => {
    const agent = makeAgent({ name: 'Worker', skills: ['a', 'b', 'c', 'd'], status: 'idle' });
    const result = formatSlackAgentStatus(agent);
    expect(result).toContain('...');
  });

  it('shows current task when running', () => {
    const agent = makeAgent({ name: 'Worker', status: 'running', currentTask: 'Fix bug', skills: [] });
    const result = formatSlackAgentStatus(agent);
    expect(result).toContain('Fix bug');
  });
});

