import { expect } from 'vitest';
import type { RunHandle, RunRequest, Runner, RunStreamEvent } from '../../src/adapters/runner/types.js';
import { describeContract, type ContractOptions } from './cases.js';

/**
 * The behaviours a case asks of the runtime: `success` and `failure` end on their own, `hang` runs until stopped or capped,
 * `chatty` keeps taking turns (at least 3) until stopped or capped, `unlaunchable` cannot start (a missing working directory, say).
 */
export type AgentScript = 'success' | 'failure' | 'hang' | 'chatty' | 'unlaunchable';

/** What the implementation under test arranged for the suite. Docs: docs/ports/agent-runtime.md. */
export interface AgentRuntimeSubject {
  runtime: Runner;
  /** Arranges the next run to behave as `script`, and returns what its request must carry for it. */
  script: (script: AgentScript) => Partial<RunRequest>;
  /** Moves the runtime's clock forward; absent, the suite waits in real time. */
  elapse?: (ms: number) => void;
}

let n = 0;
function request(patch: Partial<RunRequest>): RunRequest {
  return {
    runId: `contract-${++n}`, cwd: process.cwd(), prompt: '/factory:dev', claudeSessionId: `session-${n}`, resume: false, model: 'sonnet',
    pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false, limits: { turns: 50, durationMs: 10_000, usd: 5 }, env: {},
    ...patch,
  };
}

export async function drain(events: AsyncIterable<RunStreamEvent>): Promise<RunStreamEvent[]> {
  const out: RunStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** What `p` settles to, or `pending` if it has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'pending'>((resolve) => (timer = setTimeout(() => resolve('pending'), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export function describeAgentRuntimeContract(name: string, make: () => AgentRuntimeSubject, options?: ContractOptions): void {
  const start = (s: AgentRuntimeSubject, script: AgentScript, patch: Partial<RunRequest> = {}) =>
    s.runtime.start(request({ ...patch, ...s.script(script) }));

  describeContract(`AgentRuntime contract: ${name}`, options, (it) => {

    it('a successful run streams its events, closes the stream and ends in success', async () => {
      const s = make();
      const h = start(s, 'success');
      const events = await drain(h.events);
      const r = await h.done;
      expect(r.outcome).toBe('success');
      expect(r.costUsd).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.turns) && r.turns >= 1).toBe(true);
      expect(r.lastText).not.toBe('');
      expect(events.flatMap((e) => (e.kind === 'text' ? [e.text] : []))).toContain(r.lastText);
    });

    it('a failed run ends in failure', async () => {
      const s = make();
      const h = start(s, 'failure');
      await drain(h.events);
      expect((await h.done).outcome).toBe('failure');
    });

    it('a run that cannot launch ends in failure: start does not throw, done does not reject, the stream closes', async () => {
      const s = make();
      let h: RunHandle | undefined;
      expect(() => (h = start(s, 'unlaunchable'))).not.toThrow();
      await expect(within(h!.done, 1_500)).resolves.toMatchObject({ outcome: 'failure' });
      expect(await within(drain(h!.events), 1_500)).not.toBe('pending');
    });

    it('stop ends a running run in stopped and closes its stream; stopping again changes nothing', async () => {
      const s = make();
      const h = start(s, 'hang');
      expect(await within(h.done, 100)).toBe('pending');
      h.stop();
      h.stop();
      expect((await h.done).outcome).toBe('stopped');
      await drain(h.events);
    });

    it('stop after the end keeps the outcome', async () => {
      const s = make();
      const h = start(s, 'success');
      const r = await h.done;
      h.stop();
      expect(await h.done).toEqual(r);
    });

    it('runs are independent: stopping one leaves the other running', async () => {
      const s = make();
      const a = start(s, 'hang');
      const b = start(s, 'hang');
      a.stop();
      expect((await a.done).outcome).toBe('stopped');
      expect(await within(b.done, 100)).toBe('pending');
      b.stop();
      expect((await b.done).outcome).toBe('stopped');
    });

    const endsInLimit = async (script: AgentScript, limits: RunRequest['limits'], elapse = 0) => {
      const s = make();
      const h = start(s, script, { limits });
      s.elapse?.(elapse);
      try {
        expect(await within(h.done, 1_500)).toMatchObject({ outcome: 'limit' });
      } finally {
        h.stop();
      }
    };

    it('a run past its duration cap ends in limit', () =>
      endsInLimit('hang', { turns: 50, durationMs: 200, usd: 5 }, 200));

    it('a run past its turn cap ends in limit', () =>
      endsInLimit('chatty', { turns: 2, durationMs: 10_000, usd: 5 }));

  });
}
