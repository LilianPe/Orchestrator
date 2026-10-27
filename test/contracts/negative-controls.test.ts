import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import { FakeCheckRunner } from '../../src/adapters/checks/fake.js';
import type { CheckRunner } from '../../src/adapters/checks/types.js';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import type { Forge } from '../../src/adapters/forge/types.js';
import { Channel } from '../../src/adapters/runner/channel.js';
import { FakeRunner, type FakeScript } from '../../src/adapters/runner/fake.js';
import type { RunHandle, RunRequest, RunResult, RunStreamEvent } from '../../src/adapters/runner/types.js';
import { FakeSandboxProvider } from '../../src/adapters/sandbox/fake.js';
import { FakeTracker } from '../../src/adapters/tracker/fake.js';
import type { TrackerIssue } from '../../src/adapters/tracker/types.js';
import { FakeClock } from '../../src/core/clock.js';
import type { RunOutcome, VerifyFailure } from '../../src/core/types.js';
import { runVerify, type VerifyResult } from '../../src/core/verify.js';
import { describeAgentRuntimeContract, type AgentRuntimeSubject, type AgentScript } from './agent-runtime.contract.js';
import { asNegativeControl, contractCases } from './cases.js';
import { describeCheckRunnerContract, type CheckRunnerSubject } from './check-runner.contract.js';
import { describeForgeContract, type ForgeSubject } from './forge.contract.js';
import { describeSandboxContract, type SandboxSubject } from './sandbox.contract.js';
import { describeTrackerContract, type TrackerSubject } from './tracker.contract.js';

// Each subject breaks one guarantee on purpose: the case that checks it must fail against it.

const LAUNCH = 'a run that cannot launch ends in failure: start does not throw, done does not reject, the stream closes';
const NOWHERE = '/contract-cannot-launch';

const fakeScripts: Partial<Record<AgentScript, FakeScript>> = {
  failure: { outcome: 'failure' },
  hang: { hold: true },
  chatty: { events: ['un', 'deux', 'trois'].map((text) => ({ kind: 'text', text })), turns: 3, hold: true },
  unlaunchable: { events: [], outcome: 'failure' },
};

function runtimeThat(start: (inner: FakeRunner, req: RunRequest) => RunHandle): () => AgentRuntimeSubject {
  return () => {
    const clock = new FakeClock();
    const inner = new FakeRunner(clock);
    return {
      runtime: { start: (req) => start(inner, req) },
      script: (name) => (inner.enqueue(fakeScripts[name] ?? {}), name === 'unlaunchable' ? { cwd: NOWHERE } : {}),
      elapse: (ms) => (clock.advance(ms), inner.tick()),
    };
  };
}

describeAgentRuntimeContract(
  'a runtime whose start throws when it cannot launch',
  runtimeThat((inner, req) => {
    if (req.cwd === NOWHERE) throw new Error('spawn claude ENOENT');
    return inner.start(req);
  }),
  { violates: [LAUNCH] },
);

describeAgentRuntimeContract(
  'a runtime whose done rejects when it cannot launch',
  runtimeThat((inner, req) => {
    const h = inner.start(req);
    return req.cwd === NOWHERE ? { ...h, done: Promise.reject(new Error('spawn claude ENOENT')) } : h;
  }),
  { violates: [LAUNCH] },
);

describeAgentRuntimeContract(
  'a runtime that reports a launch failure as a success',
  runtimeThat((inner, req) => {
    const h = inner.start(req);
    return req.cwd === NOWHERE ? { ...h, done: h.done.then((r) => ({ ...r, outcome: 'success' as const })) } : h;
  }),
  { violates: [LAUNCH] },
);

describeAgentRuntimeContract(
  'a runtime whose stream never closes when it cannot launch',
  runtimeThat((inner, req) => {
    const h = inner.start(req);
    return req.cwd === NOWHERE ? { ...h, events: new Channel<RunStreamEvent>() } : h;
  }),
  { violates: [LAUNCH] },
);

const FAILED = 'a failed run ends in failure';
const DURATION_CAP = 'a run past its duration cap ends in limit';
const TURN_CAP = 'a run past its turn cap ends in limit';

