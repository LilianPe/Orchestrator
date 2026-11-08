import { chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactoryYmlError, type FactoryYml } from '../config/factory-yml.js';
import { runValidateCommand } from './validate.js';

const AGENTS = ['intake', 'clarify', 'spec_draft', 'tests', 'build', 'review', 'after_merge', 'fix'];
/** factory.yml's budgets whose worst case on factory/default is its ticket cap exactly: 26 attempts of 1,000 tokens. */
const budgeted = (perTicketTokens = 26_000): FactoryYml => ({ budgets: { perStepTokens: Object.fromEntries(AGENTS.map((s) => [s, 1_000])), perTicketTokens } });
const WITHIN = 'Worst case of factory/default: 26000 tokens and 2700 turns per ticket, within budgets.per_ticket_tokens 26000.';

function repo(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-validate-'));
  if (config !== undefined) {
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory/config.yml'), config);
  }
  return dir;
}

function run(repoPath: string, yml: FactoryYml | undefined = budgeted()): { code: number; out: string[] } {
  const out: string[] = [];
  return { code: runValidateCommand({ repoPath, out: (l) => out.push(l), factoryYml: () => yml }), out };
}

describe('factory validate (ORC-209)', () => {
  it('accepts a valid configuration', () => {
    const { code, out } = run(repo('commands: { test: npm test }\n'));
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('.factory/config.yml valid');
  });

  it('warns of a sensitive path that names nothing, without refusing the file (ORC-338)', () => {
    const { code, out } = run(repo('sensitive_paths: [infra, "../x"]\n'));
    expect(code).toBe(0);
    expect(out).toEqual([
      '.factory/config.yml valid: it only adds checks or prohibitions to the baseline.',
      'Warning, ignored entries (a branch that took untrusted content is refused until they are fixed):',
      '- sensitive_paths[1]: "../x": a path from the repository root is expected (no drive, no `..`, no absolute path in a brace)',
      WITHIN,
    ]);
  });

  it('refuses a configuration that takes from the socle, one line per violation', () => {
    const { code, out } = run(repo('network: { level: full }\nmax_diff: { files: 99 }\n'));
    expect(code).toBe(1);
    expect(out).toEqual([
      '.factory/config.yml refused:',
      '- network.level: `full` is reserved for `setup`, never for the agent',
      '- max_diff.files = 99 exceeds the baseline 15: the repository configuration can only tighten `max_diff`.',
    ]);
  });

  it('refuses a config.yaml, which the factory would never read', () => {
    const dir = repo();
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory/config.yaml'), 'network: { level: full }\n');
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('.factory/config.yaml: rename it to .factory/config.yml');
  });

  it('reports an unreadable file as a violation, not a crash', () => {
    const dir = repo();
    mkdirSync(join(dir, '.factory/config.yml'), { recursive: true });
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out[1]).toMatch(/^- unreadable: /);
  });

  it('reports a .factory it cannot look into as unreadable, not a crash', () => {
    // A loop on the way to .factory (ELOOP).
    const loop = repo();
    symlinkSync('self', join(loop, 'self'));
    const looped = run(join(loop, 'self'));
    expect(looped.code).toBe(1);
    expect(looped.out).toEqual(['.factory/config.yml refused:', expect.stringMatching(/^- unreadable: .*ELOOP/)]);
    // A .factory that cannot be searched (EACCES); root reads it all the same.
    if (process.getuid?.() === 0) return;
    const locked = repo('commands: { test: npm test }\n');
    chmodSync(join(locked, '.factory'), 0o000);
    try {
      const denied = run(locked);
      expect(denied.code).toBe(1);
      expect(denied.out).toEqual(['.factory/config.yml refused:', expect.stringMatching(/^- unreadable: .*EACCES/)]);
    } finally {
      chmodSync(join(locked, '.factory'), 0o755);
    }
  });

  it('refuses a link, at .factory or at its file, as the launch does: git reads nothing through it', () => {
    const file = repo('commands: { test: npm test }\n');
    renameSync(join(file, '.factory/config.yml'), join(file, 'factory.yml'));
    symlinkSync('../factory.yml', join(file, '.factory/config.yml'));
    expect(run(file)).toEqual({ code: 1, out: ['.factory/config.yml refused:', '- .factory/config.yml: a file is expected, not a symbolic link'] });
    const dir = repo('commands: { test: npm test }\n');
    renameSync(join(dir, '.factory'), join(dir, 'ci'));
    symlinkSync('ci', join(dir, '.factory'));
    expect(run(dir)).toEqual({ code: 1, out: ['.factory/config.yml refused:', '- .factory: a folder is expected, not a symbolic link or a file'] });
  });

  it('refuses a dangling link too, at .factory or at its file: the launch refuses it all the same', () => {
    const file = repo('commands: { test: npm test }\n');
    renameSync(join(file, '.factory/config.yml'), join(file, 'gone.yml'));
    symlinkSync('../missing.yml', join(file, '.factory/config.yml'));
    expect(run(file)).toEqual({ code: 1, out: ['.factory/config.yml refused:', '- .factory/config.yml: a file is expected, not a symbolic link'] });
    const dir = repo();
    symlinkSync('missing', join(dir, '.factory'));
    expect(run(dir)).toEqual({ code: 1, out: ['.factory/config.yml refused:', '- .factory: a folder is expected, not a symbolic link or a file'] });
  });

  it('refuses an option where the repository path goes', () => {
    const out: string[] = [];
    expect(runValidateCommand({ repoPath: '--json', out: (l) => out.push(l), factoryYml: () => undefined })).toBe(1);
    expect(out).toEqual(['Usage: factory validate [repo] (no options)']);
  });

  it('says the socle applies when the repository has no file', () => {
    const { code, out } = run(repo());
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('no .factory/config.yml');
  });
});

