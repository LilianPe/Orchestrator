import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubAppApi } from '../../src/adapters/forge/github-app-api.js';
import { runDoctor } from '../../src/cli/doctor.js';
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
    const api = new GitHubAppApi(appOptions());
    const lines: string[] = [];
    expect(await runDoctor({ repoPath: REPO, api, out: (l) => lines.push(l), json: true }), lines.join('\n')).toBe(0);
    const report = JSON.parse(lines.join('\n')) as { workflows: { path: string; secrets: boolean; verdict: string }[] };
    expect(report.workflows, `${CANARY} is missing from the test repository`).toContainEqual(expect.objectContaining({ path: CANARY, secrets: true, verdict: 'accepted' }));
    // The control: the same workflows, the environment without its reviewer.
    const unprotected = { listWorkflows: (p: string) => api.listWorkflows(p), listEnvironments: async () => [{ name: ENVIRONMENT, requiredReviewers: false }], appLogin: () => api.appLogin() };
    expect(await runDoctor({ repoPath: REPO, api: unprotected, out: () => {}, json: true })).toBe(1);
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
