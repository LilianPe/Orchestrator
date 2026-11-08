import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * What replays the golden tickets (ORC-236): `.github/workflows/golden.yml`, on a change of prompt, of skill or of
 * preset. Its `paths` are the rule; these tests read them as GitHub does (globs, `**` across directories).
 */
const root = join(import.meta.dirname, '../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/golden.yml'), 'utf8')) as {
  on: { push: { branches: string[]; paths: string[] }; pull_request: { paths: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, { steps: { run?: string }[] }>;
};
const paths = workflow.on.pull_request.paths;
const replays = (...changed: string[]) => changed.some((p) => paths.some((glob) => minimatch(p, glob, { dot: true })));

describe('what replays the golden tickets (ORC-236)', () => {
  it('a change of a skill, of the prompt or of the preset replays them', () => {
    expect(replays('packs/standard/skills/dev/SKILL.md')).toBe(true);
    expect(replays('src/core/prompt.ts')).toBe(true);
    expect(replays('src/presets/factory-default.ts')).toBe(true);
    // The pack's workflow, hooks and settings, and what the knowledge base injects (ORC-257), count as well.
    expect(replays('packs/standard/workflow.yml')).toBe(true);
    expect(replays('packs/standard/hooks/pre-tool-use.mjs')).toBe(true);
    expect(replays('packs/standard/settings.json')).toBe(true);
    expect(replays('src/knowledge/kb.ts')).toBe(true);
    // So do the frozen set and the replay itself.
    expect(replays('pilot/golden-tickets.yml')).toBe(true);
    expect(replays('src/golden/replay.ts')).toBe(true);
    expect(replays('test/golden/golden.test.ts')).toBe(true);
  });

  it('another change does not', () => {
    expect(replays('README.md', 'src/store/sqlite-store.ts', 'web/src/App.tsx')).toBe(false);
  });

  it('covers every file of the pack, a skill added tomorrow included', () => {
    const pack = readdirSync(join(root, 'packs'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(root.length + 1).split(sep).join('/'));
    expect(pack.length).toBeGreaterThan(10);
    expect(pack.filter((p) => !replays(p))).toEqual([]);
    expect(replays('packs/standard/skills/new-skill/SKILL.md')).toBe(true);
  });

  it('runs on a PR and on main on the same paths, and by hand, through npm run test:golden', () => {
    expect(workflow.on.push.paths).toEqual(paths);
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(Object.values(workflow.jobs).flatMap((j) => j.steps.map((s) => s.run))).toContain('npm run test:golden');
  });
});
