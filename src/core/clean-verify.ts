import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WIDTHS, type VisualShooter } from '../adapters/browser/types.js';
import { execCmd, execFailure, mustExec, type Exec, type ExecResult } from '../adapters/exec.js';
import { DEFAULT_REQUIREMENTS, type SandboxMount, type SandboxProvider, type SandboxRequirements } from '../adapters/sandbox/types.js';
import { ANTI_CHEAT_CHECK, antiCheatCheck, justifiedRemovals } from '../checks/anti-cheat.js';
import { checkDependencies, DEPENDENCY_CHECK, manifestKind, type ManifestChange } from '../checks/deps.js';
import { parseDiff, type DiffFile } from '../checks/diff.js';
import { DIFF_SIZE_CHECK, diffSizeCheck } from '../checks/diff-size.js';
import { needsBase, rerunOnBase, runAndRerun, settle, type CommandRun, type FlakyTest, type KnownFlaky, type Run, type Standing } from '../checks/flaky.js';
import { checkFrozen, FREEZE_CHECK, isFrozenHarness, type FrozenTests } from '../checks/freeze.js';
import { checkForbiddenPaths, FORBIDDEN_CHECK, type ForbiddenView } from '../checks/forbidden-paths.js';
import { mdCode } from '../checks/markdown.js';
import { REPORT_FLAGS, runnerOfCommand, type Runner } from '../checks/red.js';
import type { PackageRegistry, RegistryOpener } from '../checks/registry.js';
import { addedLines, isRepoRuleFile, REPO_RULES_DIR, REPO_RULES_TARGET, semgrepArgv, semgrepCheck, semgrepFindings, type SemgrepRead } from '../checks/semgrep.js';
import { isTestSpec } from '../checks/test-files.js';
import { decideVisualProof, judgeShots, type CaptureGate, type Judged, type VisualProof } from '../checks/visual-proof.js';
import { parseRepoConfig, REPO_CONFIG_PATH, RepoConfigError, type RepoConfig } from '../config/repo-config.js';
import { BUNDLE_TARGET, extractWork, HARDENING, hostGitEnv, IN_SANDBOX, IN_SANDBOX_ENV } from '../publish/extract.js';
import { classifyBranch, type ClassifiedDiff } from './diff-class.js';
import { runSealedSetup } from './sealed-setup.js';
import type { VerifyFailure } from './types.js';
import { VERIFY_TIMEOUT_MS, type VerifyResult } from './verify.js';

/** Its coreutils' grace after the cap: a command that ignores the signal is killed. */
const KILL_AFTER_S = 10;
/** What a command's output may weigh on its way to the daemon: its tail, which `exec` holds in memory. */
const OUTPUT_TAIL_BYTES = 256 * 1024;
/** Past each command's own cap: only a sandbox that no longer answers is still there. */
const DEADLINE_GRACE_MS = 60_000;

export interface CleanVerifyRequest {
  sandboxes: SandboxProvider;
  /** The attempt's: its sandboxes are `<runId>-bundle`, `<runId>-prepare`, `<runId>-verify-setup` and `<runId>-verify`, so `recover()` finds them among the dead. */
  runId: string;
  ticketId: string;
  branch: string;
  /** The agent's worktree, its git dir inside (ORC-317): mounted in the sandbox that makes the bundle, and nowhere else. */
  worktree: string;
  /** On the host, empty, and the caller's to remove: where the engine can mount from. */
  workDir: string;
  /** Where the base branch is read: on the forge, not on the refs of a local repository. */
  originUrl: string;
  /** The workflow's, the factory's own (`jobs.<job>.verify`, `workspace.setup`): what `.factory/config.yml` does not declare, until ORC-177. */
  setup: readonly string[];
  commands: readonly string[];
  /** The commit `verify` last found green: found again, it is not checked again. */
  green?: string;
  /** `factory/secrets`, by the image's gitleaks. Only an isolation test on a public image without it turns it off. */
  gitleaks: boolean;
  /** `factory/semgrep` (ORC-333), by the image's Semgrep. Only an isolation test on a public image without it turns it off. */
  semgrep: boolean;
  /** `factory/dependances` (ORC-371): the daemon's way to the package registries, never a sandbox's. Absent, a branch that adds a package has no verdict. */
  registries?: RegistryOpener;
  /** `factory/tests-gelés` (ORC-131), once the ticket has a freeze. */
  frozen?: FrozenTests;
  /** The repository's known flaky tests (ORC-164), a human's list: failing, they are indicative and do not count. */
  knownFlaky?: readonly KnownFlaky[];
  /** The branch took untrusted content (ORC-338): what its agent commits changed since the mark in the repository's `sensitive_paths` is refused. */
  untrusted?: UntrustedMark;
  /** A human's push (ORC-159): this commit is checked as the forge's branch holds it, fetched from the forge; the worktree is not read. */
  head?: string;
  /** The last commit a human pushed to the branch (ORC-159): a commit that does not carry it is refused before anything runs, as its publication would be. */
  humanHead?: string;
  /** The variables the repository declares (ORC-211), never a secret. */
  env: (config: RepoConfig) => Promise<Record<string, string>>;
  /** The visual proof (ORC-176), for a job that writes the commit: absent, nothing of it is decided. */
  visual?: VisualRequest;
  log: (message: string) => void;
  deadlineMs?: number;
  exec?: Exec;
}

export interface VisualRequest {
  /** The ticket asked for it at `intake` (ORC-206). */
  intake: boolean;
  /** The browser; absent (no sandbox with one), a required proof is unavailable. */
  shooter?: VisualShooter;
  /** What starts the application (`workspace.preview`); absent, a required proof is unavailable. */
  start?: string;
  port: number;
  /** The page shot: `visual_scenario.url` of `submit_result`, `/` without one. */
  path: string;
  /** Each capture through the `OutputPolicy` before it is kept (ORC-214). */
  gate: CaptureGate;
}

/**
 * `commands`: what ran on the commit, none when nothing is declared; absent when it was found green before, and nothing ran again.
 * `flaky`: the failing tests the factory reran (ORC-164), with what each attempt found, those that do not count `indicative`.
 */
/** `diffClass`: the class of the diff against the default branch (ORC-198), absent on a commit found green again. */
export type CleanVerifyResult = VerifyResult & { sha: string; tree: string; commands?: readonly string[]; flaky?: FlakyTest[]; visual?: { proof: VisualProof; files: Judged['files'] }; diffClass?: ClassifiedDiff };