const ending = (from: RunOutcome, end: (r: RunResult) => RunResult | Promise<RunResult>) => (inner: FakeRunner, req: RunRequest): RunHandle => {
  const h = inner.start(req);
  return { ...h, done: h.done.then((r) => (r.outcome === from ? end(r) : r)) };
};

describeAgentRuntimeContract(
  'a runtime that reports a failed run as a success',
  runtimeThat(ending('failure', (r) => ({ ...r, outcome: 'success' }))),
  { violates: [FAILED] },
);

describeAgentRuntimeContract(
  'a runtime whose done rejects when the run fails',
  runtimeThat(ending('failure', () => Promise.reject(new Error('claude exited with code 1')))),
  { violates: [FAILED] },
);

describeAgentRuntimeContract(
  'a runtime that ignores its duration cap',
  runtimeThat((inner, req) => inner.start({ ...req, limits: { ...req.limits, durationMs: Infinity } })),
  { violates: [DURATION_CAP] },
);

describeAgentRuntimeContract(
  'a runtime that ignores its turn cap',
  runtimeThat((inner, req) => inner.start({ ...req, limits: { ...req.limits, turns: Infinity } })),
  { violates: [TURN_CAP] },
);

describeAgentRuntimeContract(
  'a runtime that ends a capped run in failure',
  runtimeThat(ending('limit', (r) => ({ ...r, outcome: 'failure' }))),
  { violates: [DURATION_CAP, TURN_CAP] },
);

describeAgentRuntimeContract(
  'a runtime whose done rejects when a run hits its cap',
  runtimeThat(ending('limit', () => Promise.reject(new Error('max turns reached')))),
  { violates: [DURATION_CAP, TURN_CAP] },
);

const UNSTARTABLE = 'a command that cannot start fails without an exit code, and run does not reject';
const REPLAY = 'replaying runs the commands again';
const cwd = mkdtempSync(join(tmpdir(), 'factory-negative-'));

function checksThat(checks: CheckRunner, patch: Partial<CheckRunnerSubject> = {}): () => CheckRunnerSubject {
  return () => ({
    checks,
    cwd,
    pass: 'true',
    fails: [
      { command: 'echo first failure; exit 1', exitCode: 1, output: 'first failure' },
      { command: 'echo second failure; exit 2', exitCode: 2, output: 'second failure' },
    ],
    slow: 'sleep 0.5',
    unstartableCwd: join(cwd, 'missing'),
    ...patch,
  });
}

describeCheckRunnerContract(
  'a check runner that rejects when a command cannot start',
  checksThat({ run: async (dir, commands, timeoutMs) => (existsSync(dir) ? runVerify(dir, commands, timeoutMs) : Promise.reject(new Error('spawn bash ENOENT'))) }),
  { violates: [UNSTARTABLE] },
);

describeCheckRunnerContract(
  'a check runner that skips the commands it cannot start',
  checksThat({ run: async (dir, commands, timeoutMs) => (existsSync(dir) ? runVerify(dir, commands, timeoutMs) : { ok: true, failures: [] }) }),
  { violates: [UNSTARTABLE] },
);

describeCheckRunnerContract(
  'a check runner that answers a replay from its cache',
  () => {
    const seen = new Set<string>();
    const fake = new FakeCheckRunner();
    const run: CheckRunner['run'] = async (dir, commands, timeoutMs) => {
      const key = commands.join('\n');
      if (seen.has(key)) return { ok: true, failures: [] };
      seen.add(key);
      return fake.run(dir, commands, timeoutMs);
    };
    return checksThat({ run }, { counted: { command: 'npm run count', runs: async () => fake.calls.length } })();
  },
  { violates: [REPLAY] },
);

const FAILING = 'reports a failing command with its exit code and output';
const IN_ORDER = 'runs every command and reports the failures in order';
const TIMEOUT = 'a command that outlives the timeout fails without an exit code';

const verifying = (then: (r: VerifyResult) => VerifyResult | Promise<VerifyResult>): CheckRunner => ({
  run: async (dir, commands, timeoutMs) => then(await runVerify(dir, commands, timeoutMs)),
});
const eachFailure = (patch: (f: VerifyFailure) => VerifyFailure) => verifying((r) => ({ ...r, failures: r.failures.map(patch) }));

