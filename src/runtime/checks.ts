import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sandbox } from '../adapters/sandbox/types.js';
import { NO_REPO_VARIABLES, type RepoVariables } from '../config/repo-variables.js';
import { parseRepoConfig, setupOf, type RepoConfig, type RepoConfigRead } from '../config/repo-config.js';
import type { JobSpec } from '../core/workflow.js';
import type { RunRecord } from '../store/types.js';
import type { AgentOutput, PreviewRecipe } from '../core/agent-output.js';
import type { Effect } from '../core/decision.js';
import { goesThroughFreeze } from '../core/engine.js';
import { isNote, noSearchReason, repoNameOf, searchAsked, type ReadNote, type SearchContext } from '../knowledge/preview-recipe.js';
import { type QueueName, type FactoryEvent, type TicketState, type VerifyFailure, TRUSTED } from '../core/types.js';
import { checkBranchPaths, classOfBranch, runCleanVerify, untrustedCheck, type CleanVerifyRequest, type CleanVerifyResult, type UntrustedMark, type VisualRequest } from '../core/clean-verify.js';
import { dryRunFingerprint, dryRunHolds, dryRunVerdict, mainCardValue, runDryRun, type DryRun } from '../core/dry-run.js';
import { MAIN_CARD } from '../core/maturity.js';
import { logExcerpt } from '../checks/log-excerpt.js';
import { cappedCommand, cappedExit, type VerifyResult } from '../core/verify.js';
import { needsRefreeze, type ClassifiedDiff } from '../core/diff-class.js';
import { checkRed, type RedDeps, type RedResult } from '../checks/red.js';
import { checkFrozen, FREEZE_CHECK, freezeTests, newTestsOnly, REFREEZE, type FrozenTests } from '../checks/freeze.js';
import { isTestFile } from '../checks/test-files.js';
import { propertySupport, propertyTests } from '../checks/properties.js';
import { approvedProperties } from '../core/spec.js';
import { captureArtifactId, scenarioPath } from '../checks/visual-proof.js';
import { parseStatus } from '../adapters/workspace/git-workspaces.js';
import { factoryDefault } from '../presets/factory-default.js';
import { DaemonBase, redBaseKey } from './daemon-base.js';
import type { ProjectRuntime } from './daemon.js';

/** A verdict on a commit: what ran on it, absent when it was found green before and nothing ran again. */
type Verified = VerifyResult & { sha?: string | undefined; commands?: readonly string[]; visual?: CleanVerifyResult['visual']; flaky?: CleanVerifyResult['flaky']; diffClass?: CleanVerifyResult['diffClass'] };

/** A human's push is checked in a fresh clone of the forge (ORC-159): without sandboxes there is none, whatever stands in for `verify`. */
const PUSH_NEEDS_SANDBOXES = 'no sandbox (FACTORY_CONTAINER_CLI): a commit a human pushed is only checked in a fresh clone of the forge, which needs the sandboxes.';

/** The daemon's checks (ORC-394): `verify`, the clean check, the red check, the freeze and the verdict a check submits. */
export abstract class DaemonChecks extends DaemonBase {
  /** `.factory/config.yml` on the default branch (ORC-209 C): it rejects on an invalid file. */
  protected async repoConfigOf(project: ProjectRuntime, read?: RepoConfigRead): Promise<RepoConfig> {
    return this.d.repoConfig ? this.d.repoConfig(project, read) : parseRepoConfig(undefined);
  }

  /**
   * What the runner gets of the repository (ORC-211), from `config` when the caller has it (the launch's read, kept on
   * the run; `verify`'s), else read here without a fetch, for a run recorded before ORC-209 C: none when it cannot be
   * read, the caller goes on.
   */
  protected async repoVariablesOf(project: ProjectRuntime, config?: RepoConfig): Promise<RepoVariables> {
    if (!this.d.repoVariables) return NO_REPO_VARIABLES;
    try {
      return await this.d.repoVariables(project, config ?? (await this.repoConfigOf(project, { fetch: false })));
    } catch (err) {
      this.log('warn', `${project.id}: repository variables not read: ${(err as Error).message}`);
      return NO_REPO_VARIABLES;
    }
  }

