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
  const native = resolve(home);
  const abs = posixPath(native);
  // Windows paths are case-insensitive, and Claude Code's docs do not say whether its rules are: a Windows home is
  // denied as written and in lower case, so another casing of the same path cannot read past the rule.
  const roots = abs === native ? [abs] : [...new Set([abs, abs.toLowerCase()])];
  return withHomeDenies(pack, roots.map((r) => `/${r}`));
}

/**
 * Claude Code matches Windows paths in POSIX form: `C:\data` as `/c/data`, `\\server\share\x` as `//server/share/x`
 * (`\\?\` long-path forms likewise), with no trailing `/`. Any other path is kept as is.
 */
export function posixPath(abs: string): string {
  const win = abs.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '');
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(win);
  const posix = drive ? `/${drive[1]!.toLowerCase()}/${drive[2]}` : win.startsWith('\\\\') ? win : undefined;
  return posix === undefined ? abs : posix.replaceAll('\\', '/').replace(/(.)\/+$/, '$1');
}

/**
 * The run settings with `<HOME>` in place of the instance's home: the same for every instance
 * and OS, so attempts can be compared by configuration (ORC-226).
 */
export function runSettingsTemplate(pack: Settings): Settings {
  return withHomeDenies(pack, ['<HOME>']);
}

function withHomeDenies(pack: Settings, roots: string[]): Settings {
  const deny = [
    ...(pack.permissions.deny ?? []),
    ...roots.flatMap((abs) => [
      `Read(${abs}/secrets.json)`,
      `Edit(${abs}/secrets.json)`,
      `Read(${abs}/factory.db*)`,
      `Read(${abs}/transcripts/**)`,
      `Read(${abs}/logs/**)`,
    ]),
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
