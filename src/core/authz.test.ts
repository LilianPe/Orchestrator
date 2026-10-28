import { describe, expect, it } from 'vitest';
import { allowed, AUTHZ_ACTIONS, DEFAULT_MATRIX, refusalMessage, type AuthzAction, type Channel, type Role } from './authz.js';

const MEMBER = 'u-member';
const INITIATOR = 'u-initiator';
const ticket = { initiatorId: INITIATOR };

const check = (action: AuthzAction, channel: Channel, actor: string | undefined, roles: Role[], t: { initiatorId?: string } | undefined = ticket) =>
  allowed({ action, channel }, actor, t, DEFAULT_MATRIX, roles);

describe('authorization matrix (ORC-186)', () => {
  it('has the six rows of the default matrix, no more', () => {
    expect(Object.keys(DEFAULT_MATRIX).sort()).toEqual([...AUTHZ_ACTIONS].sort());
    expect(AUTHZ_ACTIONS).toHaveLength(6);
  });

  describe('row 1: trigger (delegate, mention) needs a Linear team member with write access to the repo, on Linear', () => {
    it('allows a team member who can write the repo', () => {
      expect(check('trigger', 'linear', MEMBER, ['team_member', 'repo_writer']).ok).toBe(true);
    });
    it('refuses a team member without write access, and a writer outside the team', () => {
      expect(check('trigger', 'linear', MEMBER, ['team_member']).ok).toBe(false);
      expect(check('trigger', 'linear', MEMBER, ['repo_writer', 'repo_merger']).ok).toBe(false);
    });
    it('refuses it on another channel', () => {
      expect(check('trigger', 'pr', MEMBER, ['team_member', 'repo_writer']).ok).toBe(false);
    });
  });

  describe('row 2: answer clarify needs the requester or a team member, in the Linear session', () => {
    it('allows the requester, who need not be a team member', () => {
      expect(check('answer_clarify', 'linear_session', INITIATOR, []).ok).toBe(true);
    });
    it('allows a team member', () => {
      expect(check('answer_clarify', 'linear_session', MEMBER, ['team_member']).ok).toBe(true);
    });
    it('refuses anyone else, whatever their GitHub rights', () => {
      expect(check('answer_clarify', 'linear_session', 'u-other', ['repo_writer', 'repo_merger', 'maintainer']).ok).toBe(false);
    });
    it('refuses it outside the session', () => {
      expect(check('answer_clarify', 'linear', MEMBER, ['team_member']).ok).toBe(false);
    });
  });

  describe('row 3: validate the spec needs a designated validator, never the initiator, in the Linear session', () => {
    it('allows a validator who did not start the run', () => {
      expect(check('validate_spec', 'linear_session', MEMBER, ['validator']).ok).toBe(true);
    });
    it('refuses the initiator sending /approve, even when designated validator', () => {
      const verdict = check('validate_spec', 'linear_session', INITIATOR, ['validator', 'team_member', 'maintainer']);
      expect(verdict).toEqual({ ok: false, reason: 'initiator' });
      expect(refusalMessage('validate_spec', DEFAULT_MATRIX, verdict.ok ? undefined : verdict.reason)).toMatch(/jamais .*initiat/);
    });
    it('refuses a team member who is not a validator', () => {
      expect(check('validate_spec', 'linear_session', MEMBER, ['team_member', 'repo_writer']).ok).toBe(false);
    });
  });

  describe('row 4: /refreeze needs a designated maintainer, on Linear or the PR', () => {
    it('allows a maintainer on both channels', () => {
      expect(check('refreeze', 'linear', MEMBER, ['maintainer']).ok).toBe(true);
      expect(check('refreeze', 'pr', MEMBER, ['maintainer']).ok).toBe(true);
    });
    it('refuses a writer or a merger who is not a maintainer', () => {
      expect(check('refreeze', 'pr', MEMBER, ['team_member', 'repo_writer', 'repo_merger']).ok).toBe(false);
    });
  });

  describe('row 5: relaunch a blocked run needs a team member, on Linear (label or reply in its session)', () => {
    it('allows a team member', () => {
      expect(check('relaunch_blocked', 'linear', MEMBER, ['team_member']).ok).toBe(true);
      expect(check('relaunch_blocked', 'linear_session', MEMBER, ['team_member']).ok).toBe(true);
    });
    it('refuses the requester outside the team', () => {
      expect(check('relaunch_blocked', 'linear', INITIATOR, []).ok).toBe(false);
    });
  });

  describe('row 6: moving to Done (the merge) needs a human with GitHub merge rights, on Linear', () => {
    it('allows a merger', () => {
      expect(check('done_merge', 'linear', MEMBER, ['repo_merger']).ok).toBe(true);
    });
    it('refuses a team member without merge rights: no merge, the refusal is answered', () => {
      const verdict = check('done_merge', 'linear', MEMBER, ['team_member', 'repo_writer']);
      expect(verdict).toEqual({ ok: false, reason: 'roles' });
      expect(refusalMessage('done_merge', DEFAULT_MATRIX, 'roles')).toMatch(/droit de merge/);
    });
  });

  it('refuses every action to an event without a signed actor, whatever roles it claims', () => {
    for (const action of AUTHZ_ACTIONS) {
      expect(check(action, 'linear_session', undefined, ['team_member', 'repo_writer', 'repo_merger', 'maintainer', 'validator'])).toEqual({
        ok: false,
        reason: 'unsigned',
      });
    }
  });

  it('reads no relation from an unknown ticket: the requester row then needs the role', () => {
    expect(allowed({ action: 'answer_clarify', channel: 'linear_session' }, INITIATOR, undefined, DEFAULT_MATRIX, []).ok).toBe(false);
    expect(check('answer_clarify', 'linear_session', INITIATOR, [], {}).ok).toBe(false);
  });

  it('is pure: the matrix and the roles are only read', () => {
    const roles = Object.freeze(['team_member', 'repo_writer'] as Role[]);
    const matrix = structuredClone(DEFAULT_MATRIX);
    allowed({ action: 'trigger', channel: 'linear' }, MEMBER, ticket, matrix, roles);
    expect(matrix).toEqual(DEFAULT_MATRIX);
  });
});
