import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homePaths } from './instance.js';

export interface Settings {
  permissions: { deny?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * The pack's settings plus denies for this instance's real FACTORY_HOME secrets.
 * Not `Read(<home>/**)`: worktrees live in <home>/workspaces and runs must read them.
 * `//` prefixes an absolute path in Claude Code permission rules.
 */
export function buildRunSettings(pack: Settings, home: string): Settings {
  return withHomeDenies(pack, `/${posixPath(resolve(home))}`);
}

/** Claude Code matches Windows paths in POSIX form, `C:\data` as `/c/data`; any other path is kept as is. */
export function posixPath(abs: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(abs);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replaceAll('\\', '/')}` : abs;
}

/**
 * The run settings with `<HOME>` in place of the instance's home: the same for every instance
 * and OS, so attempts can be compared by configuration (ORC-226).
 */
export function runSettingsTemplate(pack: Settings): Settings {
  return withHomeDenies(pack, '<HOME>');
}

function withHomeDenies(pack: Settings, abs: string): Settings {
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
