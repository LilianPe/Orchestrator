import { DEFAULT_REQUIREMENTS } from '../../src/adapters/sandbox/types.js';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import { FakeCheckRunner } from '../../src/adapters/checks/fake.js';
import type { CheckRunner } from '../../src/adapters/checks/types.js';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import type { Forge } from '../../src/adapters/forge/types.js';
import type { ExecResult } from '../../src/adapters/exec.js';
import { Channel } from '../../src/adapters/runner/channel.js';
import { FakeRunner, type FakeScript } from '../../src/adapters/runner/fake.js';
import type { RunHandle, RunRequest, RunResult, RunStreamEvent } from '../../src/adapters/runner/types.js';
import { FakePublisher } from '../../src/adapters/publisher/fake.js';
import type { Publication, Publisher } from '../../src/adapters/publisher/types.js';
import { FakeSandboxProvider } from '../../src/adapters/sandbox/fake.js';
import type { Sandbox, SandboxRequest, SandboxRequirements } from '../../src/adapters/sandbox/types.js';
import { FakeTracker } from '../../src/adapters/tracker/fake.js';
import type { TrackerIssue } from '../../src/adapters/tracker/types.js';
import { FakeClock } from '../../src/core/clock.js';
import type { RunOutcome, VerifyFailure } from '../../src/core/types.js';
import { runVerify, type VerifyResult } from '../../src/core/verify.js';
import { describeAgentRuntimeContract, type AgentRuntimeSubject, type AgentScript } from './agent-runtime.contract.js';
import { asNegativeControl, contractCases } from './cases.js';
import { describeCheckRunnerContract, type CheckRunnerSubject } from './check-runner.contract.js';
import { describeForgeContract, type ForgeSubject } from './forge.contract.js';
import { describePublisherContract, type PublisherSubject } from './publisher.contract.js';
import { describeSandboxContract, EXEC_PROBE, type SandboxSubject } from './sandbox.contract.js';
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

const STOP = 'stop ends a running run in stopped and closes its stream; stopping again changes nothing';
const STOP_AFTER_END = 'stop after the end keeps the outcome';
const INDEPENDENT = 'runs are independent: stopping one leaves the other running';

describeAgentRuntimeContract(
  'a runtime whose stop ends the run in failure',
  runtimeThat(ending('stopped', (r) => ({ ...r, outcome: 'failure' }))),
  { violates: [STOP, INDEPENDENT] },
);

describeAgentRuntimeContract(
  'a runtime whose stop does nothing',
  runtimeThat((inner, req) => ({ ...inner.start(req), stop: () => {} })),
  { violates: [STOP, INDEPENDENT] },
);

describeAgentRuntimeContract(
  'a runtime whose stream stays open after stop',
  runtimeThat((inner, req) => ({ ...inner.start(req), events: new Channel<RunStreamEvent>() })),
  { violates: [STOP] },
);

describeAgentRuntimeContract(
  'a runtime whose second stop throws',
  runtimeThat((inner, req) => {
    const h = inner.start(req);
    let stopped = false;
    return {
      ...h,
      stop: () => {
        if (stopped) throw new Error('run already stopped');
        stopped = true;
        h.stop();
      },
    };
  }),
  { violates: [STOP] },
);

/** A handle that knows when its run has ended, for the subjects that misbehave on a stop after the end. */
const onceEnded = (inner: FakeRunner, req: RunRequest, handle: (h: RunHandle, ended: () => boolean) => RunHandle): RunHandle => {
  const h = inner.start(req);
  let ended = false;
  void h.done.then(() => (ended = true));
  return handle(h, () => ended);
};

describeAgentRuntimeContract(
  'a runtime whose stop throws once the run has ended',
  runtimeThat((inner, req) =>
    onceEnded(inner, req, (h, ended) => ({
      ...h,
      stop: () => {
        if (ended()) throw new Error('run already finished');
        h.stop();
      },
    })),
  ),
  { violates: [STOP_AFTER_END] },
);