/** A verdict on the commit: rejecting means there is none, an infrastructure failure the agent is not sent. */
export type CleanVerifier = (req: CleanVerifyRequest) => Promise<CleanVerifyResult>;

/**
 * A verification command as it runs in its sandbox: under its cap, killed if it ignores the cap, with its output's
 * tail alone reaching the daemon, by `bash --norc -c`: no profile (ORC-324, see `runOne`). A process it left holding
 * the pipe is the deadline's: `exec` would not return.
 */
export function verifyCommand(command: string): string[] {
  const script = `timeout -k ${KILL_AFTER_S} ${VERIFY_TIMEOUT_MS / 1000} bash --norc -c "$1" 2>&1 | tail -c ${OUTPUT_TAIL_BYTES}; exit "\${PIPESTATUS[0]}"`;
  return ['bash', '--norc', '-c', script, 'verify', command];
}

/** `work`, or a rejection past `ms`: what it left running is `onExpiry`'s, and `recover()`'s. It never waits for an engine it gave up on. */
export function within<T>(work: Promise<T>, ms: number, message: string, onExpiry?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onExpiry?.();
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

type Boxes = Pick<SandboxProvider, 'create' | 'exec' | 'destroy'>;

/** `sandboxes`, whose `create` and `exec` give up on an engine silent past `ms`. An `exec` also destroys its sandbox: the only way a stuck one ends. */
export function withDeadline(sandboxes: Boxes, ms: number): Boxes {
  const silent = `the sandbox no longer responds after ${ms / 1000} s`;
  return {
    create: (req) => within(sandboxes.create(req), ms, silent),
    exec: (id, argv, opts) => within(sandboxes.exec(id, argv, opts), ms, silent, () => void sandboxes.destroy(id).catch(() => {})),
    destroy: (id) => within(sandboxes.destroy(id), ms, silent),
  };
}

/** A sandbox at network `none` for `work`, gone before the next one opens. */
export const boxOpener = (sandboxes: Boxes, of: { runId: string; ticketId: string; log: (message: string) => void }) => async <T>(suffix: string, workspacePath: string, mounts: readonly SandboxMount[], work: (id: string) => Promise<T>, requirements: SandboxRequirements = DEFAULT_REQUIREMENTS): Promise<T> => {
  const { id } = await sandboxes.create({ runId: `${of.runId}-${suffix}`, ticketId: of.ticketId, workspacePath, network: 'none', requirements, mounts });
  try {
    return await work(id);
  } finally {
    await sandboxes.destroy(id).catch((err: Error) => of.log(`sandbox ${id} not destroyed: ${err.message}`));
  }
};

/**
 * `verify` out of the agent's reach (ORC-151). The agent's code never runs where the engine's socket or the daemon's
 * env is, and the factory's tools never run on a tree it wrote:
 *
 * 1. in a sandbox of its own, without network, `git bundle` of the branch: its head is the frozen SHA;
 * 2. on the host, `git bundle verify` and a clone without checkout, without the repository's config;
 * 3. the base branch fetched into the clone from the forge, and `.factory/config.yml` read on it, never on the agent's
 *    branch nor on a ref of the repository it can write. Every read of the clone happens here, before any code of the
 *    agent has run in it, the checks of the commit included;
 *    `factory/dependances` (ORC-371) reads the manifests there too, and once step 4 refused nothing, the daemon asks the
 *    registries through the egress proxy, before the setup installs anything: no sandbox opens to the network for it;
 * 4. in a new sandbox at network `none`, gitleaks on the commits, then the checkout, and Semgrep on the files the diff adds
 *    lines to (ORC-333), with the factory's rules and the base's, read at step 3;
 * 5. the commands, in a new sandbox on that clone, at network `none`, with nothing else mounted; each failing test their
 *    runner's report names rerun once there, and a few on the base, set up in a sandbox of its own (ORC-164, `runAndRerun`, `rerunOnBase`);
 * 6. the visual proof (ORC-176), when it is required and the commands passed: the application started and shot by the
 *    factory's browser, after on the commit and before on the base, each in a sandbox of its own at network `none`. The
 *    base is checked out from the clone's objects at step 3, before any code of the agent has run in it.
 *
 * `setup`, which has to install, runs before them in its own sandbox at `limited`, without a secret: it is sealed like
 * the attempt's (`runSealedSetup`), on commits nobody reviewed, and never on a commit the checks already refused. It
 * rejects on any failure, the setup's included: an install that fails can be a registry down, and what cannot be told
 * from a breakdown is never sent to the agent.
 */
export const runCleanVerify: CleanVerifier = async (req) => {
  const deadlineMs = req.deadlineMs ?? VERIFY_TIMEOUT_MS + DEADLINE_GRACE_MS;
  const sandboxes = withDeadline(req.sandboxes, deadlineMs);
  const inBox = boxOpener(sandboxes, req);

  const bundleDir = join(req.workDir, 'bundle');
  const cloneDir = join(req.workDir, 'clone');
  const beforeDir = join(req.workDir, 'before');
  const beforeIndex = join(req.workDir, 'before.index');
  const rulesDir = join(req.workDir, 'semgrep');
  mkdirSync(bundleDir);
  try {
    const forgeSilent = `the forge no longer responds after ${deadlineMs / 1000} s`;
    const { sha } = req.head
      ? await within(fetchPushed(req, req.head, cloneDir), deadlineMs, forgeSilent)
      : await inBox('bundle', req.worktree, [{ host: bundleDir, target: BUNDLE_TARGET, readOnly: false }], (sandboxId) =>
          extractWork({ sandboxes, sandboxId, branch: req.branch, bundleDir, cloneDir, ...(req.exec ? { exec: req.exec } : {}) }),
        );

    const git = cloneGit(req, cloneDir);
    const tree = await git('rev-parse', `${sha}^{tree}`);
    // Before a commit found green is taken as it is: one from before the push does not carry it either.
    if (req.humanHead && !(await carries(git, req.humanHead, sha))) return { ok: false, failures: [humanCommitsMissing(req.humanHead, req.branch)], sha, tree };
    if (sha === req.green) return { ok: true, failures: [], sha, tree };
    // A human's push brought the base with it.
    if (!req.head) await within(fetchBase(req, cloneDir), deadlineMs, forgeSilent);
    const config = await baseConfig(git);
    const declared = Object.values(config.commands);
    const commands = declared.length ? declared : req.commands;
    const setup = config.setup ? [config.setup] : req.setup;
    const env = await req.env(config);
    const from = await forkPoint(git, sha);
    const failures = await checkClone(git, from, sha, req.frozen, req.untrusted && untrustedCheck(req.untrusted, config));
    // Only a verdict that passes carries it: a branch refused already is not read again.
    const diffClass = failures.length ? undefined : await classOfBranch(gitReader(git, BASE, from, sha), config);
    const diff = await readDiff(git, from, sha);
    failures.push(...checkSize(diff, config));
    const manifests = failures.length ? [] : await changedManifests(git, from, sha);
    // Refused already: not scanned, as nothing of it is installed or run. A breakdown of the scan would hide the verdict.
    const added = req.semgrep && diff && !failures.length ? await scanned(git, from, sha, diff) : new Map<string, Set<number>>();
    const rules = added.size ? await repoRules(git, rulesDir) : [];
    const { proof, shooting } = await planVisual(req.visual, { git, from, sha, config, refused: failures.length > 0 });
    // Read before any code of the agent has run: the runner of each command, and the base checked out for the reruns there.
    const runners = await testRunners(git, sha, commands);
    const onBase = from !== EMPTY_TREE && runners.size > 0 && !failures.length;
    if (shooting || onBase) await checkoutBase(req, cloneDir, { dir: beforeDir, index: beforeIndex }, from);
    let flaky: FlakyTest[] = [];
    // Every verdict goes out through here: the proof, decided, with it.
    const verdict = (files: Judged['files'] = []): CleanVerifyResult => ({
      ok: !failures.length, failures, sha, tree, commands, ...(diffClass ? { diffClass } : {}),
      ...(flaky.length ? { flaky } : {}),
      ...(proof ? { visual: { proof: files.length ? { ...proof, captures: files.map((f) => f.capture) } : proof, files } } : {}),
    });
    const setUp = async (suffix: string, workspacePath: string, services: readonly string[] = []) => {
      if (setup.length) await runSealedSetup(sandboxes, { runId: `${req.runId}-${suffix}`, ticketId: req.ticketId, workspacePath, mounts: [], commands: setup, argv: verifyCommand, env, secrets: {}, services, now: new Date() });
    };
    // Something runs on the commit: its commands, or the application for its captures.
    const runs = commands.length > 0 || !!shooting;
    // The checkout is needed: for what runs, or for Semgrep to read.
    const checkout = runs || added.size > 0;
    if (req.gitleaks || (checkout && !failures.length)) {
      const mounts = rules.length ? [{ host: rulesDir, target: REPO_RULES_TARGET, readOnly: true }] : [];
      await inBox('prepare', cloneDir, mounts, async (id) => {
        if (req.gitleaks) failures.push(...(await scanSecrets(sandboxes, id, from, sha)));
        // Refused already: nothing of it is installed or run. A forbidden `.npmrc` would be read by the install it forbids, and a breakdown of that install would hide the verdict.
        if (failures.length || !checkout) return;
        // `-c`: the clone's config is ours, and from the first command on it is no longer to be trusted.
        const out = await sandboxes.exec(id, ['git', ...IN_SANDBOX, 'checkout', '--quiet', '--detach', sha]);
        if (out.code !== 0) throw new Error(`git checkout (sandbox): ${out.stderr.trim()}`);
        if (added.size) failures.push(...(await scanCode(sandboxes, id, added, rules)));
      });
    }
    // Last of the checks that need no install, before the setup installs what the branch added. Refused already: no registry is asked, as a breakdown would hide the verdict.
    if (!failures.length && manifests.length) failures.push(...(await checkDeps(manifests, config, req)));
    if (failures.length || !runs) return verdict();

    // As the commit declares them, which the launch did not read: provided, or refused before any of its code runs (ORC-282).
    const unprovided = req.sandboxes.unprovided([...new Set(config.services)]);
    if (unprovided.length) throw new Error(servicesUnavailable(unprovided, true));
    // The repository's services (ORC-309), new for this check, never the agent's: filled by the setup, gone with the commands' sandbox.
    const withServices = { ...DEFAULT_REQUIREMENTS, services: config.services };
    await setUp('verify', cloneDir, config.services);
    const ran: CommandRun[] = [];
    const standing: Standing = { known: req.knownFlaky ?? [], ...(req.frozen ? { frozen: req.frozen } : {}) };
    await inBox('verify', cloneDir, [], async (id) => {
      for (const command of commands) {
        const failed = await runAndRerun(command, runners.get(command), reportRun(sandboxes, id, env), standing);
        if (failed) ran.push(failed);
      }
    }, withServices);
    // The base's tests get services as the commit's do, new ones.
    if (onBase && needsBase(ran, standing)) {
      await setUp('verify-base', beforeDir, config.services);
      await inBox('verify-base', beforeDir, [], (id) => rerunOnBase(ran, reportRun(sandboxes, id, env), standing), withServices);
    }
    const settled = settle(ran, standing);
    failures.push(...settled.failures);
    flaky = settled.flaky;
    if (!shooting || failures.length) return verdict();
    const judged = await shootBoth(sandboxes, inBox, shooting, { from, sha, env, cloneDir, beforeDir, setUp });
    failures.push(...judged.failures);
    if (judged.unavailable) proof!.unavailable = judged.unavailable;
    return verdict(judged.files);
  } finally {
    // Not synchronous: a clone holds a whole install, and the daemon serves meanwhile. Under a run dir, purged with it: what the attack left unremovable costs no verdict.
    await Promise.all(
      [bundleDir, cloneDir, beforeDir, beforeIndex, rulesDir].map((dir) => rm(dir, { recursive: true, force: true }).catch((err: Error) => req.log(`${dir} not removed: ${err.message}`))),
    );
  }
};

/** A launch or a check refused for the repository's `services` this factory does not provide (ORC-282): said on the ticket. */
export function servicesUnavailable(missing: readonly string[], sandboxed: boolean): string {
  const [which, it] = missing.length === 1 ? [`The service ${missing[0]} is`, 'it'] : [`The services ${missing.join(', ')} are`, 'them'];
  const why = sandboxed ? `no sandbox backend of this factory provides ${it}` : 'this factory runs without sandboxes (FACTORY_CONTAINER_CLI), which provide none';
  return `${which} not available: .factory/config.yml declares ${it} under \`services\`, and ${why}. Nothing runs without ${it}: take ${it} out of \`services\` or give the factory a backend that provides ${it}, then reply here.`;
}

export const BASE = 'refs/factory/base';

/** What a report may weigh on its way to the daemon: past it, it is cut, unreadable, and nothing is rerun. */
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** What its read may take: the agent's code, still running, could have put a pipe in its place, which a regular-file test refuses. */
const REPORT_READ_S = 60;

/**
 * Runs a line in sandbox `id` as a command of `verify` (`verifyCommand`), its exit 124 the cap's, whose failure stays the
 * agent's (a test that hangs), as on the host. With a runner, the line asks it for its report in a file of the sandbox, read
 * back by an exec of its own, capped: not through the command's output, whose tail alone reaches the daemon.
 */
function reportRun(sandboxes: Boxes, id: string, env: Record<string, string>): Run {
  return async (line, runner) => {
    const f = `"\${TMPDIR:-/tmp}"/factory-report-${randomUUID()}`;
    const started = Date.now();
    const { code, stdout, stderr } = await sandboxes.exec(id, verifyCommand(runner ? `f=${f}\n${line} ${REPORT_FLAGS[runner]}` : line), { env });
    const run = { exitCode: code === 124 ? null : code, output: stdout + stderr, ms: Date.now() - started };
    if (!runner) return run;
    const report = await sandboxes.exec(id, ['bash', '--norc', '-c', `[ -f ${f} ] && timeout ${REPORT_READ_S} head -c ${MAX_REPORT_BYTES} ${f}; rm -f ${f}`], { env });
    return report.stdout ? { ...run, report: report.stdout } : run;
  };
}

/** The runner of each command that names one, from the commit's `package.json` for an npm script: read before any of its code runs. */
async function testRunners(git: CloneGit, sha: string, commands: readonly string[]): Promise<Map<string, Runner>> {
  const runners = new Map<string, Runner>();
  for (const command of commands) {
    const runner = await runnerOfCommand(command, { showAtHead: (p) => show(git, sha, p) });
    if (runner) runners.set(command, runner);
  }
  return runners;
}

type Shooting = VisualRequest & Required<Pick<VisualRequest, 'shooter' | 'start'>>;

/**
 * The decision on the diff (ORC-176), and what takes a required proof, or why it cannot be taken: then indicative (ORC-152), no
 * fault of the branch. A commit the checks refused already is not shot.
 */
async function planVisual(
  v: VisualRequest | undefined,
  at: { git: CloneGit; from: string; sha: string; config: RepoConfig; refused: boolean },
): Promise<{ proof?: VisualProof; shooting?: Shooting }> {
  if (!v) return {};
  const changed = zFields(await at.git.raw('diff', '--name-only', '-z', '--no-renames', at.from, at.sha));
  const proof = decideVisualProof({ intake: v.intake, changed, visualPaths: at.config.visualPaths });
  if (proof.decision !== 'required' || at.refused) return { proof };
  if (!v.shooter) proof.unavailable = 'this instance has no sandbox with a browser';
  else if (!v.start) proof.unavailable = 'no command starts the application (`workspace.preview`)';
  else if (at.from === EMPTY_TREE) proof.unavailable = 'the branch shares no commit with the base, which has no page to compare';
  // The shots run the application without the repository's services (ORC-282): a page they show would not be the one it serves.
  else if (at.config.services.length) proof.unavailable = `the repository's services (${at.config.services.join(', ')}) are not provided to the captures`;
  else return { proof, shooting: { ...v, shooter: v.shooter, start: v.start } };
  return { proof };
}

/**
 * The base's files, from the clone's objects, by the host's git into a dir of their own: before any code of the agent has run
 * in the clone, whose objects it can rewrite once it has. A throwaway index: the clone's own is not touched.
 */
async function checkoutBase(req: CleanVerifyRequest, cloneDir: string, before: { dir: string; index: string }, from: string): Promise<void> {
  mkdirSync(before.dir);
  const env = { ...hostGitEnv(req.workDir, req.workDir), GIT_INDEX_FILE: before.index };
  await gitAt(req.exec ?? execCmd, cloneDir, env).raw(`--work-tree=${before.dir}`, 'checkout', from, '--', '.');
}

/**
 * The captures (ORC-176): after on the commit, in the clone the commands ran in; then, only if its page passes (`judgeShots`),
 * before on the base, set up as the commit was (`setUp`, sealed: the base is the default branch's). Each in a sandbox of its own at
 * network `none`, nothing mounted: the application and the browser together, nothing out. The browser's own failure rejects.
 */
async function shootBoth(
  sandboxes: Boxes,
  inBox: ReturnType<typeof boxOpener>,
  v: Shooting,
  at: { from: string; sha: string; env: Record<string, string>; cloneDir: string; beforeDir: string; setUp: (suffix: string, dir: string) => Promise<void> },
): Promise<Judged> {
  const shot = (side: 'before' | 'after', dir: string, sha: string) =>
    inBox(`visual-${side}`, dir, [], (sandboxId) => v.shooter.shoot(sandboxes, { sandboxId, sha, start: v.start, port: v.port, path: v.path, widths: WIDTHS, env: at.env }), v.shooter.requirements);
  const after = await shot('after', at.cloneDir, at.sha);
  const before = async () => {
    await at.setUp('visual', at.beforeDir);
    return shot('before', at.beforeDir, at.from);
  };
  return judgeShots(after, before, { before: at.from, after: at.sha }, v.gate);
}

/** `.factory/config.yml` as the base branch holds it, in the clone: never as the agent's branch does. */
export async function baseConfig(git: CloneGit): Promise<RepoConfig> {
  return parseRepoConfig(await show(git, BASE, REPO_CONFIG_PATH));
}

/**
 * The forge's default branch, in the clone. The daemon's own config is read, for its credentials: the repository's is
 * not, as nothing here runs in it, and the clone's is ours. Read on the forge, not on `origin/HEAD` of the repository:
 * what `.factory/config.yml` says of a commit is read as close to its source as the factory can.
 */
async function fetchBase(req: CleanVerifyRequest, cloneDir: string, pushed = false): Promise<void> {
  // A human's push (ORC-159) comes in the same fetch, its objects checked: what it holds was written outside the factory.
  const fsck = pushed ? ['-c', 'transfer.fsckObjects=true'] : [];
  const args = [...HARDENING.flatMap((c) => ['-c', c]), ...fsck, '-C', cloneDir, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', req.originUrl, `+HEAD:${BASE}`, ...(pushed ? [`+refs/heads/${req.branch}:${PUSHED}`] : [])];
  try {
    await mustExec(req.exec ?? execCmd, 'git', args, { env: { GIT_TERMINAL_PROMPT: '0' } });
  } catch (err) {
    // eslint-disable-next-line preserve-caught-error -- its message holds the URL and its credentials: it stays out of what is journaled.
    throw new Error(`${pushed ? 'the base or the pushed branch' : 'base branch'} not read: ${withoutCredentials((err as Error).message, req.originUrl)}`);
  }
}

const PUSHED = 'refs/factory/pushed';

/**
 * A human's push (ORC-159), from the forge into a new repository of ours, with the base in the same fetch (`fetchBase`,
 * the daemon's credentials): its objects checked, and no remote recorded, so the forge's URL and credentials stay out of
 * the clone the commands later run in. The pushed commit must still be on that branch; a newer push on top of it is the next check's.
 */
async function fetchPushed(req: CleanVerifyRequest, head: string, cloneDir: string): Promise<{ sha: string }> {
  mkdirSync(cloneDir);
  const git = cloneGit(req, cloneDir);
  await git('init', '--quiet', '--template=');
  // For whoever runs git in it next, as `extractWork` keeps them in its clone.
  for (const c of HARDENING) await git('config', c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1));
  await fetchBase(req, cloneDir, true);
  // A commit the clone does not even hold is not on the branch either.
  if ((await git.status('merge-base', '--is-ancestor', head, PUSHED)).code !== 0) {
    throw new Error(`the pushed commit ${head.slice(0, 12)} is no longer on the forge's branch ${req.branch}`);
  }
  return { sha: await git('rev-parse', '--verify', `${head}^{commit}`) };
}

/** `factory/commits-humains` (ORC-159): the branch carries every commit a human pushed to it, or the factory publishes nothing over them. */
export const HUMAN_COMMITS_CHECK = 'factory/commits-humains';

/** Whether `sha` carries `human`: a commit the clone does not even hold does not. */
async function carries(git: CloneGit, human: string, sha: string): Promise<boolean> {
  return (await git.status('merge-base', '--is-ancestor', human, sha)).code === 0;
}

const humanCommitsMissing = (human: string, branch: string): VerifyFailure => ({
  command: HUMAN_COMMITS_CHECK,
  exitCode: 1,
  output: `The branch does not carry the commits a human pushed to it (up to ${human.slice(0, 12)}), and the factory never publishes over them. \`git fetch origin\`, then \`git rebase origin/${branch}\`: your commits not yet published go on top of theirs. Resolve, commit, and never push.`,
});

/** The message goes to the journal and to the ticket: neither the URL, which can carry a token, nor what git quotes of one. */
function withoutCredentials(message: string, url: string): string {
  return message.replaceAll(url, 'origin').replace(/\/\/[^/\s@]+@/g, '//***@');
}

/** Git's empty tree: what a branch that shares no commit with the base is compared with, every file of it then a change. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SYMLINK = '120000';
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** What the numstat and the patch of a diff may weigh together in the daemon's memory. */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const SECRETS_CHECK = 'factory/secrets';
const BINARY_CHECK = 'factory/binaires';
const LEAKS_FOUND = 7;

/**
 * gitleaks on `target` in mode `mode` (`git` and its log options, `dir`), with the factory's flags: the report redacted, as JSON on stdout,
 * and the `gitleaks:allow` of what it scans ignored. The one way the factory runs it: the branch's commits here, a text it publishes (ORC-214).
 */
export const gitleaksArgv = (mode: readonly string[], target: string): string[] => [
  'gitleaks', ...mode, '--no-banner', '--redact', '--ignore-gitleaks-allow', '--exit-code', String(LEAKS_FOUND), '--report-format', 'json', '--report-path', '-', '--log-level', 'error', target,
];

/** The same in a sandbox, under `verify`'s cap: the image's coreutils end it. */
export const sandboxGitleaksArgv = (mode: readonly string[], target: string): string[] => ['timeout', String(VERIFY_TIMEOUT_MS / 1000), ...gitleaksArgv(mode, target)];

/** What a gitleaks run found. Anything but a clean exit, or its leaks' code, with a readable report is a breakdown, never a green: it rejects. */
export function gitleaksFindings({ code, stdout, stderr }: ExecResult): { leaked: boolean; found: { File: string; StartLine: number; RuleID: string }[] } {
  if ((code !== 0 && code !== LEAKS_FOUND) || stderr.trim()) throw new Error(`gitleaks could not run (code ${code}): ${stderr.trim()}`);
  let found: { File: string; StartLine: number; RuleID: string }[];
  try {
    found = JSON.parse(stdout) as typeof found;
    if (!Array.isArray(found)) throw new Error('not a list');
  } catch {
    throw new Error(`gitleaks returned no readable report (code ${code})`);
  }
  return { leaked: code === LEAKS_FOUND || found.length > 0, found };
}

/**
 * The commits the branch adds, by gitleaks in a sandbox of its own, before any code of the agent has run: the clone has no
 * checkout, so neither a `.gitleaks.toml` nor a `.gitleaksignore` of the branch is read, and the `gitleaks:allow` it could
 * write is ignored. The report is redacted. Measured on 8.30.1: a failing `git log` leaves an empty report, exit 0, and
 * only an error on stderr. So anything but a clean exit with a readable report is a breakdown, never a green.
 */
export async function scanSecrets(sandboxes: Boxes, id: string, from: string, sha: string): Promise<VerifyFailure[]> {
  // Plain `git log -p` shows no patch for a merge, where a secret can be added: what it changed beyond the clean merge, and only that.
  const logOpts = `--diff-merges=remerge ${from === EMPTY_TREE ? sha : `${from}..${sha}`}`;
  const env = { GIT_AUTHOR_NAME: 'factory', GIT_AUTHOR_EMAIL: 'factory@localhost', GIT_COMMITTER_NAME: 'factory', GIT_COMMITTER_EMAIL: 'factory@localhost', ...IN_SANDBOX_ENV };
  const { leaked, found } = gitleaksFindings(await sandboxes.exec(id, sandboxGitleaksArgv(['git', `--log-opts=${logOpts}`], '.'), { env }));
  if (!leaked) return [];
  const lines = found.map((f) => `- ${f.File}:${f.StartLine} (${f.RuleID})`);
  return [{ command: SECRETS_CHECK, exitCode: 1, output: `Hard-coded secret in the branch's commits, publication blocked. Remove it from its history, and consider it exposed:\n${lines.join('\n')}` }];
}

/** The diff since the base at `-U0`, renames found (a pure one counts as a file without lines): undefined past `MAX_PATCH_BYTES`. */
async function readDiff(git: CloneGit, from: string, sha: string): Promise<DiffFile[] | undefined> {
  const read = await git.capped(MAX_PATCH_BYTES, '-c', `core.bigFileThreshold=${MAX_READ_BYTES}`, 'diff', '-U0', '-M', '--no-ext-diff', '--no-textconv', from, sha);
  return read === undefined ? undefined : parseDiff(read);
}

/** `factory/taille-du-diff` (ORC-145, ORC-333) against the base's `max_diff`. A diff too large to read is `factory/anti-triche`'s already, read with more context. */
function checkSize(diff: DiffFile[] | undefined, config: RepoConfig): VerifyFailure[] {
  if (!diff) return [];
  const r = diffSizeCheck(diff, { maxDiff: config.maxDiff });
  return r.ok ? [] : [{ command: DIFF_SIZE_CHECK, exitCode: 1, output: r.summary }];
}

/** The manifests `factory/dependances` reads (ORC-371), as the fork point and the commit hold them, from the clone's objects. */
async function changedManifests(git: CloneGit, from: string, sha: string): Promise<ManifestChange[]> {
  const paths = zFields(await git.raw('diff', '--name-only', '-z', '--no-renames', from, sha)).filter((p) => manifestKind(p));
  return Promise.all(paths.map(async (path) => ({ path, before: (await show(git, from, path)) ?? null, after: (await show(git, sha, path)) ?? null })));
}

/**
 * `factory/dependances` (ORC-165, ORC-371) on the changed manifests, against the base's allowlist. The registries are opened
 * for a package to look up, and only then, under a name of this check's own. A lookup without an answer is no fault of the
 * branch: it blocks nothing, and rejects when nothing else of the check does.
 */
async function checkDeps(changes: ManifestChange[], config: RepoConfig, req: Pick<CleanVerifyRequest, 'registries' | 'runId' | 'log'>): Promise<VerifyFailure[]> {
  const open = req.registries ?? (() => Promise.reject(new Error('no package registry on this instance')));
  let opened: ReturnType<RegistryOpener> | undefined;
  const id = `${req.runId}-dependencies-${randomUUID().slice(0, 8)}`;
  const registry: PackageRegistry = { lookup: async (ecosystem, name) => (await (opened ??= open(id))).registry.lookup(ecosystem, name) };
  try {
    const { findings } = await checkDependencies({ changes, registry, allowList: config.dependencies.allow });
    const blocking = findings.filter((f) => f.reason !== 'registry_unknown');
    if (blocking.length) return [{ command: DEPENDENCY_CHECK, exitCode: 1, output: `Dependency the factory does not accept, publication blocked. Remove it, or have a human add it to \`dependencies.allow\` of \`${REPO_CONFIG_PATH}\` on the default branch:\n${blocking.map((f) => `- ${f.message}`).join('\n')}` }];
    if (findings.length) throw new Error(findings.map((f) => f.message).join('\n'));
    return [];
  } finally {
    // Opened only: one that never opened has nothing to close.
    await opened?.then((o) => o.close().catch((err: Error) => req.log(`package registries not closed: ${err.message}`)), () => {});
  }
}

const isRegular = (mode: string) => mode === '100644' || mode === '100755';

/**
 * The repository's Semgrep rules as its default branch holds them, never as the branch does, written under `dir` before any
 * code of the agent has run in the clone: their paths under `REPO_RULES_DIR`. A link is not followed.
 */
async function repoRules(git: CloneGit, dir: string): Promise<string[]> {
  const rules: string[] = [];
  for (const entry of zFields(await git.raw('ls-tree', '-r', '-z', BASE, '--', REPO_RULES_DIR))) {
    // `<mode> <type> <id>\t<path>`
    const tab = entry.indexOf('\t');
    const path = entry.slice(tab + 1);
    if (!isRegular(entry.slice(0, entry.indexOf(' '))) || !isRepoRuleFile(path)) continue;
    const content = (await show(git, BASE, path))!;
    if (content.startsWith('\0too large')) throw new Error(`${path}: Semgrep rules over ${MAX_READ_BYTES / 2 ** 20} MB`);
    const rel = path.slice(REPO_RULES_DIR.length);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
    rules.push(rel);
  }
  return rules;
}

/** What Semgrep scans: the regular files the diff adds lines to, with those lines. A link's target is not code of the branch, nor is a submodule. */
async function scanned(git: CloneGit, from: string, sha: string, diff: readonly DiffFile[]): Promise<Map<string, Set<number>>> {
  const added = addedLines(diff);
  for (const { path, mode } of parseRawDiff(await git.raw('diff', '--raw', '--no-renames', '-z', from, sha))) {
    if (!isRegular(mode)) added.delete(path);
  }
  return added;
}

/** Paths per run of Semgrep: test files do not count in `max_diff`, and a command line has a cap. */
const SCAN_BATCH = 500;

/** `factory/semgrep` (ORC-333) on the checkout in sandbox `id`: the factory's rules and the repository's (`rules`), on the lines the diff adds. */
async function scanCode(sandboxes: Boxes, id: string, added: ReadonlyMap<string, ReadonlySet<number>>, rules: readonly string[]): Promise<VerifyFailure[]> {
  const targets = [...added.keys()];
  const read: SemgrepRead = { found: [], unread: [] };
  for (let i = 0; i < targets.length; i += SCAN_BATCH) {
    const argv = semgrepArgv(rules, targets.slice(i, i + SCAN_BATCH), { maxBytes: MAX_READ_BYTES, timeoutS: VERIFY_TIMEOUT_MS / 1000 });
    const { found, unread } = semgrepFindings(await sandboxes.exec(id, argv), added);
    read.found.push(...found);
    read.unread.push(...unread);
  }
  const r = semgrepCheck(read);
  return r.ok ? [] : [{ command: r.check, exitCode: 1, output: r.summary }];
}

/** `merge-base`'s own answers, 0 and 1, and no other code: a failure of git is no verdict on the branch, and rejects. */
export function isYes(r: ExecResult): boolean {
  if (r.code > 1) throw new Error(`git merge-base: ${r.stderr.trim() || `code ${r.code}`}`);
  return r.code === 0;
}

/** Where the commit left the default branch (`base`, the clone's by default), the empty tree for one that never shares a commit with it: all its files are then changes. */
export async function forkPoint(git: CloneGit, sha: string, base = BASE): Promise<string> {
  const common = await git.status('merge-base', base, sha);
  return isYes(common) ? common.stdout.trim() : EMPTY_TREE;
}

/**
 * What the path rules read of a branch (ORC-338): on the clone (`checkClone`), or without sandboxes on the factory's
 * repository (`WorkspaceManager.branchReader`). Both are `gitReader`: one reading, one verdict.
 */
export interface BranchReader {
  /** What the head changed since it left the default branch; `link`, the target of one that is a symbolic link at the head. */
  changed(): Promise<ForbiddenView['changed']>;
  /**
   * The paths the agent's commits touched since `since`: the head's commits from the mark, or from the fork point when the
   * mark is `''` or not one of the head's ancestors (a rewritten history), but for those the default branch reaches and
   * those a human pushed (`before..after` of each push the branch took in; a push whose range cannot be read leaves out
   * nothing). A merge counts by what it changed beyond the clean merge.
   */
  agentChanges(since: string, humanPushes: readonly HumanPush[]): Promise<readonly string[]>;
  showAtFork(path: string): Promise<string | undefined>;
  showAtHead(path: string): Promise<string | undefined>;
  /** `.factory/config.yml` as the default branch holds it, never as the branch does. */
  baseConfig(): Promise<string | undefined>;
}

/** The fields of a `-z` listing, as git wrote them: a path can start or end with a space, so nothing is trimmed. */
export const zFields = (out: string): string[] => out.split('\0').filter(Boolean);

/** `git diff --raw -z`: `:<old mode> <new mode> <old id> <new id> <status>`, then the path, for each file. */
export function parseRawDiff(out: string): { path: string; deleted: boolean; mode: string }[] {
  const fields = zFields(out);
  const files = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , , status] = fields[i]!.split(' ');
    files.push({ path: fields[i + 1]!, deleted: status === 'D', mode: mode! });
  }
  return files;
}

