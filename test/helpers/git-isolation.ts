import { devNull } from 'node:os';

// ORC-494: every git a test spawns inherits process.env, so none reads the workstation's config, its `core.hooksPath`
// among it, nor writes it: a `--global` write fails on the null device instead. The system config goes too, as a CI
// runner's (Git LFS's filters) would differ from a workstation's. A test that wants a global config stubs its own.
process.env['GIT_CONFIG_GLOBAL'] = devNull;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