describe('factory validate: the worst case of the preset (ORC-216)', () => {
  it('computes it in tokens and in turns, and accepts it within the ticket cap', () => {
    const { code, out } = run(repo('commands: { test: npm test }\n'));
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(WITHIN);
    expect(run(repo()).out.at(-1)).toBe(WITHIN);
  });

  it('refuses a preset whose worst case exceeds the ticket cap', () => {
    expect(run(repo(), budgeted(25_999))).toEqual({
      code: 1,
      out: ['no .factory/config.yml: the factory/default baseline applies as is.', 'Budgets of factory/default refused:', "- worst case 26000 tokens per ticket exceeds budgets.per_ticket_tokens 25999: lower a step's per_step_tokens or a counter of factory/default"],
    });
  });

  it("takes the repository's per_ticket_tokens, which only lowers the cap", () => {
    const lowered = run(repo('budgets: { per_ticket_tokens: 20000 }\n'));
    expect(lowered.code).toBe(1);
    expect(lowered.out.at(-1)).toContain('exceeds budgets.per_ticket_tokens 20000');
    const raised = run(repo('budgets: { per_ticket_tokens: 90000 }\n'), budgeted(20_000));
    expect(raised.code).toBe(1);
    expect(raised.out.at(-1)).toContain('exceeds budgets.per_ticket_tokens 20000');
  });

  it('refuses while the caps are still to set, rather than passing', () => {
    const { code, out } = run(repo(), {});
    expect(code).toBe(1);
    expect(out.slice(1)).toEqual([
      'Budgets of factory/default refused:',
      ...AGENTS.map((s) => `- budgets.per_step_tokens.${s}: not set; the worst case of factory/default has no bound without it`),
      '- budgets.per_ticket_tokens: not set; the worst case of factory/default has no bound without it',
    ]);
  });

  it('refuses an invalid factory.yml, one line per violation', () => {
    const out: string[] = [];
    const code = runValidateCommand({ repoPath: repo(), out: (l) => out.push(l), factoryYml: () => { throw new FactoryYmlError(['budgets.per_ticket_tokens: a positive integer is expected']); } });
    expect(code).toBe(1);
    expect(out.slice(1)).toEqual(['factory.yml refused:', '- budgets.per_ticket_tokens: a positive integer is expected']);
  });
});
