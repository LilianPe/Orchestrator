import type { Finding } from '../../src/core/agent-output.js';

/**
 * The trapped diffs of the AI review (ORC-183): each hides a defect a reviewer must flag. Replayed in CI with fake runners
 * (`test/scenarios/review.test.ts`): each lens's answer is the one it must give, so the run checks that the factory hands both
 * lenses the trapped diff and publishes what they flag, blocking findings failing `factory/review`. Whether a real model flags
 * them is a run on Opus with the same diffs, out of CI (no network there but the fakes').
 */
export interface TrappedDiff {
  name: string;
  /** What the diff hides, in a sentence. */
  trap: string;
  diff: string;
  /** What each lens hands back on it. */
  correctness: Finding[];
  security: Finding[];
}

export const TRAPPED: readonly TrappedDiff[] = [
  {
    name: 'known flaw',
    trap: 'the webhook signature is compared with ===, a timing leak, and an unsigned body is let through',
    diff: [
      'diff --git a/src/webhook.ts b/src/webhook.ts',
      '--- a/src/webhook.ts',
      '+++ b/src/webhook.ts',
      '@@ -10,6 +10,9 @@ export function verify(req: Request, secret: string): boolean {',
      '   const sent = req.headers.get("x-signature");',
      '+  if (!sent) return true;',
      '   const expected = hmac(secret, req.body);',
      '-  return timingSafeEqual(Buffer.from(sent), Buffer.from(expected));',
      '+  return sent === expected;',
      ' }',
    ].join('\n'),
    correctness: [
      { file: 'src/webhook.ts', line: 11, severity: 'blocking', explanation: 'A request without a signature is accepted: the check returns true when the header is missing.', suggestion: 'Return false when the header is missing.' },
    ],
    security: [
      { file: 'src/webhook.ts', line: 13, severity: 'blocking', explanation: 'The signature is compared with ===, which leaks its prefix through timing.', suggestion: 'Keep timingSafeEqual.' },
    ],
  },
  {
    name: 'weakened test',
    trap: 'the test of the refused export loses its assertion on the error, and a case is skipped',
    diff: [
      'diff --git a/src/export.test.ts b/src/export.test.ts',
      '--- a/src/export.test.ts',
      '+++ b/src/export.test.ts',
      '@@ -20,8 +20,8 @@ describe("export", () => {',
      '-  it("refuses an export of more than 10,000 rows", async () => {',
      '-    await expect(exportCsv(rows(10_001))).rejects.toThrow(/too many rows/);',
      '+  it.skip("refuses an export of more than 10,000 rows", async () => {',
      '+    await exportCsv(rows(10_001)).catch(() => {});',
      '   });',
    ].join('\n'),
    correctness: [
      { file: 'src/export.test.ts', line: 21, severity: 'blocking', explanation: 'The cap of 10,000 rows the ticket asks for is no longer tested: the test is skipped.', suggestion: 'Restore the test.' },
    ],
    security: [
      { file: 'src/export.test.ts', line: 22, severity: 'blocking', explanation: 'The test swallows the error instead of asserting it: it cannot fail.', suggestion: 'Assert the rejection with rejects.toThrow.' },
    ],
  },
  {
    name: 'useless abstraction',
    trap: 'a strategy interface and a factory around the one CSV writer the ticket needs',
    diff: [
      'diff --git a/src/export/writer-factory.ts b/src/export/writer-factory.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/export/writer-factory.ts',
      '@@ -0,0 +1,12 @@',
      '+export interface ExportWriterStrategy { write(rows: Row[]): string }',
      '+export class CsvWriterStrategy implements ExportWriterStrategy { write(rows: Row[]) { return toCsv(rows); } }',
      '+export class ExportWriterFactory {',
      '+  static create(kind: "csv"): ExportWriterStrategy { return new CsvWriterStrategy(); }',
      '+}',
    ].join('\n'),
    correctness: [
      { file: 'src/export/writer-factory.ts', line: 3, severity: 'minor', explanation: 'Over-engineering: a strategy interface and a factory for the one CSV writer the ticket asks for, with no second writer in sight.', suggestion: 'Call toCsv directly.' },
      { file: 'src/export/writer-factory.ts', line: 4, severity: 'blocking', explanation: 'The factory ignores its kind: any other format silently gets CSV.', suggestion: 'Drop the factory, or refuse an unknown kind.' },
    ],
    security: [
      { file: 'src/export/writer-factory.ts', line: 1, severity: 'blocking', explanation: 'The new module has no test: the export path it now carries is untested.', suggestion: 'Test the CSV written.' },
    ],
  },
];
