import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  it('is a plugin named relais', () => {
    expect(JSON.parse(readFileSync(join(pack, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('relais');
  });

  it('ships every skill the workflow references, with matching frontmatter', () => {
    const wf = loadWorkflow({ packDir: pack });
    for (const job of Object.values(wf.jobs)) {
      const [plugin, skill] = job.skill.split(':');
      expect(plugin).toBe('relais');
      const file = join(pack, 'skills', skill!, 'SKILL.md');
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
    }
  });

  it('denies merge, force push and reading Relais secrets', () => {
    const s = JSON.parse(readFileSync(join(pack, 'settings.json'), 'utf8'));
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(gh pr merge:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Read(~/.relais/**)']));
    expect(s.permissions.allow).toContain('Bash(relais-agent:*)');
  });

  it('hook injects the rules, and the knowledge index when present', () => {
    const plain = hook({ RELAIS_TICKET: 'REL-1' });
    expect(plain.hookEventName).toBe('SessionStart');
    expect(plain.additionalContext).toContain('Ne merge jamais');
    expect(plain.additionalContext).toContain('REL-1');
    expect(plain.additionalContext).not.toContain('Base de connaissance');
    const kb = mkdtempSync(join(tmpdir(), 'relais-kb-'));
    writeFileSync(join(kb, 'INDEX.md'), '- scores.md — agrégats côté serveur\n');
    expect(hook({ RELAIS_KNOWLEDGE: kb }).additionalContext).toContain('agrégats côté serveur');
  });
});