  /**
   * The `red` check of a finished `tests` run (ORC-123): the step's commits from the head it started on, read on the
   * factory's repository; its uncommitted files and its tests run in a sandbox of their own without network, on the
   * host as `verify` without sandboxes. A check that cannot run gives no verdict on the tests: `infra`. The approved spec's
   * properties each want their test (ORC-261), frozen with the generators it imports.
   */
  protected async checkRed(project: ProjectRuntime, run: RunRecord, t: TicketState): Promise<RedResult & { frozen?: FrozenTests }> {
    const sandboxes = this.d.sandboxes;
    const redRunId = `${run.id}-red`;
    let sandbox: Sandbox | undefined;
    try {
      // The repository's test command (ORC-391), as the launch read `.factory/config.yml`: no command, no red to check.
      const command = (run.repoConfig ?? (await this.repoConfigOf(project, { fetch: false }))).commands['test'];
      if (!command) throw new Error('`.factory/config.yml` has no `commands.test` to run the tests with');
      const base = await this.d.store.getMeta(redBaseKey(project.id, run.ticketId));
      if (!base) throw new Error('the starting commit of the step is not recorded');
      const diff = await this.d.workspaces.stepDiff(project.mirror, run.cwd, base);
      if (!diff) throw new Error(`no worktree at ${run.cwd}`);
      let uncommitted: string[];
      let runTests: RedDeps['run'];
      if (!sandboxes) {
        const verify = this.standInVerify();
        uncommitted = await this.d.workspaces.uncommitted(run.cwd);
        const { env } = await this.repoVariablesOf(project, run.repoConfig);
        runTests = async (cmd) => {
          const res = await verify(run.cwd, [cmd], undefined, env);
          return res.ok ? { exitCode: 0, output: '' } : { exitCode: res.failures[0]!.exitCode, output: res.failures[0]!.output };
        };
      } else {
        // Not the ticket session: an empty per-run `~/.claude`, as any run that does not resume it.
        const box = (sandbox = await this.openSandbox(sandboxes, project, run.ticketId, { path: run.cwd }, redRunId, false, { level: 'none', allow: [] }));
        // The tests must fail on the missing behaviour, not on a variable the repository declares (ORC-211).
        const { env } = await this.repoVariablesOf(project, run.repoConfig);
        const status = await sandboxes.exec(box.id, ['git', 'status', '--porcelain', '-z', '--untracked-files=all']);
        if (status.code !== 0) throw new Error(`git status: ${status.stderr.trim()}`);
        uncommitted = parseStatus(status.stdout);
        runTests = async (cmd) => {
          const started = Date.now();
          const r = await sandboxes.exec(box.id, cappedCommand(cmd), { env });
          return { exitCode: cappedExit(r.code, started), output: r.stdout + r.stderr };
        };
      }
      const count = approvedProperties(t.spec);
      // Read once: the property tests, the generators they import and the freeze all look at the same commit.
      const files = await diff.filesAtHead();
      const view = { ...diff, filesAtHead: async () => files };
      const properties = count ? propertyTests(t.ticketId, count, files) : [];
      const red = await checkRed(command, { ...diff, uncommitted, run: runTests, ...(count ? { properties: { ticketId: t.ticketId, count, atHead: properties } } : {}) });
      // The freeze (ORC-131) on the same commit: the step's tests and the harness, whatever the red's verdict.
      // ponytail: committed files only; a test left uncommitted is not frozen (verify reads commits once ORC-151 lands).
      const tests = diff.changed.filter((f) => !f.deleted && isTestFile(f.path)).map((f) => f.path);
      // The generators of the property tests (ORC-261), whoever wrote them and whenever: what a property draws its inputs from.
      const read = await freezeTests([...tests, ...(await propertySupport(properties, view))], view);
      return { ...red, frozen: t.frozenTests ? newTestsOnly(read) : read };
    } catch (err) {
      return { verified: false, cause: 'infra', command: '', exitCode: null, detail: `The red check could not run: ${(err as Error).message}` };
    } finally {
      if (sandbox) await this.destroySandbox(sandbox.id, redRunId, run);
    }
  }

