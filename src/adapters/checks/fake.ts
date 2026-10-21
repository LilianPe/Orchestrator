import type { VerifyResult } from '../../core/verify.js';
import type { CheckRunner } from './types.js';

const PASS: VerifyResult = { ok: true, failures: [] };

type Scripted = (commands: string[]) => VerifyResult | Promise<VerifyResult>;

export class FakeCheckRunner implements CheckRunner {
  calls: { cwd: string; commands: string[] }[] = [];
  private results: Scripted[] = [];

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

  run = async (cwd: string, commands: string[]): Promise<VerifyResult> => {
    this.calls.push({ cwd, commands });
    return (this.results.shift() ?? (() => PASS))(commands);
  };
}
