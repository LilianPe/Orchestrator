import type { VerifyResult } from '../../core/verify.js';
import type { CheckRunner } from './types.js';

const PASS: VerifyResult = { ok: true, failures: [] };

export class FakeCheckRunner implements CheckRunner {
  calls: { cwd: string; commands: string[] }[] = [];
  private results: (VerifyResult | Promise<VerifyResult>)[] = [];

  enqueue(...results: VerifyResult[]): void {
    this.results.push(...results);
  }

  /** Queues a result where the first command of the next call fails with `output`. */
  failNext(output: string): void {
    this.results.push({ ok: false, failures: [{ command: '', exitCode: 1, output }] });
  }

  /** The next call stays pending until the returned function settles it (a pass by default). */
  holdNext(): (result?: VerifyResult) => void {
    let release!: (result?: VerifyResult) => void;
    this.results.push(new Promise((resolve) => (release = (r = PASS) => resolve(r))));
    return release;
  }

  run = async (cwd: string, commands: string[]): Promise<VerifyResult> => {
    this.calls.push({ cwd, commands });
    const r = await (this.results.shift() ?? PASS);
    return { ...r, failures: r.failures.map((f) => (f.command ? f : { ...f, command: commands[0] ?? '' })) };
  };
}
