import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRunSettings, writeRunSettings } from './run-settings.js';

describe('run settings', () => {
  const pack = { permissions: { defaultMode: 'acceptEdits', allow: ['Read'], deny: ['Bash(gh pr merge:*)'] } };

  it('adds denies for the real RELAIS_HOME secrets to the pack settings', () => {
    const s = buildRunSettings(pack, '/data');
    expect(s.permissions.allow).toEqual(['Read']);
    expect(s.permissions.defaultMode).toBe('acceptEdits');
    expect(s.permissions.deny).toEqual([
      'Bash(gh pr merge:*)',
      'Read(//data/secrets.json)',
      'Edit(//data/secrets.json)',
      'Read(//data/relais.db*)',
      'Read(//data/transcripts/**)',
      'Read(//data/logs/**)',
      'Bash(*secrets.json*)',
      'Bash(*relais.db*)',
    ]);
  });

  it('writes the file in the home and returns its path', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'relais-pack-'));
    writeFileSync(join(packDir, 'settings.json'), JSON.stringify(pack));
    const home = mkdtempSync(join(tmpdir(), 'relais-home-'));
    const path = writeRunSettings(packDir, home);
    expect(path).toBe(join(home, 'run-settings.json'));
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.permissions.deny).toContain(`Read(/${home}/secrets.json)`);
  });
});
