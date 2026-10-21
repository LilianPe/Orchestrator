import type { Verifier } from '../../core/verify.js';

/** Runs the verification commands outside the agent. `runVerify` already satisfies `run`. */
export interface CheckRunner {
  run: Verifier;
}