describeAgentRuntimeContract(
  'a runtime that rewrites the outcome of an ended run it is asked to stop',
  runtimeThat((inner, req) =>
    onceEnded(inner, req, (h, ended) => {
      let stoppedLate = false;
      return {
        events: h.events,
        get done() {
          return stoppedLate ? h.done.then((r) => ({ ...r, outcome: 'stopped' as const })) : h.done;
        },
        stop: () => {
          if (ended()) stoppedLate = true;
          h.stop();
        },
      };
    }),
  ),
  { violates: [STOP_AFTER_END] },
);

describeAgentRuntimeContract(
  'a runtime whose stop stops every run',
  () => {
    const handles: RunHandle[] = [];
    return runtimeThat((inner, req) => {
      const h = inner.start(req);
      handles.push(h);
      return { ...h, stop: () => handles.forEach((x) => x.stop()) };
    })();
  },
  { violates: [INDEPENDENT] },
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
  'a check runner that reports an exit code for a command that cannot start',
  checksThat({
    run: async (dir, commands, timeoutMs) =>
      existsSync(dir)
        ? runVerify(dir, commands, timeoutMs)
        : { ok: false, failures: commands.map((command) => ({ command, exitCode: 127, output: `bash: ${dir}: No such file or directory` })) },
  }),
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

const NO_CHECKS = 'findPr gives none for an open PR without any check';
const CHECKS_DOWN = 'findPr rejects when the forge answers the PR but not its checks';
const openPr = (branch: string) => ({ number: 9, url: 'https://github.test/pr/9', state: 'OPEN' as const, branch, failedChecks: [] });
const withoutChecks = (findPr: Forge['findPr']): Partial<ForgeSubject> => ({ ...findingPr(findPr), noChecks: 'factory/rel-3-z' });

describeForgeContract(
  'a forge that reads checks it failed to fetch as none',
  forgeThat({ ...findingPr(async (_repo, branch) => ({ ...openPr(branch), checks: 'none' })), checksDown: 'factory/rel-4-w' }),
  { violates: [CHECKS_DOWN] },
);

describeForgeContract(
  'a forge that rejects an open PR without any check',
  forgeThat(withoutChecks(async (_repo, branch) => Promise.reject(new Error(`no checks reported on the '${branch}' branch`)))),
  { violates: [NO_CHECKS] },
);

describeForgeContract(
  'a forge that reports an open PR without any check as pending',
  forgeThat(withoutChecks(async (_repo, branch) => ({ ...openPr(branch), checks: 'pending' }))),
  { violates: [NO_CHECKS] },
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
  'a tracker whose getIssue rejects an unknown issue with a plain error, as a read error',
  trackerThat(
    class extends FakeTracker {
      override async getIssue(identifier: string): Promise<TrackerIssue> {
        if (!this.issues.has(identifier)) throw new Error(`unknown issue ${identifier}`);
        return super.getIssue(identifier);
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

const MOVE = 'moveTo sets the state and replaying it changes nothing';
const LABELS = 'setLabels writes the final set: replayable, unknown labels created, absent removals ignored';

describeTrackerContract(
  'a tracker whose moveTo writes nothing',
  trackerThat(
    class extends FakeTracker {
      override async moveTo(identifier: string): Promise<void> {
        await this.getIssue(identifier);
      }
    },
  ),
  { violates: [MOVE] },
);

describeTrackerContract(
  'a tracker whose replayed moveTo rejects',
  trackerThat(
    class extends FakeTracker {
      override async moveTo(identifier: string, stateName: string): Promise<void> {
        if ((await this.getIssue(identifier)).stateName === stateName) throw new Error(`${identifier} is already in ${stateName}`);
        await super.moveTo(identifier, stateName);
      }
    },
  ),
  { violates: [MOVE] },
);

describeTrackerContract(
  'a tracker whose setLabels ignores the removals',
  trackerThat(
    class extends FakeTracker {
      override async setLabels(identifier: string, add: string[]): Promise<void> {
        await super.setLabels(identifier, add, []);
      }
    },
  ),
  { violates: [LABELS] },
);

describeTrackerContract(
  'a tracker whose setLabels rejects the removal of a label the issue does not have',
  trackerThat(
    class extends FakeTracker {
      override async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
        const { labels } = await this.getIssue(identifier);
        const absent = remove.find((l) => !labels.includes(l));
        if (absent) throw new Error(`label ${absent} is not on ${identifier}`);
        await super.setLabels(identifier, add, remove);
      }
    },
  ),
  { violates: [LABELS] },
);

describeTrackerContract(
  'a tracker whose setLabels drops the labels the team does not have yet',
  trackerThat(
    class extends FakeTracker {
      override async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
        const known = new Set([...this.issues.values()].flatMap((i) => i.labels));
        await super.setLabels(identifier, add.filter((l) => known.has(l)), remove);
      }
    },
  ),
  { violates: [LABELS] },
);

describeTrackerContract(
  'a tracker whose replayed setLabels takes off the labels it adds again',
  trackerThat(
    class extends FakeTracker {
      override async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
        const { labels } = await this.getIssue(identifier);
        await super.setLabels(identifier, add.filter((l) => !labels.includes(l)), [...remove, ...add.filter((l) => labels.includes(l))]);
      }
    },
  ),
  { violates: [LABELS] },
);

const UNKNOWN_ID = 'destroy is idempotent and ignores an unknown id';

function sandboxesThat(Provider: new () => FakeSandboxProvider, extra: Partial<SandboxSubject> = {}): () => SandboxSubject {
  return () => {
    const provider = new Provider();
    provider.execResult = () => EXEC_PROBE.result;
    return {
      provider,
      request: { runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts: [] },
      active: async () => provider.active().map((s) => s.id),
      ...extra,
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

const CREATE_REPLAY = 'create replayed for the same run returns its sandbox instead of a second one';
const SANDBOX_PER_RUN = 'each run gets its own sandbox';
const RECREATE = 'after destroy, create for the same run gives a new sandbox';

describeSandboxContract(
  'a sandbox provider whose replayed create opens a second sandbox',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async create(req: SandboxRequest): Promise<Sandbox> {
        return super.create({ ...req, runId: `${req.runId}#${this.created.length}` });
      }
    },
  ),
  { violates: [CREATE_REPLAY] },
);

describeSandboxContract(
  'a sandbox provider that keeps one sandbox per ticket',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async create(req: SandboxRequest): Promise<Sandbox> {
        return super.create({ ...req, runId: req.ticketId });
      }
    },
  ),
  { violates: [SANDBOX_PER_RUN] },
);

describeSandboxContract(
  'a sandbox provider that names a sandbox after its run',
  sandboxesThat(
    class extends FakeSandboxProvider {
      private named = new Map<string, Sandbox>();

      override async create(req: SandboxRequest): Promise<Sandbox> {
        const sandbox = this.named.get(req.runId) ?? { id: `factory-${req.runId}`, network: req.network, level: 'L3' as const };
        this.named.set(req.runId, sandbox);
        return { ...sandbox };
      }

      override async destroy(id: string): Promise<void> {
        for (const [runId, s] of this.named) if (s.id === id) this.named.delete(runId);
      }

      override active(): Sandbox[] {
        return [...this.named.values()].map((s) => ({ ...s }));
      }
    },
  ),
  { violates: [RECREATE] },
);

const EXEC = 'exec returns the exit code and the output, a non-zero exit included';
const EXEC_UNKNOWN = 'exec rejects on an unknown or destroyed sandbox';
const SPAWN_UNKNOWN = 'spawnCommand throws on an unknown sandbox';
const FIND = 'findByAttempt finds the live sandbox of a run, and nothing once it is destroyed';
const LIST = 'list holds each live sandbox with its run, and no destroyed one';
const REFUSE = 'create rejects requirements nothing satisfies, naming the unmet one, and makes no sandbox';

describeSandboxContract(
  'a sandbox provider whose exec reports success whatever the command did',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async exec(id: string, argv: readonly string[]): Promise<ExecResult> {
        return { ...(await super.exec(id, argv)), code: 0 };
      }
    },
  ),
  { violates: [EXEC] },
);