/**
 * `git log --format=%x00%H --name-only -z`: each commit as `\0<sha>\0`, then its paths, the first after a `\n`, each ending in
 * `\0`. A path is never empty, so an empty field always comes before a commit: no path, whatever its name, reads as one.
 */
export function logPaths(out: string): { commit: string; paths: string[] }[] {
  const commits: { commit: string; paths: string[] }[] = [];
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] === '') {
      if (i + 1 < fields.length && fields[i + 1] !== '') commits.push({ commit: fields[++i]!, paths: [] });
      continue;
    }
    const current = commits.at(-1);
    if (!current) continue;
    current.paths.push(current.paths.length === 0 ? fields[i]!.replace(/^\n/, '') : fields[i]!);
  }
  return commits;
}

/** A branch read by git: `base`, the default branch's ref; `from`, where `sha` left it. */
export function gitReader(git: CloneGit, base: string, from: string, sha: string): BranchReader {
  const ancestor = async (rev: string) => (await git.status('merge-base', '--is-ancestor', rev, sha)).code === 0;
  return {
    changed: async () => {
      const changed = [];
      for (const { path, deleted, mode } of parseRawDiff(await git.raw('diff', '--raw', '--no-renames', '-z', from, sha))) {
        changed.push({ path, deleted, ...(mode === SYMLINK ? { link: (await show(git, sha, path))! } : {}) });
      }
      return changed;
    },
    agentChanges: async (since, humanPushes) => {
      const start = since && (await ancestor(since)) ? since : from;
      // The commits a human pushed: only theirs, not the agent's they were built on, which `--not <after>` would also leave out.
      const human = new Set<string>();
      for (const { before, after } of humanPushes) {
        if (!before || !(await ancestor(after))) continue;
        const r = await git.status('rev-list', ...(/^0+$/.test(before) ? [after, '--not', base] : [`${before}..${after}`]));
        if (r.code === 0) for (const c of r.stdout.split('\n').filter(Boolean)) human.add(c);
      }
      const range = start === EMPTY_TREE ? sha : `${start}..${sha}`;
      const out = await git.raw('log', '--format=%x00%H', '--name-only', '-z', '--no-renames', '--diff-merges=remerge', range, '--not', base);
      return logPaths(out).filter(({ commit }) => !human.has(commit)).flatMap(({ paths }) => paths);
    },
    showAtFork: (p) => show(git, from, p),
    showAtHead: (p) => show(git, sha, p),
    baseConfig: () => show(git, base, REPO_CONFIG_PATH),
  };
}