describeCheckRunnerContract(
  'a check runner that drops the output of a failure',
  checksThat(eachFailure((f) => ({ ...f, output: '' }))),
  { violates: [FAILING] },
);

describeCheckRunnerContract(
  'a check runner that reports a failure without its exit code',
  checksThat(eachFailure((f) => ({ ...f, exitCode: null }))),
  { violates: [FAILING, IN_ORDER] },
);

describeCheckRunnerContract(
  'a check runner that reports a failure as a pass',
  checksThat({ run: async () => ({ ok: true, failures: [] }) }),
  { violates: [FAILING, IN_ORDER, TIMEOUT] },
);

describeCheckRunnerContract(
  'a check runner whose run rejects when a command fails',
  checksThat(verifying((r) => (r.ok ? r : Promise.reject(new Error(`${r.failures[0]!.command} failed`))))),
  { violates: [FAILING, IN_ORDER, TIMEOUT] },
);

describeCheckRunnerContract(
  'a check runner that stops at the first failure',
  checksThat({
    run: async (dir, commands, timeoutMs) => {
      for (const command of commands) {
        const r = await runVerify(dir, [command], timeoutMs);
        if (!r.ok) return r;
      }
      return { ok: true, failures: [] };
    },
  }),
  { violates: [IN_ORDER] },
);

describeCheckRunnerContract(
  'a check runner that reports the failures out of order',
  checksThat(verifying((r) => ({ ...r, failures: [...r.failures].reverse() }))),
  { violates: [IN_ORDER] },
);

describeCheckRunnerContract(
  'a check runner that ignores the timeout',
  checksThat({ run: (dir, commands) => runVerify(dir, commands) }),
  { violates: [TIMEOUT] },
);

describeCheckRunnerContract(
  'a check runner that gives a timed-out command an exit code',
  checksThat(eachFailure((f) => ({ ...f, exitCode: f.exitCode ?? 137 }))),
  { violates: [TIMEOUT] },
);

const UNREACHABLE = 'findPr and unresolvedReviewComments reject when the forge does not answer';
const UNREADABLE = 'findPr gives none for checks it cannot read';

function forgeThat(patch: Partial<ForgeSubject>): () => ForgeSubject {
  return () => {
    const forge = new FakeForge();
    forge.setPr('factory/rel-1-x', { number: 7, url: 'https://github.test/pr/7', state: 'OPEN', checks: 'pass', failedChecks: [] });
    return { forge, repoPath: '/repo', missingBranch: 'factory/rel-404', pr: { branch: 'factory/rel-1-x', number: 7 }, ...patch };
  };
}

describeForgeContract(
  'a forge that answers nothing instead of rejecting when it cannot reach the forge',
  forgeThat({ unreachable: { findPr: async () => undefined, unresolvedReviewComments: async () => [] } }),
  { violates: [UNREACHABLE] },
);

describeForgeContract(
  'a forge that answers no review threads instead of rejecting when it cannot reach the forge',
  forgeThat({
    unreachable: { findPr: async () => Promise.reject(new Error('forge unreachable')), unresolvedReviewComments: async () => [] },
  }),
  { violates: [UNREACHABLE] },
);

const findingPr = (findPr: Forge['findPr']): Partial<ForgeSubject> => ({ forge: { findPr, unresolvedReviewComments: async () => [] } });
const unreadable = (findPr: Forge['findPr']): Partial<ForgeSubject> => ({ ...findingPr(findPr), unreadableChecks: 'factory/rel-2-y' });

describeForgeContract(
  'a forge that rejects checks it cannot read',
  forgeThat(unreadable(async () => Promise.reject(new SyntaxError('Unexpected token n in JSON')))),
  { violates: [UNREADABLE] },
);

describeForgeContract(
  'a forge that reports checks it cannot read as pending',
  forgeThat(
    unreadable(async (_repo, branch) => ({ number: 8, url: 'https://github.test/pr/8', state: 'OPEN', branch, checks: 'pending', failedChecks: [] })),
  ),
  { violates: [UNREADABLE] },
);

const NO_PR = 'findPr answers undefined for a branch without a PR';

describeForgeContract(
  'a forge that finds a PR on every branch',
  forgeThat(findingPr(async (_repo, branch) => ({ number: 7, url: 'https://github.test/pr/7', state: 'OPEN', branch, checks: 'pass', failedChecks: [] }))),
  { violates: [NO_PR] },
);

