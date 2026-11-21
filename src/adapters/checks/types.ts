import type { Verifier } from '../../core/verify.js';

/** The `verify` of a daemon without sandboxes (`DaemonDeps.verify`): the fake runner's or a test's stand-in (ORC-179). */
export interface CheckRunner {
  run: Verifier;
}
