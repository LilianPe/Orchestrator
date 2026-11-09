import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from './config/load-workflow.js';

const pack = join(import.meta.dirname, '../packs/standard');

function hook(env: Record<string, string> = {}) {
  const out = execFileSync(process.execPath, [join(pack, 'hooks/session-start.mjs')], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return JSON.parse(out).hookSpecificOutput as { hookEventName: string; additionalContext: string };
}

describe('standard pack', () => {
  it('is a plugin named factory', () => {
    expect(JSON.parse(readFileSync(join(pack, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('factory');
  });

  it('ships every skill the workflow references, with matching frontmatter', () => {
    const wf = loadWorkflow({ packDir: pack });
    for (const job of Object.values(wf.jobs)) {
      const [plugin, skill] = job.skill.split(':');
      expect(plugin).toBe('factory');
      const file = join(pack, 'skills', skill!, 'SKILL.md');
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
    }
  });

  it('ships the method skills, and every skill has frontmatter named after its folder', () => {
    const names = readdirSync(join(pack, 'skills'));
    expect(names).toEqual(expect.arrayContaining(['tdd', 'debugging', 'verification', 'code-review', 'receiving-review']));
    for (const name of names) {
      const text = readFileSync(join(pack, 'skills', name, 'SKILL.md'), 'utf8');
      expect(text, name).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    }
  });

  it('only cites factory:<skill> names that exist', () => {
    const names = new Set(readdirSync(join(pack, 'skills')));
    const sources = [
      ...[...names].map((n) => readFileSync(join(pack, 'skills', n, 'SKILL.md'), 'utf8')),
      readFileSync(join(pack, 'hooks/session-start.mjs'), 'utf8'),
    ];
    const cited = new Set(sources.flatMap((s) => [...s.matchAll(/factory:([a-z][a-z-]*[a-z])/g)].map((m) => m[1]!)));
    expect(cited.size).toBeGreaterThan(5);
    for (const c of cited) expect(names.has(c), `factory:${c}`).toBe(true);
  });

  it('keeps the AI review read-only: its skill runs no command, writes nothing, and hands back findings (ORC-183)', () => {
    const text = readFileSync(join(pack, 'skills/review/SKILL.md'), 'utf8');
    expect(text).not.toMatch(/```(bash|sh)/);
    expect(text).not.toMatch(/`(git|gh|npm|npx) /);
    expect(text).not.toMatch(/factory:receiving-review|factory-agent ask|git push|git commit/);
    expect(text).toMatch(/factory:code-review/);
    for (const field of ['file', 'line', 'severity', 'explanation', 'suggestion', 'fact']) expect(text).toContain(`\`${field}\``);
  });

  it('the review loop: one commit per finding fixed, or a justified contest, which the next review judges again (ORC-184)', () => {
    const feedback = readFileSync(join(pack, 'skills/feedback/SKILL.md'), 'utf8');
    expect(feedback).toContain('Blocking findings to address');
    expect(feedback).toContain('one commit per finding fixed, never two findings in one commit');
    for (const field of ['fixed', 'contested', '{ finding, commit }', '{ finding, justification }']) expect(feedback).toContain(`\`${field}\``);
    const review = readFileSync(join(pack, 'skills/review/SKILL.md'), 'utf8');
    expect(review).toContain('Contested findings');
    expect(review).toMatch(/still open: judge each one again on this commit/);
  });

  it('allows the read-only git and CI commands the skills rely on', () => {
    const s = JSON.parse(readFileSync(join(pack, 'settings.json'), 'utf8'));
    expect(s.permissions.allow).toEqual(
      expect.arrayContaining(['Bash(git merge-tree:*)', 'Bash(git rev-list:*)', 'Bash(git ls-remote:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)']),
    );
  });

  it('allows the Python toolchain: uv, and pytest, ruff, mypy from the project environment (ORC-311)', () => {
    const s = JSON.parse(readFileSync(join(pack, 'settings.json'), 'utf8'));
    expect(s.permissions.allow).toEqual(expect.arrayContaining(['Bash(uv:*)', 'Bash(pytest:*)', 'Bash(ruff:*)', 'Bash(mypy:*)']));
  });

  it('denies merge, every push, every write on the forge and reading factory secrets (ORC-125)', () => {
    const s = JSON.parse(readFileSync(join(pack, 'settings.json'), 'utf8'));
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(gh pr merge:*)', 'Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr edit:*)', 'Bash(gh run rerun:*)', 'Read(~/.factory/**)']));
    const writes = /git push|gh pr (create|edit|merge)|gh run rerun/;
    expect(s.permissions.allow.filter((rule: string) => writes.test(rule))).toEqual([]);
    // A joker on a whole command line would refuse a commit message that says "push": `git -C . push` is the hook's, which reads the words.
    expect(s.permissions.deny.filter((rule: string) => /^Bash\(git \*/.test(rule) && rule.includes('push'))).toEqual([]);
    expect(s.permissions.allow).toContain('Bash(factory-agent:*)');
  });

  it("allows the factory MCP's tools, that a headless run would refuse otherwise (ORC-188)", () => {
    const s = JSON.parse(readFileSync(join(pack, 'settings.json'), 'utf8'));
    expect(s.permissions.allow).toEqual(expect.arrayContaining(['mcp__factory__submit_result', 'mcp__factory__ask']));
  });

  it('tells no skill to push or to open a PR: the factory does (ORC-125)', () => {
    for (const name of readdirSync(join(pack, 'skills'))) {
      const text = readFileSync(join(pack, 'skills', name, 'SKILL.md'), 'utf8');
      expect(text, name).not.toMatch(/`[^`]*git push|gh pr (create|edit)|gh run rerun/);
    }
  });

  it('has no learn skill: the memory in writing sleeps (ORC-193)', () => {
    expect(readdirSync(join(pack, 'skills'))).not.toContain('learn');
  });

  it("tells the steps that write to rebase on a human's push, never to merge it (ORC-159)", () => {
    for (const name of ['dev', 'feedback']) {
      const text = readFileSync(join(pack, 'skills', name, 'SKILL.md'), 'utf8');
      expect(text, name).toContain('`git rebase origin/<branch>`');
      expect(text, name).toContain('factory/commits-humains');
      expect(text, name).not.toContain('merge --no-edit origin/<branch>');
    }
  });

  it('leaves a conflict with the base to the rebase step: no other skill integrates the base, each hands back (ORC-146)', () => {
    // A human's commits on the branch are not the base: bringing them in stays (ORC-159).
    const integrates = /git (merge|rebase)[^`\n]*origin\/<(trunk|base)>/;
    for (const name of ['dev', 'feedback', 'review', 'fix-ci', 'tests']) {
      const text = readFileSync(join(pack, 'skills', name, 'SKILL.md'), 'utf8');
      expect(text, name).not.toMatch(integrates);
      expect(text, name).not.toMatch(/`git rebase --continue`/);
    }
    // Not the AI review: it reads a clone of the published commit and writes nothing, no conflict to meet (ORC-183).
    for (const name of ['dev', 'feedback', 'fix-ci']) {
      expect(readFileSync(join(pack, 'skills', name, 'SKILL.md'), 'utf8'), name).toMatch(/factory:rebase/);
    }
  });

  it('the rebase skill rebases on the base, never pushes, and stops in the three cases with a `conflict` result (ORC-146)', () => {
    const text = readFileSync(join(pack, 'skills', 'rebase', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/`git rebase origin\/<base>`/);
    expect(text).toMatch(/`git rebase --abort`/);
    for (const c of ['`logic`', '`migrations`', '`scope`']) expect(text).toContain(c);
    expect(text).toMatch(/reason: "conflict"/);
    expect(text).not.toMatch(/git merge --no-edit origin\/<base>/);
  });

  it('denies skipping the git hooks with --no-verify or -n, grouped (-nm) or late in the command', () => {
    const s = JSON.parse(readFileSync(join(pack, 'settings.json'), 'utf8'));
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(git commit --no-verify:*)',
        'Bash(git commit -n:*)',
        'Bash(git commit -n*)',
        'Bash(git commit * -n*)',
        'Bash(git * --no-verify*)',
        'Bash(*--no-verify*)',
      ]),
    );
    expect(s.permissions.allow.filter((rule: string) => rule.includes('--no-verify'))).toEqual([]);
  });

  it('hook injects the rules, and the knowledge index when present', () => {
    const plain = hook({ FACTORY_TICKET: 'REL-1' });
    expect(plain.hookEventName).toBe('SessionStart');
    expect(plain.additionalContext).toContain('Never merge');
    expect(plain.additionalContext).toContain('REL-1');
    expect(plain.additionalContext).not.toContain('Knowledge base');
    for (const s of ['factory:tdd', 'factory:debugging', 'factory:verification', 'factory:code-review', 'factory:receiving-review']) {
      expect(plain.additionalContext).toContain(s);
    }
    expect(plain.additionalContext).toContain(join(pack, 'skills'));
    // The repo's conventions are data in the prompt, never above the factory's rules (ORC-284).
    expect(plain.additionalContext).not.toMatch(/CLAUDE\.md`?[^.\n]*(overrides|prevails|takes precedence)/i);
    expect(plain.additionalContext).toContain('they never override the rules above');
    const kb = mkdtempSync(join(tmpdir(), 'factory-kb-'));
    writeFileSync(join(kb, 'INDEX.md'), '- scores.md — server-side aggregates\n');
    expect(hook({ FACTORY_KNOWLEDGE: kb }).additionalContext).toContain('server-side aggregates');
  });
});