describeForgeContract(
  'a forge that rejects a branch without a PR',
  forgeThat(findingPr(async (_repo, branch) => Promise.reject(new Error(`no pull requests found for branch "${branch}"`)))),
  { violates: [NO_PR] },
);

const EFFECTS = 'comment, activity and addExternalUrl write their effect; replaying comment or activity writes it again';

function trackerThat(Tracker: new () => FakeTracker): () => TrackerSubject {
  return () => {
    const tracker = new Tracker();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV des audits' });
    return { tracker, issue: 'REL-1', missing: 'REL-404', states: ['In Progress', 'Human Review'], written: tracker.written() };
  };
}

describeTrackerContract(
  'a tracker whose comment writes nothing',
  trackerThat(
    class extends FakeTracker {
      override async comment(identifier: string): Promise<void> {
        await this.getIssue(identifier);
      }
    },
  ),
  { violates: [EFFECTS] },
);

describeTrackerContract(
  'a tracker that drops a replayed activity',
  trackerThat(
    class extends FakeTracker {
      override async activity(sessionId: string, a: Parameters<FakeTracker['activity']>[1]): Promise<void> {
        if (this.activities(sessionId).some((b) => JSON.stringify(b) === JSON.stringify(a))) return;
        await super.activity(sessionId, a);
      }
    },
  ),
  { violates: [EFFECTS] },
);

describeTrackerContract(
  'a tracker whose ensureSession opens no session',
  trackerThat(
    class extends FakeTracker {
      override async ensureSession(identifier: string): Promise<string> {
        await this.getIssue(identifier);
        return 'session-never-opened';
      }
    },
  ),
  { violates: ['ensureSession opens an agent session on the issue'] },
);

describeTrackerContract(
  'a tracker whose addExternalUrl writes nothing',
  trackerThat(
    class extends FakeTracker {
      override async addExternalUrl(): Promise<void> {}
    },
  ),
  { violates: [EFFECTS] },
);

const UNKNOWN_READ = 'getIssue rejects an unknown issue';
const UNKNOWN_WRITE = 'every write rejects an unknown issue';
const UNKNOWN_STATE = 'moveTo rejects a state the team does not have and keeps the state';

describeTrackerContract(
  'a tracker whose getIssue answers an unknown issue with another one',
  trackerThat(
    class extends FakeTracker {
      override async getIssue(identifier: string): Promise<TrackerIssue> {
        return super.getIssue(this.issues.has(identifier) ? identifier : 'REL-1');
      }
    },
  ),
  { violates: [UNKNOWN_READ] },
);

describeTrackerContract(
  'a tracker whose moveTo ignores an unknown issue',
  trackerThat(
    class extends FakeTracker {
      override async moveTo(identifier: string, stateName: string): Promise<void> {
        if (this.issues.has(identifier)) await super.moveTo(identifier, stateName);
      }
    },
  ),
  { violates: [UNKNOWN_WRITE] },
);

describeTrackerContract(
  'a tracker whose setLabels ignores an unknown issue',
  trackerThat(
    class extends FakeTracker {
      override async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
        if (this.issues.has(identifier)) await super.setLabels(identifier, add, remove);
      }
    },
  ),
  { violates: [UNKNOWN_WRITE] },
);

describeTrackerContract(
  'a tracker whose comment ignores an unknown issue',
  trackerThat(
    class extends FakeTracker {
      override async comment(identifier: string, body: string): Promise<void> {
        if (this.issues.has(identifier)) await super.comment(identifier, body);
      }
    },
  ),
  { violates: [UNKNOWN_WRITE] },
);

describeTrackerContract(
  'a tracker whose ensureSession opens a session on an unknown issue',
  trackerThat(
    class extends FakeTracker {
      override async ensureSession(identifier: string): Promise<string> {
        return this.issues.has(identifier) ? super.ensureSession(identifier) : 'session-on-nothing';
      }
    },
  ),
  { violates: [UNKNOWN_WRITE] },
);

