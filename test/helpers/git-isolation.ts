import { mkdtempSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

// ORC-494: every git a test spawns inherits process.env, so none reads the workstation's config, its `core.hooksPath`
// among it, nor writes it. A test that wants a global config stubs its own.
// First, nothing of the caller's git: run from a git hook (the repository's pre-push runs the tests), GIT_DIR and the
// like would point every temporary repository at this one, and GIT_CONFIG_PARAMETERS carries a `git -c core.hooksPath=…`.
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
// A global config in a directory nobody creates: read as empty, and a `--global` write fails, root's too (git writes
// `<path>.lock` then renames it, which on the null device would replace it for root). Its parent is private (mkdtemp,
// mode 0700): a fixed path in the shared tmpdir could be planted by another user, and its config run by every test's git.
export const NO_GLOBAL_CONFIG = join(mkdtempSync(join(tmpdir(), 'factory-git-')), 'absent', 'config');
process.env['GIT_CONFIG_GLOBAL'] = NO_GLOBAL_CONFIG;
// The system config goes too, as a CI runner's (Git LFS's filters) would differ from a workstation's.
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
// The ignore and attributes files git reads from $XDG_CONFIG_HOME/git without any config naming them.
export const NO_USER_FILES = { 'core.excludesfile': devNull, 'core.attributesfile': devNull } as const;
Object.entries(NO_USER_FILES).forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
});
process.env['GIT_CONFIG_COUNT'] = String(Object.keys(NO_USER_FILES).length);