  /**
   * The commands of a job on what its run committed (ORC-151): out of the agent's worktree and the daemon, in
   * `runCleanVerify`. It throws when there is no verdict, an infrastructure failure the agent is not sent. Without
   * sandboxes, only the fake runner's or a test's stand-in (`DaemonDeps.verify`), which runs nothing of the agent's (ORC-179).
   */
  protected async verifyWork(project: ProjectRuntime, t: TicketState, run: RunRecord, job: JobSpec, output?: AgentOutput): Promise<Verified> {
    const { sandboxes } = this.d;
    if (!sandboxes) {
      const verify = this.standInVerify();
      // Read before the commands: what they would commit is not what they checked.
      const sha = await this.d.workspaces.head(run.cwd);
      // As on the clone, before any command: a refused branch runs nothing.
      const { failures: paths, diffClass } = await this.checkPathsOnHost(project, t, run);
      const verified = paths.length || !job.verify.length ? { ok: true, failures: [] } : await verify(run.cwd, job.verify, undefined, (await this.repoVariablesOf(project, run.repoConfig)).env, (m) => this.log('warn', `verify of ${t.ticketId}: ${m}`));
      // `factory/tests-gelés` (ORC-131), blocking from the first ticket, on top of the job's commands.
      const frozen = goesThroughFreeze(t, job) ? await this.checkFrozen(project, run.cwd, t.frozenTests!) : [];
      const blocking = [...paths, ...frozen];
      return { ...verified, ok: verified.ok && blocking.length === 0, failures: [...verified.failures, ...blocking], sha, commands: job.verify, diffClass };
    }
    // The commit a job writes, which it publishes (ORC-176).
    const recipe = await this.recipeOf(project, t);
    // Asked at the launch on the config it read (`searchAsked`, ORC-386): only then is the agent's recipe tried, or the search spent.
    // The launch's own decision, kept on the run (ORC-406): another ticket's write to the note since then changes nothing of what was
    // asked. Recomputed only for a run recorded before it was kept.
    const asked = !!recipe && (run.previewSearch ?? searchAsked(this.searchContext(project, job, run.repoConfig, run.startFingerprint), recipe.note));
    const found = asked ? output?.preview : undefined;
    const noSearch = recipe && !asked ? noSearchReason(recipe.note, run.startFingerprint) : undefined;
    const res = await this.cleanCheck(project, t, run.id, job, { ...(t.humanHead ? { humanHead: t.humanHead } : {}), visual: this.visualRequest(project, t, output, recipe?.note, found, noSearch) });
    // Beside the verdict, never in its way: a write to the knowledge base waits for its pull and its push. Never a replayed ticket's.
    const recipes = this.d.previewRecipes;
    if (recipe && recipes && !project.replayed) {
      const settled = recipes.settle(recipe.repo, recipe.note, { asked, found, outcome: res.preview, sha: res.sha, port: project.workflow.workspace.portBase, runId: run.id, ticket: t.ticketId, at: new Date(this.d.clock.now()), fingerprint: run.startFingerprint, declared: !!run.repoConfig?.preview }, (text) => this.policy.vet(text, 'start recipe'));
      this.track(settled.then(
        (said) => void (said && this.log('warn', `${t.ticketId}: ${said}`)),
        (err: Error) => this.log('warn', `${t.ticketId}: start recipe of ${recipe.repo} not written to the knowledge base: ${err.message}`),
      ));
    }
    return res;
  }