describeTrackerContract(
  'a tracker whose moveTo ignores a state the team does not have',
  trackerThat(
    class extends FakeTracker {
      override async moveTo(identifier: string, stateName: string): Promise<void> {
        const { teamKey } = await this.getIssue(identifier);
        if (this.statesOf(teamKey).includes(stateName)) await super.moveTo(identifier, stateName);
      }
    },
  ),
  { violates: [UNKNOWN_STATE] },
);

describeTrackerContract(
  'a tracker whose moveTo writes a state the team does not have, then rejects',
  trackerThat(
    class extends FakeTracker {
      override async moveTo(identifier: string, stateName: string): Promise<void> {
        const { teamKey } = await this.getIssue(identifier);
        if (this.statesOf(teamKey).includes(stateName)) return super.moveTo(identifier, stateName);
        this.issues.get(identifier)!.stateName = stateName;
        throw new Error(`unknown state ${stateName} for team ${teamKey}`);
      }
    },
  ),
  { violates: [UNKNOWN_STATE] },
);

describeTrackerContract(
  'a tracker whose moveTo loses the issue on a state the team does not have',
  trackerThat(
    class extends FakeTracker {
      override async moveTo(identifier: string, stateName: string): Promise<void> {
        const { teamKey } = await this.getIssue(identifier);
        if (this.statesOf(teamKey).includes(stateName)) return super.moveTo(identifier, stateName);
        this.issues.delete(identifier);
        throw new Error(`unknown state ${stateName} for team ${teamKey}`);
      }
    },
  ),
  { violates: [UNKNOWN_STATE] },
);

const DELEGATED = 'listDelegated lists the team issues delegated to the app, and only them';

describeTrackerContract(
  'a tracker whose listDelegated lists every team',
  () => {
    const tracker = new (class extends FakeTracker {
      override async listDelegated(): Promise<Awaited<ReturnType<FakeTracker['listDelegated']>>> {
        return [...(await super.listDelegated('REL')), ...(await super.listDelegated('OPS'))];
      }
    })();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV des audits', delegateId: 'app' });
    tracker.addIssue({ identifier: 'REL-2', title: 'Autre ticket' });
    tracker.addIssue({ identifier: 'OPS-1', title: 'Ticket délégué d’une autre équipe', delegateId: 'app' });
    return { tracker, issue: 'REL-1', missing: 'REL-404', delegation: { teamKey: 'REL', delegated: 'REL-1', notDelegated: 'REL-2' } };
  },
  { violates: [DELEGATED] },
);

const UNKNOWN_ID = 'destroy is idempotent and ignores an unknown id';

function sandboxesThat(Provider: new () => FakeSandboxProvider): () => SandboxSubject {
  return () => {
    const provider = new Provider();
    return {
      provider,
      request: { runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'none' },
      active: async () => provider.active().map((s) => s.id),
    };
  };
}

describeSandboxContract(
  'a sandbox provider whose destroy rejects an id it no longer has',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async destroy(id: string): Promise<void> {
        if (!this.active().some((s) => s.id === id)) throw new Error(`no such container: ${id}`);
        await super.destroy(id);
      }
    },
  ),
  { violates: [UNKNOWN_ID] },
);

describeSandboxContract(
  'a sandbox provider whose destroy rejects an id it never created',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async destroy(id: string): Promise<void> {
        if (!this.active().some((s) => s.id === id) && !this.destroyed.includes(id)) throw new Error(`no such container: ${id}`);
        await super.destroy(id);
      }
    },
  ),
  { violates: [UNKNOWN_ID] },
);

describe('contractCases', () => {
  it('rejects a violates entry that names no case of the suite', () => {
    const { it: kase, end } = contractCases({ violates: ['a case renamed since'] });
    kase('a case of the suite', () => {});
    expect(end).toThrow('violates names no case of the suite: a case renamed since');
  });

  it('rejects an empty violates, which would run no case at all', () => {
    expect(() => contractCases({ violates: [] })).toThrow('violates names no case');
  });

  it('fails a negative control whose subject lacks a field the case needs, instead of skipping it', async () => {
    let skipped = false;
    const ctx = { skip: () => void (skipped = true) } as unknown as TestContext;
    await expect(asNegativeControl((c) => c.skip())(ctx)).rejects.toMatchObject({ name: 'AssertionError' });
    expect(skipped).toBe(false);
  });
});
