import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeCheckRunner } from '../../src/adapters/checks/fake.js';
import type { CheckRunner } from '../../src/adapters/checks/types.js';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import type { Forge } from '../../src/adapters/forge/types.js';
import { FakeRunner } from '../../src/adapters/runner/fake.js';
import type { RunHandle, RunRequest } from '../../src/adapters/runner/types.js';
import { FakeTracker } from '../../src/adapters/tracker/fake.js';
import { runVerify } from '../../src/core/verify.js';
import { describeAgentRuntimeContract, type AgentRuntimeSubject } from './agent-runtime.contract.js';
import { contractCases } from './cases.js';
import { describeCheckRunnerContract, type CheckRunnerSubject } from './check-runner.contract.js';
import { describeForgeContract, type ForgeSubject } from './forge.contract.js';
import { describeTrackerContract, type TrackerSubject } from './tracker.contract.js';

// Each subject breaks one guarantee on purpose: the case that checks it must fail against it.

const LAUNCH = 'a run that cannot launch ends in failure: start does not throw, done does not reject, the stream closes';
const NOWHERE = '/contract-cannot-launch';

function runtimeThat(start: (inner: FakeRunner, req: RunRequest) => RunHandle): () => AgentRuntimeSubject {
  return () => {
    const inner = new FakeRunner();
    return {
      runtime: { start: (req) => start(inner, req) },
      script: (name) => (name === 'unlaunchable' ? (inner.enqueue({ events: [], outcome: 'failure' }), { cwd: NOWHERE }) : {}),
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

const cwd = mkdtempSync(join(tmpdir(), 'factory-negative-'));

function checksThat(checks: CheckRunner, patch: Partial<CheckRunnerSubject> = {}): () => CheckRunnerSubject {
  return () => ({
    checks,
    cwd,
    pass: 'true',
    fails: [
      { command: 'exit 1', exitCode: 1, output: '' },
      { command: 'exit 2', exitCode: 2, output: '' },
    ],
    unstartableCwd: join(cwd, 'no-such-dir'),
    ...patch,
  });
}

describeCheckRunnerContract(
  'a check runner that rejects when a command cannot start',
  checksThat({ run: async (dir, commands, timeoutMs) => (existsSync(dir) ? runVerify(dir, commands, timeoutMs) : Promise.reject(new Error('spawn bash ENOENT'))) }),
  { violates: ['a command that cannot start fails without an exit code, and run does not reject'] },
);

describeCheckRunnerContract(
  'a check runner that skips the commands it cannot start',
  checksThat({ run: async (dir, commands, timeoutMs) => (existsSync(dir) ? runVerify(dir, commands, timeoutMs) : { ok: true, failures: [] }) }),
  { violates: ['a command that cannot start fails without an exit code, and run does not reject'] },
);

describeCheckRunnerContract(
  'a check runner that answers a replay from its cache',
  () => {
    const seen = new Set<string>();
    const fake = new FakeCheckRunner();
    const run = fake.run;
    fake.run = async (dir, commands, timeoutMs) => {
      const key = commands.join('\n');
      if (seen.has(key)) return { ok: true, failures: [] };
      seen.add(key);
      return run(dir, commands, timeoutMs);
    };
    return checksThat(fake, { counted: { command: 'npm run count', runs: async () => fake.calls.length } })();
  },
  { violates: ['replaying runs the commands again'] },
);

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
  { violates: ['findPr and unresolvedReviewComments reject when the forge does not answer'] },
);

const unreadable = (findPr: Forge['findPr']): Partial<ForgeSubject> => {
  const fake = new FakeForge();
  return { forge: { findPr, unresolvedReviewComments: (r, n) => fake.unresolvedReviewComments(r, n) }, unreadableChecks: 'factory/rel-2-y' };
};

describeForgeContract(
  'a forge that rejects checks it cannot read',
  forgeThat(unreadable(async () => Promise.reject(new SyntaxError('Unexpected token n in JSON')))),
  { violates: ['findPr gives none for checks it cannot read'] },
);

describeForgeContract(
  'a forge that reports checks it cannot read as pending',
  forgeThat(
    unreadable(async (_repo, branch) => ({ number: 8, url: 'https://github.test/pr/8', state: 'OPEN', branch, checks: 'pending', failedChecks: [] })),
  ),
  { violates: ['findPr gives none for checks it cannot read'] },
);

const EFFECTS = 'comment, activity and addExternalUrl write their effect; replaying comment or activity writes it again';

function trackerThat(tracker: FakeTracker): () => TrackerSubject {
  return () => {
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV des audits' });
    return {
      tracker,
      issue: 'REL-1',
      missing: 'REL-404',
      states: ['In Progress', 'Human Review'],
      written: {
        comments: async (issue) => tracker.comments(issue),
        activities: async (session) => tracker.activities(session),
        externalUrls: async (session) => tracker.externalUrls(session),
      },
    };
  };
}

describeTrackerContract(
  'a tracker whose comment writes nothing',
  () =>
    trackerThat(
      new (class extends FakeTracker {
        override async comment(identifier: string): Promise<void> {
          await this.getIssue(identifier);
        }
      })(),
    )(),
  { violates: [EFFECTS] },
);

describeTrackerContract(
  'a tracker that drops a replayed activity',
  () =>
    trackerThat(
      new (class extends FakeTracker {
        override async activity(sessionId: string, a: Parameters<FakeTracker['activity']>[1]): Promise<void> {
          if (this.activities(sessionId).some((b) => JSON.stringify(b) === JSON.stringify(a))) return;
          await super.activity(sessionId, a);
        }
      })(),
    )(),
  { violates: [EFFECTS] },
);

describeTrackerContract(
  'a tracker whose addExternalUrl writes nothing',
  () =>
    trackerThat(
      new (class extends FakeTracker {
        override async addExternalUrl(): Promise<void> {}
      })(),
    )(),
  { violates: [EFFECTS] },
);

describe('contractCases', () => {
  it('rejects a violates entry that names no case of the suite', () => {
    const { it: kase, end } = contractCases({ violates: ['a case renamed since'] });
    kase('a case of the suite', () => {});
    expect(end).toThrow('violates names no case of the suite: a case renamed since');
  });
});