/** A push a human made to the ticket's branch (`push.human`): `before` absent on an event recorded without it. */
export interface HumanPush {
  before?: string;
  after: string;
}

/** A branch that took untrusted content (ORC-338): its mark (`TicketState.untrustedSince`) and the pushes humans made to it. */
export interface UntrustedMark {
  since: string;
  humanPushes: readonly HumanPush[];
}

/** What the check of an untrusted branch needs: its mark, and the default branch's `sensitive_paths` as its caller parsed them. */
export type UntrustedCheck = UntrustedMark & Pick<RepoConfig, 'sensitivePaths' | 'sensitivePathWarnings'>;

export const untrustedCheck = (mark: UntrustedMark, config: RepoConfig): UntrustedCheck => ({
  ...mark,
  sensitivePaths: config.sensitivePaths,
  ...(config.sensitivePathWarnings ? { sensitivePathWarnings: config.sensitivePathWarnings } : {}),
});

/** The class of a branch's diff (ORC-198), read as the path rules read it, under the default branch's `sensitive_paths`. */
export async function classOfBranch(reader: BranchReader, config: RepoConfig): Promise<ClassifiedDiff> {
  return classifyBranch((await reader.changed()).map((c) => c.path), config.sensitivePaths, reader);
}

/**
 * `factory/chemins-interdits` on a branch, whoever reads it: the forbidden paths, outward links and `package.json#scripts`
 * on all it changed since the fork point; and on a branch that took untrusted content (`untrusted`, ORC-338), the default
 * branch's `sensitive_paths` among what the agent's commits touched since the mark (`agentChanges`). Only paths changed
 * since the fork point count. An entry of `sensitive_paths` that names nothing (`sensitivePathWarnings`) leaves the
 * untrusted branch unchecked on it, so the branch is refused with a `RepoConfigError`, a config failure the agent is not sent.
 */
