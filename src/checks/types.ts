/** Result of a deterministic factory check, in the shape of the GitHub check run it publishes (`factory/...`). Every such check blocks. */
export interface CheckResult {
  /** Check run name, e.g. `factory/anti-triche`. */
  check: string;
  /** `success` or `failure` conclusion. */
  ok: boolean;
  /** Check run output summary, in French: what passed, or what blocks. */
  summary: string;
}