  /**
   * The repository's start recipe as the knowledge base holds it (ORC-386), by the name its origin gives it: a replayed ticket's in
   * the knowledge base at its start (ORC-376), none with `--memory off`. Undefined without a knowledge base; a note it cannot read
   * is logged and read as none to search for, never written over.
   */
  protected async recipeOf(project: ProjectRuntime, t: TicketState): Promise<{ repo: string; note: ReadNote } | undefined> {
    const recipes = this.d.previewRecipes;
    const replayed = project.replayed;
    if (!recipes || (replayed && replayed.knowledge === undefined)) return undefined;
    const repo = repoNameOf(await this.d.originUrl?.(project).catch(() => undefined), project.id);
    try {
      return { repo, note: recipes.read(repo, replayed?.knowledge) };
    } catch (err) {
      this.log('warn', `${t.ticketId}: start recipe of ${repo} not read from the knowledge base: ${(err as Error).message}`);
      return { repo, note: 'unreadable' };
    }
  }

  /** What decides, at a `build` launch and at its check alike, whether its agent searches a start recipe (ORC-386). */
  protected searchContext(project: ProjectRuntime, job: JobSpec, config: RepoConfig | undefined, fingerprint: string | undefined): SearchContext {
    return {
      fingerprint,
      step: job.step,
      canShoot: !!this.d.visualProof,
      replayed: !!project.replayed,
      declared: !!config?.preview,
      services: !!config?.services.length,
    };
  }

  /**
   * The last dry run asked of each project's default branch, under way or waiting for the one before (ORC-409): the launches and
   * `factory dry-run` that ask meanwhile share it.
   */
  private readonly dryRuns = new Map<string, { run: Promise<DryRun>; started: boolean }>();

  /**
   * The dry run of a project (ORC-408), on the forge's default branch or on the commit `sha`: its `setup` and commands in the
   * sandboxes (`runDryRun`), in a place of its own under `runsDir/<id>`, then recorded, red or green. It rejects when it cannot run
   * (no sandboxes, an engine or a forge down): nothing is recorded then. On the default branch, one at a time by project: who asks
   * while one is under way gets its result (ORC-409), or with `fresh` a new one once it ended, which reads what changed meanwhile:
   * one for all who ask before it starts.
   */
  async dryRun(projectId: string, o: { sha?: string; fresh?: boolean } = {}): Promise<DryRun> {
    if (o.sha) return this.runDry(projectId, o.sha);
    const last = this.dryRuns.get(projectId);
    if (last && (!o.fresh || !last.started)) return last.run;
    // After the one under way, whatever its end: never two dry runs of a project at once.
    // With none before it, it starts now.
    const entry = { started: !last } as { run: Promise<DryRun>; started: boolean };
    entry.run = (last ? last.run.catch(() => undefined) : Promise.resolve())
      .then(() => {
        entry.started = true;
        return this.runDry(projectId);
      })
      .finally(() => {
        if (this.dryRuns.get(projectId) === entry) this.dryRuns.delete(projectId);
      });
    this.dryRuns.set(projectId, entry);
    return entry.run;
  }

  /** Whether a delegated ticket of `project` waits for its dry run (ORC-409): with sandboxes, which run it; never a replayed ticket's. */
  protected dryRunGates(project: ProjectRuntime): boolean {
    return !!(this.d.sandboxes && this.d.runnerImage && this.d.dryRunFiles) && !project.replayed;
  }

  /**
   * The red dry run that refuses a delegated ticket of `project` (ORC-409), or undefined: the last one on the default branch while
   * it holds (`dryRunHolds`), else one run now, which the launch waits for. A project's first delegation runs its first dry run.
   * `config`: `.factory/config.yml` as the launch read it, whose `setup` the dry run would run.
   */
  protected async refusingDryRun(project: ProjectRuntime, config: RepoConfig): Promise<DryRun | undefined> {
    if (!this.dryRunGates(project)) return undefined;
    const [{ sha, ...files }, last] = await Promise.all([this.d.dryRunFiles!(project), this.d.store.lastDryRun(project.id)]);
    const fingerprint = dryRunFingerprint({ setup: setupOf(config, project.workflow.workspace.setup), image: this.d.runnerImage!, ...files });
    const now = { sha, fingerprint };
    if (last && dryRunHolds(last, now)) return last.ok ? undefined : last;
    let run = await this.dryRun(project.id);
    // Red on other inputs than this launch's: one under way since before a fix of the default branch. Run anew, once.
    if (!run.ok && !dryRunHolds(run, now)) run = await this.dryRun(project.id, { fresh: true });
    return run.ok ? undefined : run;
  }

