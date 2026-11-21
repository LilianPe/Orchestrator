import { describe, expect, it } from 'vitest';
import { aggregateChecks, excerpt, summarizeChecks, toRepoPermission } from './checks.js';

describe('aggregateChecks', () => {
  it.each([
    [[], 'none'],
    [['pass', 'skipping'], 'pass'],
    [['pass', 'pending'], 'pending'],
    [['pending', 'fail'], 'fail'],
    [['cancel'], 'fail'],
    [['skipping'], 'pass'],
    [['pass', 'mystery'], 'pending'],
    [['pass', ''], 'pending'],
    [['skipping', 'mystery'], 'pending'],
    [['mystery', 'fail'], 'fail'],
  ])('%j -> %s', (b, r) => expect(aggregateChecks(b as string[])).toBe(r));
});

describe('summarizeChecks', () => {
  it('names the failed checks and those in a bucket it does not know (ORC-304)', () => {
    expect(summarizeChecks([{ name: 'test', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }, { name: 'deploy', bucket: 'mystery' }, { name: 'docs', bucket: '' }])).toEqual({
      checks: 'fail',
      failedChecks: ['test'],
      unknownChecks: ['deploy', 'docs'],
    });
    expect(summarizeChecks([])).toEqual({ checks: 'none', failedChecks: [] });
  });
});

describe('excerpt', () => {
  it('keeps a short text whole, and cuts a long one at 200 code units with …', () => {
    expect(excerpt('garbage')).toBe('"garbage"');
    expect(excerpt('y'.repeat(250))).toBe(`"${'y'.repeat(200)}"…`);
  });

  it('never cuts a character in two', () => {
    expect(excerpt(`${'x'.repeat(199)}😀tail`)).toBe(`"${'x'.repeat(199)}"…`);
  });
});

describe('toRepoPermission (ORC-186)', () => {
  it('reads a known role_name first, else the base permission, else none', () => {
    expect(toRepoPermission({ permission: 'write', role_name: 'maintain' })).toBe('maintain');
    expect(toRepoPermission({ permission: 'write', role_name: 'custom-release' })).toBe('write');
    expect(toRepoPermission({ permission: 'nope' })).toBe('none');
    expect(toRepoPermission(undefined)).toBe('none');
  });
});
