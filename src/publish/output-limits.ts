/**
 * The caps of what the factory publishes (ORC-214), the one place they are named, read by the `OutputPolicy` and by the schema of
 * `submit_result`. The doc gives no value: these are read from what the factory posts today, with room. `text`: a comment, an
 * activity or a PR body; the longest composed today is a red check's block, its output's last 4,000 characters around a few lines.
 * `prTitle`: GitHub's own limit. `summary`, `field` (why, the question), `item` and `items` (one entry, and the entries of a list):
 * the fields of `submit_result`, refused there so the agent shortens within its run; a dev summary in the pack's four sections runs
 * to a few hundred words. `findings`: the findings one review lens hands back (ORC-183), each published as an inline comment of
 * at most `text`. `captureBytes` and `captureWidth`: a PNG of a page at one of the three widths of ORC-176. `base64Run`
 * and `hexRun`: a run that long is a blob, not prose; a sha-1 (40) and a sha-256 (64) stay under `hexRun`.
 */
export const OUTPUT_LIMITS = {
  text: 10_000,
  prTitle: 256,
  summary: 6_000,
  field: 2_000,
  item: 500,
  items: 20,
  findings: 50,
  /** Choices of one `select` question (ORC-210): the agent gives 2 to 5. */
  options: 5,
  captureBytes: 2 * 1024 * 1024,
  captureWidth: { min: 320, max: 3_840 },
  base64Run: 100,
  hexRun: 65,
} as const;