export async function checkBranchPaths(reader: BranchReader, untrusted?: UntrustedCheck): Promise<VerifyFailure[]> {
  if (untrusted?.sensitivePathWarnings?.length) throw new RepoConfigError(untrusted.sensitivePathWarnings.map((w) => `${w}; a branch that took untrusted content is refused until it is fixed`));
  const changed = await reader.changed();
  let sensitive: ForbiddenView['sensitive'];
  if (untrusted?.sensitivePaths.length) sensitive = { patterns: untrusted.sensitivePaths, changed: new Set(await reader.agentChanges(untrusted.since, untrusted.humanPushes)) };
  const r = await checkForbiddenPaths({ changed, showAtBase: (p) => reader.showAtFork(p), showAtHead: (p) => reader.showAtHead(p), ...(sensitive ? { sensitive } : {}) });
  return r.ok ? [] : [{ command: FORBIDDEN_CHECK, exitCode: 1, output: r.summary }];
}

/**
 * The blocking checks on the commit, from the clone's objects: `factory/chemins-interdits` (`checkBranchPaths`), `factory/binaires` and `factory/anti-triche`
 * (ORC-158) on all it changed since it left the base, whatever it says of its own history, and `factory/tests-gelés` on the frozen files as they are at
 * its head, which needs no frozen commit: a rebase can take it away, not its fingerprints. A read that fails rejects.
 */
