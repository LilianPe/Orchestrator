import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubAppApi } from '../../src/adapters/forge/github-app-api.js';
import { runDoctor, type HostReport } from '../../src/cli/doctor.js';
import { appOptions, gate, gh, GITHUB_ENV, LiveForge, REPO } from './github-live.js';

/**
 * Isolation n° 12: a factory PR sees no CI secret (ORC-219, against ORC-135). The test repository holds a secret its CI
 * reads, behind an environment a human must approve, as `factory doctor` asks:
 * - the secret `ISO_CANARY`, any value;
 * - the environment `iso-canary`, with a required reviewer;
 * - `.github/workflows/iso-canary.yml`, on `push` and `pull_request`, whose one job runs under `environment: iso-canary`
 *   and reads `secrets.ISO_CANARY`.
 * The real `doctor` accepts that repository, and refuses the same workflows without the reviewer (the control). Then the
 * factory opens a real draft PR from a `factory/` branch: the canary's runs wait for the reviewer, none ran with the secret.
 * The PR is closed and its branch deleted after; the waiting runs are cancelled if the App may, rejected by hand otherwise.
 */
const CANARY = '.github/workflows/iso-canary.yml';
const ENVIRONMENT = 'iso-canary';

const { skip, title } = gate('isolation 12: a factory PR sees no CI secret', GITHUB_ENV);

describe.skipIf(skip)(title, () => {
  let forge: LiveForge;
  let token = '';
  let branch = '';
  let pr: number | undefined;

  beforeAll(async () => {
    forge = new LiveForge(appOptions());
    token = await forge.token(REPO);
  }, 120_000);

  afterAll(async () => {
    if (pr) await gh(`/repos/${REPO}/pulls/${pr}`, token, { method: 'PATCH', body: { state: 'closed' } });
    if (branch) await gh(`/repos/${REPO}/git/refs/heads/${branch}`, token, { method: 'DELETE' });
  }, 120_000);

  it("doctor accepts the test repository, whose CI reads a secret behind a human's approval; without it, refuses", async () => {
    const live = new GitHubAppApi(appOptions());
    // The CI secret check alone: the host, the branch protection (ORC-208) and the App's installation (ORC-439) are other verdicts, held accepted here.
    const branchProtection = async () => ({ branch: 'main', classic: false, rules: ['pull_request'], pullRequestRulesets: [{ id: 1, bypass: 'never' }] });
    const installationPermissions = async () => ({});
    const host: HostReport = { verdict: 'accepted', reasons: ['held accepted'] };
    const api = { listWorkflows: (p: string) => live.listWorkflows(p), listEnvironments: (p: string) => live.listEnvironments(p), branchProtection, installationPermissions };
    const lines: string[] = [];
    expect(await runDoctor({ repoPath: REPO, api, host, out: (l) => lines.push(l), json: true }), lines.join('\n')).toBe(0);
    const report = JSON.parse(lines.join('\n')) as { workflows: { path: string; secrets: boolean; verdict: string }[] };
    expect(report.workflows, `${CANARY} is missing from the test repository`).toContainEqual(expect.objectContaining({ path: CANARY, secrets: true, verdict: 'accepted' }));
    // The control: the same workflows, the environment without its reviewer.
    const unprotected = { ...api, listEnvironments: async () => [{ name: ENVIRONMENT, requiredReviewers: false }] };
    expect(await runDoctor({ repoPath: REPO, api: unprotected, host, out: () => {}, json: true })).toBe(1);
  }, 120_000);

  it("a factory PR's CI does not run the job that reads the secret: it waits for the reviewer", async () => {
    const { body: repo } = await gh(`/repos/${REPO}`, token);
    const base = repo.default_branch as string;
    const { body: head } = await gh(`/repos/${REPO}/commits/${base}`, token);
    // A commit of the factory's on its own branch: the base's tree, so the PR changes nothing.
    const commit = await gh(`/repos/${REPO}/git/commits`, token, { method: 'POST', body: { message: 'iso-12: a factory PR', tree: head.commit.tree.sha, parents: [head.sha] } });
    expect(commit.status).toBe(201);
    branch = `factory/iso-12-${Date.now()}`;
    expect((await gh(`/repos/${REPO}/git/refs`, token, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.body.sha } })).status).toBe(201);
    pr = (await forge.ensurePr(REPO, { branch, base, title: 'iso-12: a factory PR', body: 'Isolation test n° 12 (ORC-219): closed by the test.', draft: true })).number;

    // The canary's runs on that head, the PR's own among them, once each is waiting or done.
    type Run = { id: number; path: string; event: string; status: string };
    let runs: Run[] = [];
    for (let i = 0; i < 60; i++) {
      const listed = await gh(`/repos/${REPO}/actions/runs?head_sha=${commit.body.sha}`, token);
      expect(listed.status, 'the runs are unreadable: the App needs Actions: read').toBe(200);
      runs = (listed.body.workflow_runs as Run[]).filter((r) => r.path === CANARY || r.path.startsWith(`${CANARY}@`));
      if (runs.some((r) => r.event === 'pull_request') && runs.every((r) => ['waiting', 'completed'].includes(r.status))) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(runs.map((r) => r.event), `no run of ${CANARY} for the factory's PR after 5 minutes`).toContain('pull_request');
    try {
      for (const run of runs) {
        expect(run.status, `run ${run.id}`).toBe('waiting');
        const pending = await gh(`/repos/${REPO}/actions/runs/${run.id}/pending_deployments`, token);
        expect((pending.body as { environment: { name: string } }[]).map((d) => d.environment.name)).toContain(ENVIRONMENT);
        const { body: jobs } = await gh(`/repos/${REPO}/actions/runs/${run.id}/jobs`, token);
        expect((jobs.jobs as { conclusion: string | null }[]).filter((j) => j.conclusion === 'success')).toEqual([]);
      }
    } finally {
      for (const run of runs) await gh(`/repos/${REPO}/actions/runs/${run.id}/cancel`, token, { method: 'POST' });
    }
  }, 420_000);
});

