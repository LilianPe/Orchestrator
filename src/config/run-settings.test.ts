import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRunSettings, posixPath, writeRunSettings } from './run-settings.js';

describe('run settings', () => {
  const pack = { permissions: { defaultMode: 'acceptEdits', allow: ['Read'], deny: ['Bash(gh pr merge:*)'] } };

  it('adds denies for the real FACTORY_HOME secrets to the pack settings', () => {
    const s = buildRunSettings(pack, '/data');
    // On Windows `/data` resolves on the current drive, C:\data, which Claude Code matches as /c/data.
    const data = process.platform === 'win32' ? `//${resolve('/')[0]!.toLowerCase()}/data` : '//data';
    expect(s.permissions.allow).toEqual(['Read']);
    expect(s.permissions.defaultMode).toBe('acceptEdits');
    expect(s.permissions.deny).toEqual([
      'Bash(gh pr merge:*)',
      `Read(${data}/secrets.json)`,
      `Edit(${data}/secrets.json)`,
      `Read(${data}/factory.db*)`,
      `Read(${data}/transcripts/**)`,
      `Read(${data}/logs/**)`,
      'Bash(*secrets.json*)',
      'Bash(*factory.db*)',
    ]);
  });

  it('writes the file in the home and returns its path', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'factory-pack-'));
    writeFileSync(join(packDir, 'settings.json'), JSON.stringify(pack));
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    const path = writeRunSettings(packDir, home);
    expect(path).toBe(join(home, 'run-settings.json'));
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.permissions.deny).toContain(`Read(/${posixPath(home)}/secrets.json)`);
  });

  it('writes a Windows path in the POSIX form Claude Code matches, and leaves a POSIX path alone', () => {
    expect(posixPath('C:\\Users\\u\\.factory')).toBe('/c/Users/u/.factory');
    expect(posixPath('/home/u/.factory')).toBe('/home/u/.factory');
  });
});