export async function checkClone(git: CloneGit, from: string, sha: string, frozen: FrozenTests | undefined, untrusted?: UntrustedCheck): Promise<VerifyFailure[]> {
  const showAtHead = (p: string) => show(git, sha, p);
  const failures = await checkBranchPaths(gitReader(git, BASE, from, sha), untrusted);
  failures.push(...(await checkAdded(git, from, sha)));
  if (frozen) {
    const atHead = zFields(await git.raw('ls-tree', '-r', '--name-only', '-z', sha));
    const listed = new Set(atHead);
    const paths = [...new Set([...Object.keys(frozen.files), ...atHead.filter(isFrozenHarness)])];
    const r = await checkFrozen(frozen, { head: sha, changed: paths.map((path) => ({ path, deleted: !listed.has(path) })), filesAtHead: async () => atHead, showAtHead });
    if (!r.ok) failures.push({ command: FREEZE_CHECK, exitCode: 1, output: r.summary });
  }
  return failures;
}

/**
 * `factory/binaires` and `factory/anti-triche` (ORC-158) on what the diff adds, in one read: `--numstat` (`-z`, as a path can hold anything:
 * `<added>\t<removed>\t<path>`, both counts `-` for a binary), an empty record, then the patch. Binary on git's own reading, in a clone
 * without a worktree, so no `.gitattributes` of the branch says otherwise. A blob over the cap reads as binary in both parts, so it blocks:
 * its text never comes into the daemon's memory, nor does a whole read over `MAX_PATCH_BYTES`, which blocks too.
 */
