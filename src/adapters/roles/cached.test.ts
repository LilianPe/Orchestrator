import { describe, expect, it } from 'vitest';
import { FakeForge } from '../forge/fake.js';
import { FakeTracker } from '../tracker/fake.js';
import { CachedRoleResolver, ROLES_TTL_MS } from './cached.js';
import type { ProjectAuthz } from './types.js';

const PROJECT: ProjectAuthz = {
  teamKey: 'REL',
  repoPath: '/repo',
  maintainers: ['u-maint'],
  validators: ['u-valid'],
  githubLogins: { 'u-dev': 'dev-gh', 'u-reader': 'reader-gh' },
};

function setup() {
  let now = 0;
  const tracker = new FakeTracker();
  const forge = new FakeForge();
  tracker.setTeamMembers('REL', ['u-dev', 'u-reader', 'u-maint']);
  forge.setRepoPermission('dev-gh', 'write');
  forge.setRepoPermission('reader-gh', 'read');
  const roles = new CachedRoleResolver({
    projects: (id) => (id === 'p' ? PROJECT : undefined),
    team: tracker,
    repo: forge,
    now: () => now,
  });
  return { tracker, forge, roles, advance: (ms: number) => (now += ms) };
}

describe('CachedRoleResolver (ORC-186)', () => {
  it('resolves Linear team membership, GitHub rights through the configured login, and designated roles', async () => {
    const { roles } = setup();
    expect(await roles.rolesOf('p', 'u-dev')).toEqual(['team_member', 'repo_writer', 'repo_merger']);
    expect(await roles.rolesOf('p', 'u-reader')).toEqual(['team_member']);
    expect(await roles.rolesOf('p', 'u-maint')).toEqual(['team_member', 'maintainer']);
    expect(await roles.rolesOf('p', 'u-valid')).toEqual(['validator']);
    expect(await roles.rolesOf('p', 'u-stranger')).toEqual([]);
    expect(await roles.rolesOf('unknown', 'u-dev')).toEqual([]);
  });

  it('resolves a GitHub actor (ORC-190) by its own login: its rights on the repository, and the Linear roles of the user it is configured for', async () => {
    const { roles, forge } = setup();
    expect(await roles.rolesOf('p', 'github:dev-gh')).toEqual(['team_member', 'repo_writer', 'repo_merger']);
    expect(await roles.rolesOf('p', 'github:reader-gh')).toEqual(['team_member']);
    forge.setRepoPermission('outsider', 'maintain');
    expect(await roles.rolesOf('p', 'github:outsider')).toEqual(['repo_writer', 'repo_merger']);
    expect(await roles.rolesOf('p', 'github:stranger')).toEqual([]);
  });

  it('maps a GitHub actor to its Linear user whatever the case of its login, and reads no team for a login configured for no one', async () => {
    const { roles, tracker } = setup();
    expect(await roles.rolesOf('p', 'github:Dev-GH')).toContain('team_member');
    const reads = tracker.calls.filter((c) => c.method === 'teamMembers').length;
    tracker.setTeamMembers('REL', []);
    await roles.rolesOf('p', 'github:nobody-configured');
    expect(tracker.calls.filter((c) => c.method === 'teamMembers')).toHaveLength(reads);
  });

  it('reads no GitHub right for a Linear user without a configured login', async () => {
    const { roles, forge } = setup();
    forge.setRepoPermission('u-maint', 'admin');
    expect(await roles.rolesOf('p', 'u-maint')).not.toContain('repo_writer');
  });

  it('reads each source once per TTL, then again: someone who left loses their roles within the TTL', async () => {
    const { roles, tracker, forge, advance } = setup();
    expect(await roles.rolesOf('p', 'u-dev')).toContain('repo_writer');
    tracker.setTeamMembers('REL', ['u-reader']);
    forge.setRepoPermission('dev-gh', 'read');
    expect(await roles.rolesOf('p', 'u-dev')).toContain('team_member');
    expect(tracker.calls.filter((c) => c.method === 'teamMembers')).toHaveLength(1);
    advance(ROLES_TTL_MS + 1);
    expect(await roles.rolesOf('p', 'u-dev')).toEqual([]);
    expect(tracker.calls.filter((c) => c.method === 'teamMembers')).toHaveLength(2);
  });

  it('caches no failure: a source that does not answer makes the resolution throw, and the next one reads again', async () => {
    const { roles, forge } = setup();
    forge.offline = true;
    await expect(roles.rolesOf('p', 'u-dev')).rejects.toThrow(/unreachable/);
    forge.offline = false;
    expect(await roles.rolesOf('p', 'u-dev')).toContain('repo_merger');
  });

  it('shares one read per source among concurrent resolutions', async () => {
    const { roles, tracker } = setup();
    await Promise.all([roles.rolesOf('p', 'u-dev'), roles.rolesOf('p', 'u-reader'), roles.rolesOf('p', 'u-maint')]);
    expect(tracker.calls.filter((c) => c.method === 'teamMembers')).toHaveLength(1);
  });

  it('gives no GitHub right without a permission source', async () => {
    const tracker = new FakeTracker();
    tracker.setTeamMembers('REL', ['u-dev']);
    const roles = new CachedRoleResolver({ projects: () => PROJECT, team: tracker });
    expect(await roles.rolesOf('p', 'u-dev')).toEqual(['team_member']);
  });
});
