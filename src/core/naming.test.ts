import { describe, expect, it } from 'vitest';
import { branchName, branchNamingErrors, branchType, isBranchRefName, legacyBranchName, ownBranchMatcher, ownBranchPrefixes, slugify, type BranchNaming } from './naming.js';

describe('slugify', () => {
  it('lowercases, strips accents and collapses separators', () => {
    expect(slugify('Corriger l’arrondi des Scores !')).toBe('corriger-l-arrondi-des-scores');
  });
  it('truncates without a trailing dash', () => {
    expect(slugify('a'.repeat(30) + ' ' + 'b'.repeat(30), 40)).toBe('a'.repeat(30) + '-' + 'b'.repeat(9));
  });
  it('returns "ticket" for an empty result', () => {
    expect(slugify('!!!')).toBe('ticket');
  });
});

const custom: BranchNaming = { pattern: 'agent/{type}-{id}', types: [['Security', 'sec'], ['Bug', 'bugfix']], fallback: 'work' };

describe('branchName (ORC-283)', () => {
  it("follows the team's convention by default: fix/ for a Bug label, feat/ otherwise, then the lowercased identifier", () => {
    expect(branchName('REL-12', 'Export CSV des audits')).toBe('feat/rel-12-export-csv-des-audits');
    expect(branchName('REL-12', 'Export CSV des audits', ['Frontend', 'bug'])).toBe('fix/rel-12-export-csv-des-audits');
  });

  it("follows a repository's own pattern, its first declared label the ticket carries giving the type", () => {
    expect(branchName('REL-12', 'Export CSV', ['Bug', 'Security'], custom)).toBe('agent/sec-rel-12');
    expect(branchName('REL-12', 'Export CSV', ['Bug'], custom)).toBe('agent/bugfix-rel-12');
    expect(branchName('REL-12', 'Export CSV', [], custom)).toBe('agent/work-rel-12');
    expect(branchType(['other'], custom)).toBe('work');
  });

  it('keeps the name the factory gave before ORC-283 at hand', () => {
    expect(legacyBranchName('REL-12', 'Export CSV')).toBe('factory/rel-12-export-csv');
  });
});

describe("a ticket's own branches (ORC-283)", () => {
  it('are recognized under every type and title, and under the legacy factory/ name, never under another ticket', () => {
    for (const name of ['feat/rel-3-export-csv', 'fix/rel-3-other-title', 'factory/rel-3-export-csv']) expect(ownBranchMatcher('REL-3')(name), name).toBe(true);
    for (const name of ['feat/rel-31-export-csv', 'feat/rel-3', 'chore/rel-3-x', 'factory/rel-31-x', 'feat/rel-3-Export']) expect(ownBranchMatcher('REL-3')(name), name).toBe(false);
    expect(ownBranchMatcher('REL-3', custom)('agent/sec-rel-3')).toBe(true);
    expect(ownBranchMatcher('REL-3', custom)('agent/sec-rel-31')).toBe(false);
  });

  it('are looked for on the forge by the prefix of each type, and the legacy one', () => {
    expect(ownBranchPrefixes('REL-3')).toEqual(['fix/rel-3-', 'feat/rel-3-', 'factory/rel-3-']);
    expect(ownBranchPrefixes('REL-3', custom)).toEqual(['agent/sec-rel-3', 'agent/bugfix-rel-3', 'agent/work-rel-3', 'factory/rel-3-']);
    for (const prefix of ownBranchPrefixes('REL-3')) expect(ownBranchMatcher('REL-3')(`${prefix}x`)).toBe(true);
  });
});

describe('branchNamingErrors (ORC-283)', () => {
  const naming = (pattern: string, types: BranchNaming['types'] = [['Bug', 'fix']], fallback = 'feat'): BranchNaming => ({ pattern, types, fallback });

  it('takes the default and a custom pattern', () => {
    expect(branchNamingErrors(naming('{type}/{id}-{slug}'), 'main')).toEqual([]);
    expect(branchNamingErrors(custom, 'main')).toEqual([]);
    expect(branchNamingErrors(naming('agent/{id}'), 'main')).toEqual([]);
  });

  it("refuses a pattern that starts with {id} or {slug}: doctor would have no fixed beginning to hold a CI filter by", () => {
    for (const pattern of ['{id}', '{id}-{slug}', '{slug}-{id}']) expect(branchNamingErrors(naming(pattern)).join(), pattern).toContain('must start with fixed text or {type}');
  });

  it('refuses a pattern without {id}', () => {
    expect(branchNamingErrors(naming('{type}/{slug}')).join()).toContain('{id} is required');
  });

  it('refuses an unknown variable or a lone brace', () => {
    expect(branchNamingErrors(naming('{type}/{id}-{title}')).join()).toContain('unknown variable(s) {title}');
    expect(branchNamingErrors(naming('{type}/{id}-}')).join()).toContain('opens or closes no variable');
  });

  it('refuses an {id} glued to a neighbour, which would read as the start of another ticket', () => {
    expect(branchNamingErrors(naming('{type}/{id}{slug}')).join()).toContain('between separators');
    expect(branchNamingErrors(naming('{type}/x{id}')).join()).toContain('between separators');
  });

  it('refuses a name git does not take', () => {
    for (const bad of [naming('{type}..{id}'), naming('{type}/{id}.lock'), naming('{type} {id}'), naming('{type}/{id}', [], 'a~b'), naming('/{id}'), naming('x/{id}/')]) {
      expect(branchNamingErrors(bad).join(), bad.pattern).toContain('git check-ref-format');
    }
  });

  it('refuses a name that collides with the default branch', () => {
    expect(branchNamingErrors(naming('main/{id}-{slug}'), 'main').join()).toContain('collides with the default branch main');
    expect(branchNamingErrors(naming('{type}/{id}'), 'fix').join()).toContain('collides with the default branch fix');
    expect(branchNamingErrors(naming('{type}/{id}'), 'feat/orc-1/x').join()).toContain('collides');
  });
});

describe('isBranchRefName', () => {
  it("follows git's rules for a branch", () => {
    for (const ok of ['feat/rel-1-x', 'a', 'fix/x_y.z']) expect(isBranchRefName(ok), ok).toBe(true);
    for (const bad of ['', 'HEAD', '-x', 'a//b', 'a/', '.a', 'a/.b', 'a.', 'a..b', 'a@{b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a^b', 'a b', 'a.lock', 'a.lock/b', '@', 'a\tb', 'a\u007fb']) expect(isBranchRefName(bad), bad).toBe(false);
  });
});