async function checkAdded(git: CloneGit, from: string, sha: string): Promise<VerifyFailure[]> {
  // Full context (ORC-342), as many lines as the read cap lets a file weigh: each file changed is whole in its diff,
  // before and after, for its syntax tree and its tests.
  const read = await git.capped(MAX_PATCH_BYTES, '-c', `core.bigFileThreshold=${MAX_READ_BYTES}`, 'diff', '--numstat', '--patch', '-z', `-U${MAX_READ_BYTES}`, '--no-renames', '--no-ext-diff', '--no-textconv', '--diff-filter=d', from, sha);
  if (read === undefined) return [{ command: ANTI_CHEAT_CHECK, exitCode: 1, output: `Diff too large to analyze (over ${MAX_PATCH_BYTES / 2 ** 20} MB), publication blocked. Split the work.` }];
  const end = read.indexOf('\0\0');
  const binaries = (end === -1 ? [] : read.slice(0, end).split('\0')).filter((l) => l.startsWith('-\t-\t')).map((l) => l.slice(4));
  const failures: VerifyFailure[] = [];
  if (binaries.length) failures.push({ command: BINARY_CHECK, exitCode: 1, output: `Binary file, or one too large to analyze (over ${MAX_READ_BYTES / 2 ** 20} MB), in the diff, publication blocked. Remove it from the branch:\n${binaries.map((p) => `- ${mdCode(p)}`).join('\n')}` });
  // The test files the branch deleted (a rename is one, `--no-renames`), as they were, and the trailers that justify a removal.
  const deleted = zFields(await git.raw('diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', from, sha)).filter(isTestSpec);
  const deletedTests = Object.fromEntries(await Promise.all(deleted.map(async (p) => [p, (await show(git, from, p)) ?? ''] as const)));
  const justified = justifiedRemovals(await git.raw('log', '--format=%B', from === EMPTY_TREE ? sha : `${from}..${sha}`));
  const cheat = antiCheatCheck(end === -1 ? '' : read.slice(end + 2), { deletedTests, justified });
  if (!cheat.ok) failures.push({ command: ANTI_CHEAT_CHECK, exitCode: 1, output: `Workaround or disabled test in the diff, publication blocked. Remove it from the branch:\n${cheat.summary}` });
  return failures;
}

