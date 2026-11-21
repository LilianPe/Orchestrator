import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from '../adapters/exec.js';
import { DEFAULT_REQUIREMENTS, type SandboxProvider } from '../adapters/sandbox/types.js';
import { SHA } from '../adapters/workspace/git-workspaces.js';
import { runAndRerun, settle, type CommandRun, type KnownFlaky, type Standing } from '../checks/flaky.js';
import { isLockfile } from '../checks/diff-size.js';
import { ANSI, logExcerpt } from '../checks/log-excerpt.js';
import { parseRepoConfig, REPO_CONFIG_PATH, RepoConfigError, setupOf, type RepoConfig } from '../config/repo-config.js';
import { IN_SANDBOX } from '../publish/extract.js';
import { BASE, boxOpener, cloneGit, fetchFromForge, initHardenedClone, reportRun, show, testCommands, verifyCommand, withDeadline, within, zFields, type CloneGit } from './clean-verify.js';
import { MAIN_UNCHECKED } from './maturity.js';
import { utc } from './prompt.js';
import { RELEASE_AGE_DAYS, runSealedSetup, SetupFailure } from './sealed-setup.js';
import { VERIFY_TIMEOUT_MS } from './verify.js';

/** What breaks a dry run, as its report classifies it (ORC-408). */
export type DryRunBreakKind = 'dependency' | 'service' | 'variable' | 'flaky' | 'failure';

export interface DryRunBreak {
  kind: DryRunBreakKind;
  /** Where: the commit's `.factory/config.yml`, its `setup`, or one of its commands. */
  step: 'config' | 'setup' | 'command';
  command: string;
  /** The line that names the cause, or what the factory says of it. */
  detail: string;
  /** An excerpt of what the command printed. */
  output: string;
}

/**
 * What the dry run ran with: a delegated ticket runs it again when this changes (ORC-409). `setup`, a hash of its commands;
 * `image`, the runner image as configured; `lockfiles`, the blob of each lockfile at the commit's root; `config`, the blob of
 * `.factory/config.yml` (its `env`, `services` and `commands`), null without one, absent from a dry run recorded before ORC-409;
 * `hash`, of them all.
 */
export interface DryRunFingerprint {
  setup: string;
  image: string;
  lockfiles: Record<string, string>;
  config?: string | null;
  hash: string;
}

/** The files of the fingerprint on a commit (ORC-409): each lockfile at its root and `.factory/config.yml`, by their blobs. */
export interface FingerprintFiles {
  lockfiles: Record<string, string>;
  config: string | null;
}

/** A dry run of a repository (ORC-408): `setup`, then its commands, on a commit of its default branch, in the sandbox. */
export interface DryRun {
  id: string;
  projectId: string;
  sha: string;
  /** `main`: the forge's default branch as it stood; `commit`: a commit given (the replay of closed tickets, ORC-231). */
  target: 'main' | 'commit';
  ok: boolean;
  fingerprint: DryRunFingerprint;
  breaks: DryRunBreak[];
  /** What ran after the setup. */
  commands: string[];
  startedAt: number;
  endedAt: number;
}