/**
 * What `current_user_can_bypass` means for the App's token on the real GitHub (ORC-427): `doctor` credits a ruleset that
 * requires a pull request only when it reads `never` there. The test repository holds two active rulesets, each with the
 * rule "Require a pull request before merging" alone:
 * - `iso-guarded`, on the branch `iso-protection/guarded`, with no bypass actor;
 * - `iso-bypassed`, on the branch `iso-protection/bypassed`, with the test App as a bypass actor, "Always allow".
 * The App cannot create them (no Administration permission): a human does, once (docs/tests.md). The test creates either
 * branch when absent. For each, the oracle is GitHub itself: the App's token moves the branch without a pull request, and
 * `doctor`'s verdict must be the one that push gives: accepted where GitHub refuses it, refused where it lands.
 */
const PROTECTION = [
  { branch: 'iso-protection/guarded', ruleset: 'iso-guarded', bypassable: false },
  { branch: 'iso-protection/bypassed', ruleset: 'iso-bypassed', bypassable: true },
];

const protectionGate = gate("isolation 12: doctor reads the branch protection the App's token really has", GITHUB_ENV);

describe.skipIf(protectionGate.skip)(protectionGate.title, () => {
  let token = '';

  /**
   * The canary's runs on the test branches, which the pushes here start and its environment holds waiting: cancelled
   * before and after, so they do not pile up (a run that shows up after the test goes with the next one).
   */
  const cancelCanaryRuns = async () => {
    for (const { branch } of PROTECTION) {
      const { body } = await gh(`/repos/${REPO}/actions/runs?branch=${encodeURIComponent(branch)}&event=push`, token);
      const runs = ((body?.workflow_runs ?? []) as { id: number; path: string; status: string }[]).filter((r) => r.path.startsWith(CANARY) && r.status !== 'completed');
      for (const run of runs) await gh(`/repos/${REPO}/actions/runs/${run.id}/cancel`, token, { method: 'POST' });
    }
  };

  beforeAll(async () => {
    token = await new LiveForge(appOptions()).token(REPO);
    await cancelCanaryRuns();
  }, 120_000);

  afterAll(async () => {
    if (token) await cancelCanaryRuns();
  }, 120_000);

  it.each(PROTECTION)('$branch ($ruleset): what doctor reads and judges matches a direct push of the App', async ({ branch, ruleset, bypassable }) => {
    const live = new GitHubAppApi(appOptions());
    let ref = await gh(`/repos/${REPO}/git/ref/heads/${branch}`, token);
    if (ref.status === 404) {
      const { body: repo } = await gh(`/repos/${REPO}`, token);
      const { body: base } = await gh(`/repos/${REPO}/commits/${repo.default_branch as string}`, token);
      const created = await gh(`/repos/${REPO}/git/refs`, token, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.sha } });
      expect(created.status, `cannot create ${branch}: create it by hand from the default branch (docs/tests.md)`).toBe(201);
      ref = await gh(`/repos/${REPO}/git/ref/heads/${branch}`, token);
    }
    expect(ref.status).toBe(200);
    const head = ref.body.object.sha as string;

    // What doctor reads: the ruleset is there, and GitHub says whether the App may bypass it.
    const protection = await live.branchProtection(REPO, branch);
    expect(protection.pullRequestRulesets, `no active ruleset requires a pull request on ${branch}: create ${ruleset} (docs/tests.md)`).not.toEqual([]);
    expect(protection.pullRequestRulesets.map((r) => r.bypass)).toEqual(protection.pullRequestRulesets.map(() => (bypassable ? 'always' : 'never')));

    // What doctor judges, the other verdicts held accepted.
    const host: HostReport = { verdict: 'accepted', reasons: ['held accepted'] };
    const api = { listWorkflows: async () => [], listEnvironments: async () => [], branchProtection: () => live.branchProtection(REPO, branch), installationPermissions: async () => ({}) };
    const lines: string[] = [];
    const code = await runDoctor({ repoPath: REPO, api, host, out: (l) => lines.push(l), json: true });
    const report = JSON.parse(lines.join('\n')) as { branchProtection: { branch: string; verdict: string } };
    expect(report.branchProtection, lines.join('\n')).toMatchObject({ branch, verdict: bypassable ? 'refused' : 'accepted' });
    expect(code).toBe(bypassable ? 1 : 0);

    // The oracle: the App's token moves the branch without a pull request, to a commit of the same tree.
    const { body: commit } = await gh(`/repos/${REPO}/git/commits/${head}`, token);
    const next = await gh(`/repos/${REPO}/git/commits`, token, { method: 'POST', body: { message: 'iso-12: a direct push (ORC-427)', tree: commit.tree.sha, parents: [head] } });
    expect(next.status).toBe(201);
    const push = await gh(`/repos/${REPO}/git/refs/heads/${branch}`, token, { method: 'PATCH', body: { sha: next.body.sha, force: false } });
    try {
      if (bypassable) expect(push.status, JSON.stringify(push.body)).toBe(200);
      else {
        // Refused by the ruleset, not for a missing permission: the bypassed branch shows the token may push.
        expect(push.status, JSON.stringify(push.body)).toBe(422);
        expect(String(push.body?.message)).toMatch(/rule/i);
      }
    } finally {
      // A push that landed, expected or not, put back where it was, so the branch does not grow with each run.
      if (push.status === 200) await gh(`/repos/${REPO}/git/refs/heads/${branch}`, token, { method: 'PATCH', body: { sha: head, force: true } });
    }
  }, 120_000);
});