/**
 * A file of a commit; undefined when it has none. A blob the agent made huge never comes into the daemon's memory: as
 * itself, by its id, it reads as changed.
 */
async function show(git: CloneGit, rev: string, path: string): Promise<string | undefined> {
  const entry = /^\d+ (\w+) (\w+)\s+(\d+)?/.exec(await git.raw('ls-tree', '-l', '-z', rev, '--', path));
  if (entry?.[1] !== 'blob') return undefined;
  return Number(entry[3]) > MAX_READ_BYTES ? `\0too large: ${entry[2]}` : git.raw('show', `${rev}:${path}`);
}

/** Its output trimmed; `raw` as git wrote it, for what is compared by its bytes: a file's content, a link's target. */
export type CloneGit = ((...args: string[]) => Promise<string>) & {
  raw: (...args: string[]) => Promise<string>;
  status: (...args: string[]) => Promise<ExecResult>;
  /** As `raw`, undefined past `max` bytes of output: the process killed, nothing of it kept. */
  capped: (max: number, ...args: string[]) => Promise<string | undefined>;
};

export function cloneGit(req: Pick<CleanVerifyRequest, 'workDir' | 'exec'>, cloneDir: string): CloneGit {
  return gitAt(req.exec ?? execCmd, cloneDir, hostGitEnv(req.workDir, req.workDir));
}

/** Git in `dir`, hardened (no hook, no fsmonitor), under `env`. */
export function gitAt(exec: Exec, dir: string, env: Record<string, string>): CloneGit {
  const argv = (args: string[]) => [...HARDENING.flatMap((c) => ['-c', c]), '-C', dir, ...args];
  const raw = (...args: string[]) => mustExec(exec, 'git', argv(args), { env });
  const status = (...args: string[]) => exec('git', argv(args), { env });
  const capped = async (max: number, ...args: string[]) => {
    const r = await exec('git', argv(args), { env, maxStdout: max });
    if (r.overflow) return undefined;
    if (r.code !== 0) throw execFailure('git', args, r);
    return r.stdout;
  };
  return Object.assign(async (...args: string[]) => (await raw(...args)).trim(), { raw, status, capped });
}