describeSandboxContract(
  'a sandbox provider whose exec answers for a sandbox it does not have',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async exec(): Promise<ExecResult> {
        return { stdout: '', stderr: '', code: 0 };
      }
    },
  ),
  { violates: [EXEC_UNKNOWN] },
);

describeSandboxContract(
  'a sandbox provider whose spawnCommand builds a command for a sandbox it does not have',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override spawnCommand(_id: string, argv: readonly string[]): string[] {
        return [...argv];
      }
    },
  ),
  { violates: [SPAWN_UNKNOWN] },
);

describeSandboxContract(
  'a sandbox provider that still finds an attempt by its label once destroyed',
  sandboxesThat(
    class extends FakeSandboxProvider {
      private byRun = new Map<string, Sandbox>();

      override async create(req: SandboxRequest): Promise<Sandbox> {
        const sandbox = await super.create(req);
        this.byRun.set(req.runId, sandbox);
        return sandbox;
      }

      override async findByAttempt(runId: string): Promise<Sandbox | undefined> {
        return this.byRun.get(runId);
      }
    },
  ),
  { violates: [FIND] },
);

describeSandboxContract(
  'a sandbox provider whose list loses the run of each sandbox',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async list(): Promise<{ runId: string; sandbox: Sandbox }[]> {
        return (await super.list()).map(({ sandbox }) => ({ runId: sandbox.id, sandbox }));
      }
    },
  ),
  { violates: [LIST] },
);