export interface DryRunRequest {
  sandboxes: SandboxProvider;
  /** The dry run's id: its sandboxes are `<runId>-prepare`, `<runId>-run-setup` and `<runId>-run`, so `recover()` finds them among the dead. */
  runId: string;
  projectId: string;
  /** Where the commit is read: on the forge, with the daemon's credentials. */
  originUrl: string;
  /** As `CleanVerifyRequest.forgeEnv`: the App's token for a private forge (ORC-442). */
  forgeEnv?: () => Promise<Record<string, string>>;
  /** A commit given; absent, the forge's default branch. */
  sha?: string;
  /** On the host, empty, and the caller's to remove: the clone the sandboxes mount is in its `clone/`, the host git's config beside it. */
  workDir: string;
  /** The workflow's (`workspace.setup`, `jobs.dev.verify`): what the commit's `.factory/config.yml` does not declare. */
  setup: readonly string[];
  commands: readonly string[];
  /** The runner image the sandboxes run, as configured (`FACTORY_RUNNER_IMAGE`). */
  image: string;
  /** The variables the repository declares (ORC-211), never a secret. */
  env: (config: RepoConfig) => Promise<Record<string, string>>;
  knownFlaky?: readonly KnownFlaky[];
  now: () => number;
  log: (message: string) => void;
  /** Each sandbox's, and each fetch from the forge's. */
  deadlineMs?: number;
  exec?: Exec;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function dryRunFingerprint(i: { setup: readonly string[]; image: string } & FingerprintFiles): DryRunFingerprint {
  const lockfiles = Object.fromEntries(Object.entries(i.lockfiles).sort(([a], [b]) => a.localeCompare(b)));
  const setup = sha256(JSON.stringify(i.setup));
  const inputs = { setup, image: i.image, lockfiles, config: i.config };
  return { ...inputs, hash: sha256(JSON.stringify(inputs)) };
}

/**
 * The files of the fingerprint on `ref`, by their blobs: git's own hash of their content. Each lockfile at the root (the shared
 * rule of `isLockfile`, as `max_diff` knows them), `.factory/config.yml` by its path: `ls-tree` does not go through a `.factory`
 * that is a link, which the config then is not. `lsTree`: `git ls-tree` with these arguments, its output.
 */
export async function fingerprintFiles(lsTree: (...args: string[]) => Promise<string>, ref: string): Promise<FingerprintFiles> {
  const [root, config] = await Promise.all([lsTree('-z', ref), lsTree('-z', ref, '--', REPO_CONFIG_PATH)]);
  const blobs = (out: string) => zFields(out).flatMap((e) => {
    const m = /^\d+ blob (\w+)\t(.+)$/.exec(e);
    return m ? [[m[2]!, m[1]!] as const] : [];
  });
  return { lockfiles: Object.fromEntries(blobs(root).filter(([name]) => isLockfile(name))), config: blobs(config)[0]?.[1] ?? null };
}

/** As a ticket's `verify`, unless the request says otherwise: each sandbox, and each fetch from the forge. */
const DEADLINE_MS = VERIFY_TIMEOUT_MS + 60_000;
const OUTPUT_MAX = 4000;
const DETAIL_MAX = 300;
const DEPENDENCY = `a dependency is missing, or younger than the ${RELEASE_AGE_DAYS} days the setup allows`;

/**
 * What names a cause, in its order: the first pattern a line matches wins. A module is a dependency when named as a package
 * (`zod`, `@acme/ui/x`: npm's names, lower case) or by a path into `node_modules`; a path starting with `.` or `/` elsewhere, or an
 * alias (`@/lib/db`, `~/x`), is the repository's own. A bare path resolved through `baseUrl` (`src/x`) reads as a package name.
 */
const DEPENDENCY_LINES = [
  /No matching version found for \S+/,
  /ERR_PNPM_NO_MATURE_MATCHING_VERSION|minimumReleaseAge/,
  /Because there (?:is|are) no versions? of \S+|was not found in the package registry/,
  /No matching distribution found for \S+|Could not find a version that satisfies the requirement/,
  /Couldn't find any versions for|Couldn't find package/,
  /Cannot find (?:module|package) '(?:(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[^']*)?|[^']*\/node_modules\/[^']+)'/,
  /ModuleNotFoundError: No module named/,
  /No solution found when resolving/,
];
/** In the setup only: what an installer prints; in a test's output, a 404 is the application's. */
const INSTALL_LINES = [
  /can only install packages when your package\.json and package-lock\.json|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_FETCH_404/,
  /\b404\b.*Not Found|\bE404\b/,
  /\b(?:ETARGET|notarget|ERESOLVE)\b/,
];
/** The egress proxy's refusal of a host it does not allow: the repository needs a registry the factory does not let it reach. */
const REFUSED_LINES = [/egress proxy:|\b403\b.*Forbidden/];
/**
 * Each with the variable's names as its first group, upper case: a lower-case word is not one; the first, a list of them
 * (`Missing environment variables: API_URL, STRIPE_KEY`). Where nothing says it is a variable, its name must hold a `_`:
 * `URL is not defined` is a global, not a variable of the environment.
 */