  /** What a clone of ours reads a private forge with (ORC-442), as the project's repository is fetched; none for a replayed ticket's, read from its local clone. */
  private forgeEnvOf(project: ProjectRuntime): { forgeEnv?: () => Promise<Record<string, string>> } {
    const auth = this.d.gitAuth;
    return auth && !project.replayed ? { forgeEnv: () => auth(project.github) } : {};
  }

  private async runDry(projectId: string, sha?: string): Promise<DryRun> {
    const project = this.d.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const { sandboxes, runsDir, originUrl, runnerImage } = this.d;
    if (!sandboxes || !runsDir || !originUrl || !runnerImage) throw new Error('a dry run runs in the sandboxes: FACTORY_CONTAINER_CLI and FACTORY_RUNNER_IMAGE are required');
    const id = `dry-${randomUUID()}`;
    const runDir = join(runsDir, id);
    const workDir = join(runDir, 'dry-run');
    mkdirSync(workDir, { recursive: true });
    try {
      const run = await (this.d.dryRunner ?? runDryRun)({
        sandboxes,
        runId: id,
        projectId,
        originUrl: await originUrl(project),
        ...this.forgeEnvOf(project),
        ...(sha ? { sha } : {}),
        workDir,
        setup: project.workflow.workspace.setup,
        // The commands `verify` runs on a ticket's code when `.factory/config.yml` declares none: the `dev` job's.
        commands: project.workflow.jobs['dev']?.verify ?? [],
        image: runnerImage,
        // Unreadable, it rejects (not `repoVariablesOf`): a dry run without the repository's variables would record the factory's breakdown as red.
        env: async (config) => (this.d.repoVariables ? (await this.d.repoVariables(project, config)).env : {}),
        knownFlaky: await this.d.store.knownFlakyTests(projectId),
        now: () => this.d.clock.now(),
        log: (message) => this.log('warn', `dry run of ${projectId}: ${message}`),
      });
      await this.d.store.putDryRun(run);
      // The project's `main` maturity card, when init stored one (ORC-437): a failure to set it leaves the dry run recorded.
      if (run.target === 'main') {
        await this.d.store.setMaturityCardValue(projectId, MAIN_CARD, mainCardValue(run), this.d.clock.now()).catch((err: Error) => this.log('warn', `dry run of ${projectId}: main maturity card not set: ${err.message}`));
      }
      this.log('info', `dry run of ${projectId} on ${run.sha.slice(0, 12)}: ${run.ok ? dryRunVerdict(run) : `red (${run.breaks.map((b) => b.kind).join(', ')})`}`);
      return run;
    } finally {
      await rm(runDir, { recursive: true, force: true }).catch((err: Error) => this.log('warn', `dry run of ${projectId}: ${runDir} not removed: ${err.message}`));
    }
  }