const L5: SandboxRequirements = { minLevel: 'L5', browser: false, services: [] };

describeSandboxContract('a sandbox provider that falls back to a weaker sandbox than required', sandboxesThat(FakeSandboxProvider, { unsatisfiable: { requirements: L5, unmet: /L5/ } }), {
  violates: [REFUSE],
});

describeSandboxContract(
  'a sandbox provider whose refusal does not name the unmet requirement',
  sandboxesThat(
    class extends FakeSandboxProvider {
      override async create(req: SandboxRequest): Promise<Sandbox> {
        if (req.requirements.minLevel !== 'L3') throw new Error('sandbox refused');
        return super.create(req);
      }
    },
    { unsatisfiable: { requirements: L5, unmet: /L5/ } },
  ),
  { violates: [REFUSE] },
);

const REPUBLISH = 'republishing a branch updates its PR instead of opening a second one';
const PR_PER_BRANCH = 'each branch gets its own PR';
const REOPEN = 'once the branch PR is merged or closed, publishing opens a new one';

function publishersThat(publisher: (forge: FakeForge) => Publisher): () => PublisherSubject {
  return () => {
    const forge = new FakeForge();
    return {
      publisher: publisher(forge),
      request: { projectId: 'p', repoPath: '/repo', ticketId: 'REL-1', branch: 'factory/rel-1-x', sha: 'aaa', title: 'feat: x', body: 'b' },
      end: async (branch, prNumber) =>
        forge.setPr(branch, { number: prNumber, url: `https://github.test/pr/${prNumber}`, state: 'MERGED', checks: 'pass', failedChecks: [] }),
    };
  };
}

describePublisherContract(
  'a publisher that opens a new PR at each publish',
  publishersThat(() => {
    let opened = 0;
    return { publish: async (req) => ({ prNumber: ++opened, url: `https://github.test/pr/${opened}`, sha: req.sha }) };
  }),
  { violates: [REPUBLISH, REOPEN] },
);

describePublisherContract(
  'a publisher whose republish answers the first sha it pushed',
  publishersThat((forge) => {
    const inner = new FakePublisher(forge);
    const first = new Map<string, string>();
    return {
      publish: async (req) => {
        const p = await inner.publish(req);
        if (!first.has(req.branch)) first.set(req.branch, p.sha);
        return { ...p, sha: first.get(req.branch)! };
      },
    };
  }),
  { violates: [REPUBLISH] },
);

describePublisherContract(
  'a publisher that keeps one PR per ticket',
  publishersThat((forge) => {
    const inner = new FakePublisher(forge);
    return { publish: (req) => inner.publish({ ...req, branch: req.ticketId }) };
  }),
  { violates: [PR_PER_BRANCH] },
);

describePublisherContract(
  'a publisher that keeps answering a merged PR',
  publishersThat(() => {
    const prs = new Map<string, Publication>();
    return {
      publish: async (req) => {
        const pr = prs.get(req.branch) ?? { prNumber: prs.size + 1, url: `https://github.test/pr/${prs.size + 1}`, sha: req.sha };
        prs.set(req.branch, pr);
        return { ...pr, sha: req.sha };
      },
    };
  }),
  { violates: [REOPEN] },
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
