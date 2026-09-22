import { describe, it, expect } from 'vitest';
import { assignRole, requestedRole, rolesOnLoad, roleFromName } from '../../../electron/core/agent-role';
import type { AgentStatus } from '../../../electron/types';

/**
 * The Orchestrator toggle is the role, a project has one orchestrator, and the
 * name decides nothing: Noah's decision of 2026-09-22 after the audit showed
 * the toggle changed nothing for an orchestrator and the name was the switch.
 */

function agent(id: string, fields: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id, name: id, status: 'idle', projectPath: '/p/tars', skills: [], output: [],
    lastActivity: '2026-09-23T00:00:00.000Z', ...fields,
  } as AgentStatus;
}

describe('requestedRole', () => {
  it('reads role, then the toggle under its old name, then nothing', () => {
    expect(requestedRole({ role: 'orchestrator' })).toBe('orchestrator');
    expect(requestedRole({ role: 'worker', orchestratorMode: true })).toBe('worker');
    expect(requestedRole({ orchestratorMode: true })).toBe('orchestrator');
    expect(requestedRole({ orchestratorMode: false })).toBe('worker');
    expect(requestedRole({})).toBeUndefined();
    expect(requestedRole({ role: null, orchestratorMode: undefined })).toBeUndefined();
  });

  it('refuses a role that is neither, instead of saying it worked', () => {
    expect(() => requestedRole({ role: 'admin' })).toThrow('Invalid role: admin');
    expect(() => requestedRole({ role: true })).toThrow('Invalid role');
  });

  it('does not take a truthy value for the toggle', () => {
    expect(requestedRole({ orchestratorMode: 'yes' })).toBeUndefined();
  });
});

describe('assignRole', () => {
  it('writes the role and keeps the old toggle field equal to it', () => {
    const a = agent('a', { role: 'worker', orchestratorMode: false });

    assignRole(a, 'orchestrator', []);
    expect(a).toMatchObject({ role: 'orchestrator', orchestratorMode: true });

    assignRole(a, 'worker', []);
    expect(a).toMatchObject({ role: 'worker', orchestratorMode: false });
  });

  it("takes the role from its project's current orchestrator, and only that project's", () => {
    const current = agent('current', { role: 'orchestrator', orchestratorMode: true });
    const next = agent('next', { role: 'worker' });
    const elsewhere = agent('elsewhere', { role: 'orchestrator', orchestratorMode: true, projectPath: '/p/sak' });
    const fleet = [current, next, elsewhere];

    const demoted = assignRole(next, 'orchestrator', fleet);

    expect(demoted).toEqual([current]);
    expect(current).toMatchObject({ role: 'worker', orchestratorMode: false });
    expect(next).toMatchObject({ role: 'orchestrator', orchestratorMode: true });
    expect(elsewhere).toMatchObject({ role: 'orchestrator', orchestratorMode: true });
  });

  it('demotes nobody when it makes a worker', () => {
    const current = agent('current', { role: 'orchestrator' });
    const other = agent('other', { role: 'orchestrator' });

    expect(assignRole(other, 'worker', [current, other])).toEqual([]);
    expect(current.role).toBe('orchestrator');
  });

  it('restores the rule for an orchestrator that moved into a project with one', () => {
    const resident = agent('resident', { role: 'orchestrator' });
    const moved = agent('moved', { role: 'orchestrator', projectPath: '/p/tars' });

    expect(assignRole(moved, 'orchestrator', [resident, moved])).toEqual([resident]);
    expect(resident.role).toBe('worker');
  });

  it('ignores the name, whatever it says', () => {
    const named = agent('named', { name: 'Tars-Orchestrator', role: 'worker' });

    assignRole(named, 'worker', [named]);

    expect(named.role).toBe('worker');
  });
});

describe('rolesOnLoad', () => {
  it('migrates a version 2 file: toggle on, or the stored role, or the name when there is none', () => {
    const list = [
      agent('stored', { name: 'Anything', role: 'orchestrator', projectPath: '/p/1' }),
      agent('toggle', { name: 'Reviewer', role: 'worker', orchestratorMode: true, projectPath: '/p/2' }),
      agent('named', { name: 'My Super Agent', projectPath: '/p/3' }),
      agent('plain', { name: 'Backend', projectPath: '/p/4' }),
    ];

    expect(rolesOnLoad(list, 2)).toEqual([]);

    expect(list.map(a => [a.id, a.role, a.orchestratorMode])).toEqual([
      ['stored', 'orchestrator', true],
      ['toggle', 'orchestrator', true],
      ['named', 'orchestrator', true],
      ['plain', 'worker', false],
    ]);
  });

  it('reads nothing but the role from a version 3 file', () => {
    const list = [
      agent('named', { name: 'Orchestrator' }),
      agent('stale-toggle', { role: 'worker', orchestratorMode: true, projectPath: '/p/2' }),
    ];

    rolesOnLoad(list, 3);

    expect(list.map(a => [a.id, a.role, a.orchestratorMode])).toEqual([
      ['named', 'worker', false],
      ['stale-toggle', 'worker', false],
    ]);
  });

  it('leaves one orchestrator per project, the first in the file, and says who lost it', () => {
    const first = agent('first', { role: 'orchestrator' });
    const second = agent('second', { role: 'orchestrator' });
    const other = agent('other', { role: 'orchestrator', projectPath: '/p/sak' });

    expect(rolesOnLoad([first, second, other], 3)).toEqual([second]);
    expect([first.role, second.role, other.role]).toEqual(['orchestrator', 'worker', 'orchestrator']);
  });
});

describe('roleFromName', () => {
  it('is the rule the name followed until now, and nothing more', () => {
    expect(roleFromName('Tars-Orchestrator')).toBe('orchestrator');
    expect(roleFromName('super agent')).toBe('orchestrator');
    expect(roleFromName('Tars-Lead')).toBe('worker');
    expect(roleFromName(undefined)).toBe('worker');
  });
});
