import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    expect(out.join('\n')).toContain('.factory/config.yml valide');
  });

  it('refuses a configuration that takes from the socle, one line per violation', () => {
    const { code, out } = run(repo('network: { level: full }\nmax_diff: { files: 99 }\n'));
    expect(code).toBe(1);
    expect(out).toEqual([
      '.factory/config.yml refusé :',
      '- network.level : `full` est réservé à `setup`, jamais pour l’agent',
      '- max_diff : max_diff.files = 99 dépasse le socle 15 : la configuration du dépôt ne peut que resserrer `max_diff`.',
    ]);
  });

  it('says the socle applies when the repository has no file', () => {
    const { code, out } = run(repo());
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('pas de .factory/config.yml');
  });
});
