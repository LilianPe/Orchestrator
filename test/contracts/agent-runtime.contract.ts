import { describe, expect, it } from 'vitest';
import type { RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from '../../src/adapters/runner/types.js';
import { caseFor } from './gaps.js';

/**
 * The behaviours a case asks of the runtime: `success` and `failure` end on their own, `hang` runs until stopped or capped,
 * `chatty` keeps taking turns (at least 3) until stopped or capped.
 */
export type AgentScript = 'success' | 'failure' | 'hang' | 'chatty';

/** What the implementation under test arranged for the suite. Docs: docs/ports/agent-runtime.md. */
export interface AgentRuntimeSubject {
  runtime: Runner;
  /** Arranges the next run to behave as `script`, and returns what its request must carry for it. */
  script: (script: AgentScript) => Partial<RunRequest>;
}

export type AgentRuntimeGap = 'duration-limit' | 'turn-limit';

let n = 0;
function request(patch: Partial<RunRequest>): RunRequest {
  return {
    runId: `contract-${++n}`, cwd: process.cwd(), prompt: '/factory:dev', claudeSessionId: `session-${n}`, resume: false, model: 'sonnet',
    pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false, limits: { turns: 50, durationMs: 10_000, usd: 5 }, env: {},
    ...patch,
  };
}

async function drain(events: AsyncIterable<RunStreamEvent>): Promise<RunStreamEvent[]> {
  const out: RunStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** The result, or `pending` if the run has not ended within `ms`. */
function within(h: RunHandle, ms: number): Promise<RunResult | 'pending'> {
  return Promise.race([h.done, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

export function describeAgentRuntimeContract(name: string, make: () => AgentRuntimeSubject, gaps?: AgentRuntimeGap[]): void {
  const start = (s: AgentRuntimeSubject, script: AgentScript, patch: Partial<RunRequest> = {}) =>
    s.runtime.start(request({ ...patch, ...s.script(script) }));

  describe(`AgentRuntime contract: ${name}`, () => {
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

    it('stop ends a running run in stopped and closes its stream; stopping again changes nothing', async () => {
      const s = make();
      const h = start(s, 'hang');
      expect(await within(h, 100)).toBe('pending');
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
      expect(await within(b, 100)).toBe('pending');
      b.stop();
      expect((await b.done).outcome).toBe('stopped');
    });

    caseFor(gaps, 'duration-limit')('a run past its duration cap ends in limit', async () => {
      const s = make();
      const h = start(s, 'hang', { limits: { turns: 50, durationMs: 200, usd: 5 } });
      try {
        expect(await within(h, 3_000)).toMatchObject({ outcome: 'limit' });
      } finally {
        h.stop();
      }
    });

    caseFor(gaps, 'turn-limit')('a run past its turn cap ends in limit', async () => {
      const s = make();
      const h = start(s, 'chatty', { limits: { turns: 2, durationMs: 10_000, usd: 5 } });
      try {
        expect(await within(h, 3_000)).toMatchObject({ outcome: 'limit' });
      } finally {
        h.stop();
      }
    });
  });
}