const VARIABLE_LINES = [
  /(?:[Mm]issing|[Uu]ndefined|[Rr]equired|[Uu]nset) (?:required )?(?:environment |env )?variables?:?\s*[`'"]?([A-Z][A-Z0-9_]{2,}(?:[`'"]?\s*,\s*[`'"]?[A-Z][A-Z0-9_]{2,})*)/g,
  /[Ee]nvironment variable [`'"]?([A-Z][A-Z0-9_]{2,})/g,
  /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)[`'"]?\s+(?:is not set|is not defined|is undefined|is required|must be set|is missing)\b/g,
  /KeyError: '([A-Z][A-Z0-9]*_[A-Z0-9_]+)'/g,
];
const NAME = /[A-Z][A-Z0-9_]{2,}/g;
/** On the loopback, where the services listen. */
const SERVICE_LINES = [/ECONNREFUSED (?:127\.0\.0\.1|localhost|::1|\[::1\])(?::\d+)?/, /could not connect to (?:server|database)/i, /Is the server running/];
/** A line about the egress proxy's relay, whatever the tool's words (`port 3128 …: Could not connect to server`, curl's and git's). */
const PROXY_RELAY = /\b3128\b/;
const serviceLine = (line: string) => !PROXY_RELAY.test(line) && SERVICE_LINES.some((p) => p.test(line));
/**
 * A registry or the egress proxy not answering: nothing of the repository's state, which the dry run then does not record. The
 * proxy's 502 says so in its body (`egress proxy: getaddrinfo ENOTFOUND …`, `egress proxy: not sent on: …`), pip in a `ProxyError`.
 */
const UNREACHABLE_LINES = [
  /\b(?:ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|ESOCKETTIMEDOUT)\b|\b50[234]\b.*(?:Bad Gateway|Service Unavailable|Gateway Time-?out)/,
  // pip's and uv's.
  /Failed to establish a new connection|Temporary failure in name resolution|\bdns error\b/,
  /egress proxy: not sent on|\bProxyError\b|Cannot connect to proxy/,
];
const ERROR_LINE = /\b(?:error|fail(?:ed|ure)?|assert\w*|exception|traceback|panic)\b/i;

const brief = (line: string) => line.trim().slice(0, DETAIL_MAX);
const linesOf = (output: string) => output.replace(ANSI, '').split('\n').filter((l) => l.trim());

function firstLine(lines: readonly string[], patterns: readonly RegExp[]): string | undefined {
  for (const p of patterns) {
    for (const line of lines) if (p.test(line)) return line;
  }
  return undefined;
}

/**
 * The variables of the repository (ORC-211): the names `.factory/config.yml` declares under `env`, those of them the server
 * gives a value (`factory.yml`), the only ones in the sandbox, and the secrets it declares under `setup_secrets`: the dry run's
 * setup gets none, and no command gets one in any run, so what a line says of them is not read as a variable's cause.
 */
export interface DryRunVariables {
  env: readonly string[];
  provided: readonly string[];
  secrets: readonly string[];
}

/**
 * The first line that names a variable the code asks for and does not get, each of its names read: one the repository does not
 * declare, or failing that one it declares and the server gives no value. A name it is given, or a secret of its setup, is not that.
 */
function variableCause(lines: readonly string[], vars: DryRunVariables): string | undefined {
  for (const p of VARIABLE_LINES) {
    for (const line of lines) {
      const names = [...line.matchAll(p)].flatMap((m) => m[1]!.match(NAME) ?? []);
      const read = names.filter((n) => !vars.secrets.includes(n));
      const undeclared = read.filter((n) => !vars.env.includes(n));
      if (undeclared.length) return `a variable the repository does not declare under \`env\` (${undeclared.join(', ')}): ${brief(line)}`;
      const unprovided = read.filter((n) => !vars.provided.includes(n));
      if (unprovided.length) return `a variable the repository declares under \`env\` and \`factory.yml\` gives no value (${unprovided.join(', ')}): ${brief(line)}`;
    }
  }
  return undefined;
}

/**
 * What a failed setup or command broke on, read from its output: a dependency missing or too recent (in the setup, a registry the
 * egress proxy refuses too), a variable the code reads and does not get (undeclared, or with no value), a service that does not
 * answer on the loopback; anything else, a failure, said by its first error line. A reading of text: what a tool prints otherwise
 * is a failure, never a guess.
 */
export function classifyBreak(output: string, step: DryRunBreak['step'], vars: DryRunVariables): { kind: DryRunBreakKind; detail: string } {
  const lines = linesOf(output);
  const dependency = firstLine(lines, step === 'setup' ? [...DEPENDENCY_LINES, ...INSTALL_LINES] : DEPENDENCY_LINES);
  if (dependency) return { kind: 'dependency', detail: `${DEPENDENCY}: ${brief(dependency)}` };
  const refused = step === 'setup' ? firstLine(lines, REFUSED_LINES) : undefined;
  if (refused) return { kind: 'dependency', detail: `a registry the egress proxy does not allow: ${brief(refused)}` };
  const variable = variableCause(lines, vars);
  if (variable) return { kind: 'variable', detail: variable };
  const service = lines.find(serviceLine);
  if (service) return { kind: 'service', detail: `a service does not answer: ${brief(service)}` };
  const error = lines.find((l) => ERROR_LINE.test(l)) ?? lines.at(-1);
  return { kind: 'failure', detail: error ? brief(error) : 'it printed nothing' };
}

/**
 * The line of a setup's output that says a registry or the egress proxy did not answer: a breakdown, not the repository's state.
 * An output where a service of its own refuses on the loopback (`serviceLine`) is the repository's, none: the error that says
 * so spans lines of which only the first names the address (Node's `  code: 'ECONNREFUSED',` below it).
 */
export function unreachable(output: string): string | undefined {
  const lines = linesOf(output);
  if (lines.some(serviceLine)) return undefined;
  const line = firstLine(lines, UNREACHABLE_LINES);
  return line && brief(line);
}

const breakOf = (step: DryRunBreak['step'], command: string, output: string, vars: DryRunVariables): DryRunBreak => ({
  ...classifyBreak(output, step, vars), step, command, output: logExcerpt(output, OUTPUT_MAX),
});

/**
 * The breaks of the failed commands: a failing test that passed on its rerun is flaky; a command that failed on its flaky tests
 * alone has no other break, one that failed on more is classified by its output. A known flaky test of the repository does not count.
 */
export function breaksOfRuns(runs: readonly CommandRun[], standing: Standing, vars: DryRunVariables): DryRunBreak[] {
  return runs.flatMap((run) => {
    const settled = settle([run], standing);
    if (!settled.failures.length) return [];
    const counted = settled.flaky.filter((t) => !t.indicative);
    const flaky = counted.filter((t) => t.attempts.some((a) => a.on === 'head' && a.attempt === 2 && a.outcome === 'passed'));
    const output = logExcerpt(run.output, OUTPUT_MAX);
    const breaks = flaky.map((t): DryRunBreak => ({ kind: 'flaky', step: 'command', command: run.command, detail: `${t.test} failed, then passed on its rerun`, output }));
    // `withoutIndicative` is set only when every failing test is a known flaky one, none of them counted.
    const onlyFlaky = flaky.length > 0 && flaky.length === counted.length && !run.notRerun && run.withoutIndicative === undefined;
    return onlyFlaky ? breaks : [...breaks, breakOf('command', run.command, run.output, vars)];
  });
}

/** The forge's default branch into the clone, and the commit given when the fetch of it did not bring it. */
async function fetchCommit(req: DryRunRequest, git: CloneGit, cloneDir: string): Promise<string> {
  const fetch = (refspecs: string[], said: string) =>
    within(fetchFromForge(req, cloneDir, refspecs, said), req.deadlineMs ?? DEADLINE_MS, `the forge no longer responds: ${said}`);
  await fetch([`+HEAD:${BASE}`], "the forge's default branch");
  if (!req.sha) return git('rev-parse', '--verify', `${BASE}^{commit}`);
  const sha = req.sha;
  const held = async () => {
    const r = await git.status('rev-parse', '--verify', '--quiet', `${sha}^{commit}`);
    return r.code === 0 ? r.stdout.trim() : undefined;
  };
  const said = `the commit ${sha.slice(0, 12)}`;
  const found = await held();
  if (found) return found;
  await fetch([sha], `${said} of the forge`);
  const fetched = await held();
  if (!fetched) throw new Error(`${said} is not on the forge`);
  return fetched;
}

/**
 * The dry run (ORC-408): the commit, the forge's default branch or the one given, as `verify` would set it up for a ticket.
 *
 * 1. on the host, a clone of ours without the repository's config, the commit fetched from the forge; `.factory/config.yml`,
 *    the fingerprint's inputs and the runner of each command read there, before any of its code runs;
 * 2. the checkout, in a sandbox at network `none`;
 * 3. `setup`, sealed as an attempt's (`runSealedSetup`), at `limited` (N2: the registries the egress proxy allows), without a
 *    secret, on services of its own;
 * 4. the commands, in a new sandbox at `none` on those services, each failing test their runner names rerun once (`runAndRerun`).
 *
 * What the commit breaks on is recorded red, classified (`classifyBreak`): its config refused, a service no sandbox provides, its
 * setup, its commands. What the factory cannot tell of it rejects, without a dry run: the forge or the engine down.
 */
export async function runDryRun(req: DryRunRequest): Promise<DryRun> {
  if (req.sha !== undefined && !SHA.test(req.sha)) throw new Error(`${req.sha}: a full commit sha expected`);
  const startedAt = req.now();
  const sandboxes = withDeadline(req.sandboxes, req.deadlineMs ?? DEADLINE_MS);
  const inBox = boxOpener(sandboxes, { runId: req.runId, ticketId: req.projectId, log: req.log });
  // Beside the host git's own config (`cloneGit` writes it in `workDir`), never in the tree the sandboxes mount.
  const cloneDir = join(req.workDir, 'clone');
  mkdirSync(cloneDir);
  const git = cloneGit(req, cloneDir);
  await initHardenedClone(git);
  const sha = await fetchCommit(req, git, cloneDir);
  const files = await fingerprintFiles((...args) => git.raw('ls-tree', ...args), sha);
  const dryRun = (breaks: DryRunBreak[], ranSetup: readonly string[], ran: readonly string[]): DryRun => ({
    id: req.runId, projectId: req.projectId, sha, target: req.sha ? 'commit' : 'main', ok: !breaks.length,
    fingerprint: dryRunFingerprint({ setup: ranSetup, image: req.image, ...files }), breaks, commands: [...ran], startedAt, endedAt: req.now(),
  });
  let config: RepoConfig;
  try {
    config = parseRepoConfig(await show(git, sha, REPO_CONFIG_PATH));
  } catch (err) {
    if (!(err instanceof RepoConfigError)) throw err;
    const broke: DryRunBreak = { kind: 'failure', step: 'config', command: REPO_CONFIG_PATH, detail: brief(err.message.replaceAll('\n', ' ')), output: err.message };
    return dryRun([broke], req.setup, []);
  }
  const declared = Object.values(config.commands);
  const commands = declared.length ? declared : req.commands;
  const setup = setupOf(config, req.setup);
  const unprovided = req.sandboxes.unprovided([...new Set(config.services)]);
  if (unprovided.length) {
    const detail = `${unprovided.join(', ')}: declared under \`services\` in ${REPO_CONFIG_PATH}, and no sandbox backend of this factory provides ${unprovided.length === 1 ? 'it' : 'them'}`;
    return dryRun([{ kind: 'service', step: 'config', command: REPO_CONFIG_PATH, detail, output: '' }], setup, []);
  }
  await inBox('prepare', cloneDir, [], async (id) => {
    // `-c`: the clone's config is ours.
    const out = await sandboxes.exec(id, ['git', ...IN_SANDBOX, 'checkout', '--quiet', '--detach', sha]);
    if (out.code !== 0) throw new Error(`git checkout (sandbox): ${out.stderr.trim()}`);
  });
  // Read before any of its code runs, and before the setup opens services that a failure here would leave behind.
  const tests = await testCommands(git, sha, commands);
  const env = await req.env(config);
  const vars: DryRunVariables = { env: config.env, provided: Object.keys(env), secrets: config.setupSecrets };
  if (setup.length) {
    try {
      await runSealedSetup(sandboxes, { runId: `${req.runId}-run`, ticketId: req.projectId, workspacePath: cloneDir, mounts: [], commands: setup, argv: verifyCommand, env, secrets: {}, services: config.services, now: new Date(req.now()) });
    } catch (err) {
      if (!(err instanceof SetupFailure)) throw err;
      const broke: DryRunBreak = err.exitCode === null
        ? { kind: 'failure', step: 'setup', command: err.command, detail: err.message, output: logExcerpt(err.output, OUTPUT_MAX) }
        : breakOf('setup', err.command, err.output, vars);
      // A registry or the proxy that did not answer says nothing of the repository: no dry run, as for the forge or the engine,
      // whether the setup failed or ran over its cap. A dependency it then says is missing was not reached; a variable or a
      // service of the repository's own is its own, past an installer's retry warning (pip's `Retrying … ProxyError`).
      const down = broke.kind === 'failure' || broke.kind === 'dependency' ? unreachable(err.output) : undefined;
      if (down) throw new Error(`${err.command}: a registry or the egress proxy did not answer, no dry run recorded: ${down}`, { cause: err });
      return dryRun([broke], setup, []);
    }
  }
  const standing: Standing = { known: req.knownFlaky ?? [] };
  const failed: CommandRun[] = [];
  await inBox('run', cloneDir, [], async (id) => {
    for (const command of commands) {
      const { line, runner } = tests.get(command)!;
      const run = await runAndRerun(command, runner, reportRun(sandboxes, id, env), standing, line);
      if (run) failed.push(run);
    }
  }, { ...DEFAULT_REQUIREMENTS, services: config.services });
  return dryRun(breaksOfRuns(failed, standing, vars), setup, commands);
}

/**
 * Whether a project's last dry run still tells the state of its default branch (ORC-409): it ran with what a dry run would run
 * with now (`fingerprint`), and, red, on the commit `sha` itself, so that a fix of the code lifts it once the branch moved. A
 * green one holds over a branch that moved with the same inputs.
 */
export const dryRunHolds = (last: DryRun, now: { sha: string; fingerprint: DryRunFingerprint }): boolean =>
  last.fingerprint.hash === now.fingerprint.hash && (last.ok || last.sha === now.sha);

/** What breaks a dry run, each kind in its command once (ORC-409, and the `main` maturity card of ORC-410). */
export const dryRunBroke = (run: DryRun): string => [...new Set(run.breaks.map((b) => `${b.kind} in \`${b.command}\``))].join(', ');

/**
 * The `main` maturity card's value (ORC-410): the project's last dry run on its default branch, green or red with what breaks,
 * its commit and when it ended; without one, not checked yet. `init` stores it, and each dry run on main sets it (ORC-437).
 */
export function mainCardValue(run: DryRun | undefined): string {
  if (!run) return MAIN_UNCHECKED;
  const of = `the dry run of ${run.sha.slice(0, 12)} on ${utc(run.endedAt)}`;
  if (run.ok) return `green: ${of}${run.commands.length ? ` (${run.commands.join(' · ')})` : ''}`;
  const broke = dryRunBroke(run) || 'no break recorded';
  return `red: ${of}: ${broke}\nfix it on main, then factory dry-run ${run.projectId}`;
}

/**
 * What the block of a ticket a red dry run refuses says (ORC-409): what breaks, each break in its step, its command and the
 * line that names its cause; and how it runs again.
 */
export function dryRunRefusal(run: DryRun): { reason: string; tried: string[]; question: string } {
  const broke = dryRunBroke(run);
  return {
    reason: `The dry run of the repository is red on its default branch (${run.sha.slice(0, 12)}): ${broke}. No ticket of the repository starts until it is green.`,
    tried: run.breaks.map((b) => `The dry run's ${b.step}, \`${b.command}\`: ${b.kind}, ${b.detail}`),
    question: `Can you fix it on the default branch, then reply here? The dry run runs again once the branch has moved, or when its setup, a lockfile, .factory/config.yml or the runner image change. A cause outside the repository (a variable of factory.yml, a registry, a flaky test now on the known list): run \`factory dry-run ${run.projectId}\` once it is fixed, then reply.`,
  };
}
