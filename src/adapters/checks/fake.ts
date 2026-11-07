import type { Verifier, VerifyResult } from '../../core/verify.js';
import type { CheckRunner } from './types.js';

const PASS: VerifyResult = { ok: true, failures: [] };

type Scripted = (commands: string[]) => VerifyResult | Promise<VerifyResult>;

export class FakeCheckRunner implements CheckRunner {
  calls: { cwd: string; commands: string[] }[] = [];
  private results: Scripted[] = [];

  /** `fallback` answers once the queue is empty: a pass by default. */
  constructor(private fallback: Verifier = async () => PASS) {}

  enqueue(...results: VerifyResult[]): void {
    this.results.push(...results.map((r) => () => r));
  }

  failNext(output: string): void {
    this.results.push((commands) => ({ ok: false, failures: [{ command: commands[0] ?? '', exitCode: 1, output }] }));
  }

  /** The next call stays pending until the returned function settles it (a pass by default). */
  holdNext(): (result?: VerifyResult) => void {
    let release!: (result?: VerifyResult) => void;
    const held = new Promise<VerifyResult>((resolve) => (release = (r = PASS) => resolve(r)));
    this.results.push(() => held);
    return release;
  }

  /** Settles once the n-th check has started: the moment a held check is pending, without a deadline of its own (ORC-290). */
  started(n: number): Promise<void> {
    if (this.calls.length >= n) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ n, resolve }));
  }

  private waiters: { n: number; resolve: () => void }[] = [];

  run: Verifier = async (cwd, commands, timeoutMs) => {
    this.calls.push({ cwd, commands });
    for (const w of this.waiters) if (w.n <= this.calls.length) w.resolve();
    this.waiters = this.waiters.filter((w) => w.n > this.calls.length);
    const next = this.results.shift();
    return next ? next(commands) : this.fallback(cwd, commands, timeoutMs);
  };
}
