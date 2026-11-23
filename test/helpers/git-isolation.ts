import { devNull } from 'node:os';
import { join } from 'node:path';

// ORC-494: every git a test spawns inherits process.env, so none reads the workstation's config, its `core.hooksPath`
// among it, nor writes it. A test that wants a global config stubs its own.
// First, nothing of the caller's git: run from a git hook (the repository's pre-push runs the tests), GIT_DIR and the
// like would point every temporary repository at this one, and GIT_CONFIG_PARAMETERS carries a `git -c core.hooksPath=…`.
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
// A global config under the null device, which no one can make a directory: read as missing, and a `--global` write
// fails on its lock, root's too, with nothing to plant nor clean up (the null device itself would be replaced by root's
// lock-then-rename, and a fixed path in the shared tmpdir could be planted by another user).
export const NO_GLOBAL_CONFIG = join(devNull, 'config');
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
