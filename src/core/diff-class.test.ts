import { describe, expect, it } from 'vitest';
import { classifyBranch, classifyDiff, isVerificationConfig, needsRefreeze, REVIEW_LABELS, reviewLabel, sampled, type DiffClassName } from './diff-class.js';
import { factoryDefault } from '../presets/factory-default.js';

describe('classifyDiff (ORC-198)', () => {
  const sensitive = ['src/auth/**', 'db/migrations'];

  it('is normal when no path is sensitive nor of the verification configuration', () => {
    expect(classifyDiff(['src/app.ts', 'README.md'], sensitive)).toEqual({ class: 'normal', paths: [] });
  });

  it('is sensitive on a path of sensitive_paths, naming the paths that made it so', () => {
    expect(classifyDiff(['src/app.ts', 'src/auth/login.ts', 'db/migrations/001.sql'], sensitive)).toEqual({ class: 'sensitive', paths: ['src/auth/login.ts', 'db/migrations/001.sql'] });
  });

  it.each([
    ['the frozen harness', 'vitest.config.ts'],
    ['a nested runner config', 'packages/api/jest.config.js'],
    ['pytest shared fixtures', 'tests/conftest.py'],
    ['the test part of package.json', 'package.json'],
    ['the repository configuration', '.factory/config.yml'],
    ['a workflow of the CI', '.github/workflows/ci.yml'],
  ])('is verification-config on %s (%s)', (_case, path) => {
    expect(classifyDiff(['src/app.ts', path], [])).toEqual({ class: 'verification-config', paths: [path] });
  });

  it('takes the highest class it touches: verification-config over sensitive', () => {
    expect(classifyDiff(['src/auth/login.ts', 'vitest.config.ts'], sensitive)).toEqual({ class: 'verification-config', paths: ['vitest.config.ts'] });
  });

  it('names at most 20 paths', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/auth/f${i}.ts`);
    expect(classifyDiff(paths, sensitive).paths).toHaveLength(20);
  });

  it('reads a GitHub path outside workflows as no verification configuration (the forbidden paths refuse it anyway)', () => {
    expect(isVerificationConfig('.github/CODEOWNERS')).toBe(false);
    expect(isVerificationConfig('.github/workflows/release.yaml')).toBe(true);
    expect(isVerificationConfig('docs/.factory/notes.md')).toBe(false);
  });
});

describe('classifyBranch (ORC-198)', () => {
  const pkg = (scripts: Record<string, string>, deps: Record<string, string>) => JSON.stringify({ scripts, dependencies: deps });
  const files = (fork: Record<string, string>, head: Record<string, string>) => ({ atFork: async (p: string) => fork[p], atHead: async (p: string) => head[p] });

  it('leaves out a shared file whose test part did not change, as the freeze does: a dependency bump is normal', async () => {
    const read = files({ 'package.json': pkg({ test: 'vitest' }, { a: '1' }) }, { 'package.json': pkg({ test: 'vitest' }, { a: '2' }) });
    expect(await classifyBranch(['package.json', 'src/a.ts'], [], read)).toEqual({ class: 'normal', paths: [] });
  });

  it('keeps a shared file whose test part changed', async () => {
    const read = files({ 'package.json': pkg({ test: 'vitest' }, {}) }, { 'package.json': pkg({ test: 'vitest --passWithNoTests' }, {}) });
    expect(await classifyBranch(['package.json'], [], read)).toEqual({ class: 'verification-config', paths: ['package.json'] });
  });

  it('keeps a harness file added or deleted', async () => {
    expect(await classifyBranch(['vitest.config.ts'], [], files({}, { 'vitest.config.ts': 'export default {}' }))).toMatchObject({ class: 'verification-config' });
    expect(await classifyBranch(['jest.config.js'], [], files({ 'jest.config.js': 'module.exports = {}' }, {}))).toMatchObject({ class: 'verification-config' });
  });

  it('reads nothing for a path that is no harness', async () => {
    const read = { atFork: async () => { throw new Error('read'); }, atHead: async () => { throw new Error('read'); } };
    expect(await classifyBranch(['src/a.ts', '.github/workflows/ci.yml'], [], read)).toEqual({ class: 'verification-config', paths: ['.github/workflows/ci.yml'] });
  });
});

describe('reviewLabel (ORC-198)', () => {
  // One id drawn and one not, found once: the draw is a pure function of the id.
  const ids = Array.from({ length: 200 }, (_, i) => `ORC-${i}`);
  const drawn = ids.find(sampled)!;
  const notDrawn = ids.find((id) => !sampled(id))!;

  it.each<[DiffClassName, string]>([
    ['sensitive', 'revue: requise'],
    ['verification-config', 'revue: requise'],
  ])('is required on a %s diff, drawn or not', (cls, label) => {
    expect(reviewLabel({ diffClass: cls, blocking: 0, ticketId: drawn })).toBe(label);
    expect(reviewLabel({ diffClass: cls, blocking: 0, ticketId: notDrawn })).toBe(label);
  });

  it('is required when the AI review left blocking findings on a normal diff', () => {
    expect(reviewLabel({ diffClass: 'normal', blocking: 2, ticketId: notDrawn })).toBe('revue: requise');
  });

  it('is required when the class is unknown (a verification recorded before ORC-198)', () => {
    expect(reviewLabel({ diffClass: undefined, blocking: 0, ticketId: notDrawn })).toBe('revue: requise');
  });

  it('is a sample for a drawn ticket of the rest, else auto', () => {
    expect(reviewLabel({ diffClass: 'normal', blocking: 0, ticketId: drawn })).toBe('revue: échantillon');
    expect(reviewLabel({ diffClass: 'normal', blocking: 0, ticketId: notDrawn })).toBe('revue: auto');
  });

  it('draws about one ticket in ten, the same each time', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `ORC-${i}`);
    const share = many.filter(sampled).length / many.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
    expect(many.filter(sampled)).toEqual(many.filter(sampled));
  });

  it('is one of an exclusive group of three', () => {
    expect(REVIEW_LABELS).toEqual(['revue: requise', 'revue: échantillon', 'revue: auto']);
  });
});

describe('needsRefreeze (ORC-198)', () => {
  it("asks a maintainer's /refreeze for verification-config only, as factory/default declares", () => {
    expect(needsRefreeze('verification-config', factoryDefault.approvers)).toBe(true);
    expect(needsRefreeze('sensitive', factoryDefault.approvers)).toBe(false);
    expect(needsRefreeze('normal', factoryDefault.approvers)).toBe(false);
    expect(needsRefreeze(undefined, factoryDefault.approvers)).toBe(false);
  });
});
