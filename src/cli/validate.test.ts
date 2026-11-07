import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runValidateCommand } from './validate.js';

function repo(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-validate-'));
  if (config !== undefined) {
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory/config.yml'), config);
  }
  return dir;
}

function run(repoPath: string): { code: number; out: string[] } {
  const out: string[] = [];
  return { code: runValidateCommand({ repoPath, out: (l) => out.push(l) }), out };
}

describe('factory validate (ORC-209)', () => {
  it('accepts a valid configuration', () => {
    const { code, out } = run(repo('commands: { test: npm test }\n'));
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('.factory/config.yml valid');
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
    expect(runValidateCommand({ repoPath: '--json', out: (l) => out.push(l) })).toBe(1);
    expect(out).toEqual(['Usage: factory validate [repo] (no options)']);
  });

  it('says the socle applies when the repository has no file', () => {
    const { code, out } = run(repo());
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('no .factory/config.yml');
  });
});