  /**
   * `runCleanVerify` for the ticket under the checks of `job`, in a place of its own under `runsDir/<runId>`: the commit
   * the agent's worktree holds, or with `head` a human's push, as the forge holds it (ORC-159).
   */
  private async cleanCheck(project: ProjectRuntime, t: TicketState, runId: string, job: JobSpec, over: Pick<CleanVerifyRequest, 'green' | 'head' | 'humanHead' | 'visual'>): Promise<CleanVerifyResult> {
    const { sandboxes, runsDir, originUrl } = this.d;
    if (!sandboxes || !runsDir || !originUrl) throw new Error('runsDir and originUrl are required with sandboxes');
    if (!t.branch || (!over.head && !t.worktreePath)) throw new Error(`no branch or no worktree for ${t.ticketId}`);
    const untrusted = await this.untrustedMark(project, t);
    // A place the engine mounts from, new for each check: one cut can leave its own behind.
    const workDir = join(runsDir, runId, `verify-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      return await (this.d.cleanVerify ?? runCleanVerify)({
        sandboxes,
        runId,
        ticketId: t.ticketId,
        branch: t.branch,
        worktree: t.worktreePath ?? '',
        originUrl: await originUrl(project),
        ...this.forgeEnvOf(project),
        workDir,
        setup: project.workflow.workspace.setup,
        commands: job.verify,
        gitleaks: true,
        semgrep: true,
        ...(this.d.maxDiff ? { maxDiff: this.d.maxDiff } : {}),
        knownFlaky: await this.d.store.knownFlakyTests(project.id),
        ...over,
        ...(goesThroughFreeze(t, job) ? { frozen: t.frozenTests! } : {}),
        ...(untrusted ? { untrusted } : {}),
        ...(this.d.registries ? { registries: this.d.registries } : {}),
        env: async (config) => (await this.repoVariablesOf(project, config)).env,
        log: (message) => this.log('warn', `verify of ${t.ticketId}: ${message}`),
      });
    } finally {
      // Under the check's dir, purged with it: what the attack left unremovable costs no verdict.
      await rm(workDir, { recursive: true, force: true }).catch((err: Error) => this.log('warn', `verify of ${t.ticketId}: ${workDir} not removed: ${err.message}`));
    }
  }

  /** What `verify` needs of the visual proof (ORC-176): the ticket's intake, never what the agent says of it but the page it names. */
  private visualRequest(project: ProjectRuntime, t: TicketState, output: AgentOutput | undefined, note: ReadNote, found: PreviewRecipe | undefined, noSearch: string | undefined): VisualRequest {
    return {
      intake: t.visualProof === 'required',
      ...(this.d.visualProof ? { shooter: this.d.visualProof.shooter } : {}),
      // ORC-386: the learned recipe; the one the agent found only where it was asked to search.
      ...(isNote(note) && note.status === 'valid' ? { learned: note.recipe } : {}),
      ...(found ? { found } : {}),
      ...(noSearch ? { noSearch } : {}),
      port: project.workflow.workspace.portBase,
      path: scenarioPath(output?.visual_scenario?.url),
      gate: (c) => this.policy.capture(c),
    };
  }

  /**
   * The captures `verify` took (ORC-176), kept before the verdict that names them: each file by its hash, under `artifactsDir`, which
   * no run mounts, and its row in `artifacts`, once by its id. A capture that cannot be kept throws: no verdict names a missing file.
   */
  private async keepCaptures(t: TicketState, runId: string, files: NonNullable<CleanVerifyResult['visual']>['files']): Promise<void> {
    // Only a shooter takes captures, and it comes with its dir.
    const dir = join(this.d.visualProof!.artifactsDir, t.ticketId);
    await mkdir(dir, { recursive: true });
    const createdAt = this.d.clock.now();
    await Promise.all(
      files.map(async ({ capture, png }) => {
        const path = join(dir, `${capture.sha256}.png`);
        await writeFile(path, png);
        await this.d.store.putArtifact({ id: captureArtifactId(runId, capture), ticketId: t.ticketId, attemptId: runId, kind: 'visual-proof', path, sha256: capture.sha256, createdAt });
      }),
    );
  }

  /**
   * `verify` on a human's push (ORC-159): the pushed commit as the forge holds it, in a fresh clone, under the checks of the
   * job the factory publishes, the freeze included; never in the agent's worktree, and no run of it. Its verdict keeps the
   * check's id. Without sandboxes there is no clone to check it in, so no verdict: an infrastructure failure.
   */
  protected verifyPush(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'run_verify' }>, head: string): void {
    const job = project.workflow.jobs[c.job];
    // No longer awaited (a newer push, a stop): a replayed effect checks nothing.
    if (!job || t.verifyingRunId !== c.runId) return;
    // Without sandboxes there is nothing to run, so no slot to wait for: the verdict is the infrastructure failure at once.
    if (!this.d.sandboxes) return this.track(this.submitVerdict(project, t, c.runId, job, () => Promise.reject(new Error(PUSH_NEEDS_SANDBOXES))));
    this.withSlot(project, t.ticketId, job.queue, c.runId, (now) =>
      this.submitVerdict(project, now, c.runId, job, async () => {
        try {
          return await this.cleanCheck(project, now, c.runId, job, { head });
        } finally {
          // The check's own folder: no run purges it.
          if (this.d.runsDir) await rm(join(this.d.runsDir, c.runId), { recursive: true, force: true }).catch(() => {});
        }
      }),
    );
  }

  /**
   * A check runs the agent's code within the slots of `queue` (ORC-353), as its runs do: `concurrency` bounds both. It waits
   * for a slot, then checks the ticket as it is by then, nothing if it no longer awaits that check, and drains the queue once
   * done. A daemon that stops runs its waiting checks without a slot, as before slots counted them, and its shutdown waits
   * for them: a check dropped would come back at the next start as a cut (`verify.lost`).
   */
  protected withSlot(project: ProjectRuntime, ticketId: string, queue: QueueName, runId: string, check: (t: TicketState) => Promise<void>): void {
    const key = `verify:${runId}`;
    const run = (held: boolean) =>
      this.track(
        (async () => {
          try {
            const t = await this.ticket(project.id, ticketId);
            if (t.verifyingRunId === runId) await check(t);
          } finally {
            if (held) {
              this.d.scheduler.release(key);
              await this.drain(queue);
            }
          }
        })(),
      );
    if (this.stopping) return run(false);
    void this.d.scheduler.acquire(queue, key).then((slot) => run(slot !== null));
  }

  /** The verdict of a check, under its id `check:<runId>`: none when it threw, an infrastructure failure the agent is not sent. */
  protected async submitVerdict(project: ProjectRuntime, t: TicketState, runId: string, job: JobSpec, check: () => Promise<Verified & { tree?: string }>, output?: AgentOutput): Promise<void> {
    const base = { ...TRUSTED, at: this.d.clock.now(), projectId: project.id, ticketId: t.ticketId, id: `check:${runId}` };
    const payload = { runId, job: job.name };
    let res: Verified & { tree?: string };
    try {
      res = await check();
      if (res.ok && res.visual?.files.length) await this.keepCaptures(t, runId, res.visual.files);
    } catch (err) {
      await this.submitResult({ ...base, type: 'verify.errored', payload: { ...payload, error: (err as Error).message } });
      return;
    }
    await this.submitResult(
      res.ok
        ? { ...base, type: 'verify.passed', payload: { ...payload, ...(res.sha ? { sha: res.sha } : {}), ...(res.commands ? { commands: res.commands } : {}), ...(output ? { output } : {}), ...(res.visual ? { visualProof: res.visual.proof } : {}), ...(res.flaky ? { flaky: res.flaky } : {}), ...(res.diffClass ? { diffClass: res.diffClass } : {}) } }
        : { ...base, type: 'verify.failed', payload: { ...payload, failures: res.failures.map((f) => ({ ...f, output: logExcerpt(f.output) })), ...(res.tree ? { tree: res.tree } : {}), ...(res.flaky ? { flaky: res.flaky } : {}) } },
    );
  }

  /**
   * `factory/chemins-interdits` without sandboxes (ORC-338): `checkBranchPaths`, as on the clone, on the worktree's branch read
   * on the factory's repository against the default branch: the forge's, fetched, for a marked branch; without a mark, the
   * repository's as the launch last fetched it, so that a slow forge holds back no ticket that does not need it (ORC-358).
   * As on the clone, what gives no verdict throws, an infrastructure or config failure the agent is not sent: no worktree,
   * a read that fails, a config the default branch refuses.
   */
  private async checkPathsOnHost(project: ProjectRuntime, t: TicketState, run: RunRecord): Promise<{ failures: VerifyFailure[]; diffClass: ClassifiedDiff }> {
    const untrusted = await this.untrustedMark(project, t);
    const reader = await this.d.workspaces.branchReader(project.mirror, run.cwd, { fetch: !!untrusted });
    if (!reader) throw new Error(`the forbidden paths check could not run: no worktree with a commit at ${run.cwd}`);
    const config = parseRepoConfig(await reader.baseConfig());
    // The class of the diff (ORC-198), read as the clone's.
    const [failures, diffClass] = await Promise.all([checkBranchPaths(reader, untrusted && untrustedCheck(untrusted, config)), classOfBranch(reader, config)]);
    return { failures, diffClass };
  }

  /**
   * The ticket's mark (ORC-338), with the heads humans pushed to its branch; none on a trusted branch. A ticket the mark
   * has not seen yet (`untrustedSince` absent: it came before the mark existed) is read once in its run records, and the
   * answer kept on it: `''` (its whole branch) when an untrusted run of a worktree job worked on it, the scope of the mark, else `null`.
   */
  protected async untrustedMark(project: ProjectRuntime, t: TicketState): Promise<UntrustedMark | undefined> {
    const since = (await this.readUntrusted(project, t)).untrustedSince;
    return since === null || since === undefined ? undefined : { since, humanPushes: t.humanPushes ?? [] };
  }

  /** The one-time read of `untrustedMark`, for a ticket the mark has not seen; the ticket as it is otherwise. */
  protected async readUntrusted(project: ProjectRuntime, t: TicketState): Promise<TicketState> {
    if (t.untrustedSince !== undefined) return t;
    const runs = await this.d.store.ticketRuns(t.projectId, t.ticketId);
    // A job gone from the workflow counts: fail closed.
    const read = runs.some((r) => !!r.sensitivePaths?.length && (project.workflow.jobs[r.job]?.workspace ?? 'worktree') === 'worktree') ? '' : null;
    return this.apply(t, { type: 'untrusted.read', since: read });
  }

  /**
   * `factory/tests-gelés` on a worktree's head (ORC-131): the commits since the freeze, read on the factory's repository.
   * A check that cannot read them fails: the freeze never opens on a breakdown.
   */
  private async checkFrozen(project: ProjectRuntime, cwd: string, frozen: FrozenTests): Promise<VerifyFailure[]> {
    const fail = (output: string) => [{ command: FREEZE_CHECK, exitCode: 1, output }];
    try {
      const diff = await this.d.workspaces.stepDiff(project.mirror, cwd, frozen.sha);
      if (!diff) return fail(`The freeze check could not run: no worktree at ${cwd}.`);
      const r = await checkFrozen(frozen, diff);
      return r.ok ? [] : fail(r.summary);
    } catch (err) {
      return fail(`The freeze check could not run: ${(err as Error).message}`);
    }
  }

  /**
   * A `/refreeze` gets the freeze at its ticket's branch head before its decision (ORC-131), as roles are resolved:
   * `decide` stays pure and a replay regels the same files. The files frozen before, and the harness. No worktree, none; no
   * freeze, none either, it is the way out of a freeze, not a way in, but for a diff of the verification configuration held for
   * this very `/refreeze` (ORC-198): its harness is frozen as the maintainer approved it. The head alone: the frozen commit may
   * be gone after a rebase.
   */
  protected async withFreeze(event: FactoryEvent): Promise<FactoryEvent> {
    if (event.type !== 'command' || event.payload.name !== REFREEZE || event.payload.frozen || !event.ticketId) return event;
    const t = await this.d.store.getTicket(event.projectId, event.ticketId);
    if (!t?.worktreePath || (!t.frozenTests && !needsRefreeze(t.diffClass?.class, factoryDefault.approvers))) return event;
    const head = await this.d.workspaces.head(t.worktreePath);
    const diff = head ? await this.d.workspaces.stepDiff(this.project(event.projectId).mirror, t.worktreePath, head) : undefined;
    if (!diff) return event;
    return { ...event, payload: { ...event.payload, frozen: await freezeTests(Object.keys(t.frozenTests?.files ?? {}), diff) } };
  }
}
