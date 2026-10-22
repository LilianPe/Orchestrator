import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homePaths } from './instance.js';

interface Settings {
  permissions: { deny?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * The pack's settings plus denies for this instance's real FACTORY_HOME secrets.
 * Not `Read(<home>/**)`: worktrees live in <home>/workspaces and runs must read them.
 * `//` prefixes an absolute path in Claude Code permission rules.
 */
export function buildRunSettings(pack: Settings, home: string): Settings {
  const abs = `/${resolve(home)}`;
  const deny = [
    ...(pack.permissions.deny ?? []),
    `Read(${abs}/secrets.json)`,
    `Edit(${abs}/secrets.json)`,
    `Read(${abs}/factory.db*)`,
    `Read(${abs}/transcripts/**)`,
    `Read(${abs}/logs/**)`,
    'Bash(*secrets.json*)',
    'Bash(*factory.db*)',
  ];
  return { ...pack, permissions: { ...pack.permissions, deny } };
}

/** Writes <home>/run-settings.json from <pack>/settings.json; runs pass it as `--settings`. */
export function writeRunSettings(packDir: string, home: string): string {
  const pack = JSON.parse(readFileSync(join(packDir, 'settings.json'), 'utf8')) as Settings;
  const path = homePaths(home).runSettings;
  mkdirSync(home, { recursive: true });
  writeFileSync(path, JSON.stringify(buildRunSettings(pack, home), null, 2) + '\n');
  return path;
}
