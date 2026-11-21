import { parseAllDocuments } from 'yaml';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import type { SandboxLimits } from '../adapters/sandbox/docker-rootless.js';
import {
  GitHubAppApi,
  type BranchProtection,
  type EnvironmentProtection,
  type WorkflowSource,
} from '../adapters/forge/github-app-api.js';
import { UnreadableAnswerError, type HttpClient } from '../adapters/forge/github-app.js';
import { resolveGithubApp } from '../config/github-app.js';
import { GITHUB_APP_OPTIONAL_PERMISSIONS, GITHUB_APP_PERMISSIONS } from './init.js';
import { GITHUB_APP_SECRETS, LINEAR_SECRETS, loadSealedFactoryYml, serverSecretLines, serverSecretReport, type SecretReport } from '../config/server-secrets.js';
import { effectiveInstance, samePath, validatorWarnings, type ProjectConfig } from '../config/instance.js';
import type { Workflow } from '../core/workflow.js';
import { isFantome } from '../presets/fantome.js';
import { defaultWorkflow, missingStatusWarning } from '../presets/workflow.js';
import { activeClaudeAccount, claudeAccountReader, stepSettings } from '../config/factory-yml.js';
import { startRefusals } from '../config/start-refusals.js';
import { cliLinearTracker } from './linear.js';
import { projectGithub } from '../app/project-github.js';
import { makeRepoConfig } from '../app/repo-variables.js';
import { browserImage, sandboxConfig, sandboxLimits, visualProofLine } from '../app/sandbox-wiring.js';
import { ignoredWorkflowFiles, ignoredWorkflowWarning, testCommandWarnings, type RepoConfig } from '../config/repo-config.js';
import { branchNameOfType, branchSpaces, branchTypes, DEFAULT_BRANCH_NAMING, LEGACY_BRANCHES, legacyBranchName, type BranchNaming } from '../core/naming.js';

/**
 * Branches as the factory names them (ORC-353, ORC-283): by the repository's naming, every type of it, and the legacy
 * `factory/<id>-<slug>` a ticket with its PR already open keeps; a team key for every initial (one with a digit too),
 * numbers of every length, titles that start and end with a letter or a digit, the longest slug and the empty title's.
 * Enough to decide whether a filter reaches the factory's branches, or leaves every one of them out; a sample all the
 * same, not every branch (docs/github.md). A pattern under one of their fixed beginnings (`feat/`, `fix/`, `factory/`)
 * always counts as reaching: it may name a team key no probe has.
 */
interface FactoryBranches {
  probes: string[];
  spaces: string[];
}

const PROBE_TITLES = ['', 'Fix the login', '2026 : Été', 'x'.repeat(60), 'a-b c', 'Upgrade to v2', '42'];
const PROBE_KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ZZ9'];

function factoryBranches(naming: BranchNaming): FactoryBranches {
  const types = branchTypes(naming);
  const probes = PROBE_KEYS.flatMap((key, i) =>
    PROBE_TITLES.flatMap((title, j) => {
      const id = `${key}-${[1, 42, 353, 70000][(i + j) % 4]}`;
      return [...types.map((type) => branchNameOfType(id, title, type, naming)), legacyBranchName(id, title)];
    }),
  );
  return { probes, spaces: [...branchSpaces(naming), LEGACY_BRANCHES] };
}

/** Each read names the repository on GitHub, `owner/name` (ORC-478). */
export interface DoctorApi {
  listWorkflows(github: string): Promise<WorkflowSource[]>;
  listEnvironments(github: string): Promise<EnvironmentProtection[]>;
  branchProtection(github: string): Promise<BranchProtection>;
  installationPermissions(github: string): Promise<Record<string, string>>;
}

type Verdict = 'accepted' | 'refused';

/**
 * The host as the sandbox limits need it (ORC-208), as its engine reports it: cgroup v2, and the limits it can set. What the
 * engine did not say is absent, never `false`: an engine that cannot be asked or read leaves only the verdict and its reason.
 */
export interface HostReport {
  /** The engine asked, `FACTORY_CONTAINER_CLI`. */
  engine?: 'docker' | 'podman';
  cgroupV2?: boolean;
  /** Of `cpu`, `memory` and `pids`, the controllers the engine can set its limits through. */
  controllers?: string[];
  rootless?: boolean;
  verdict: Verdict;
  reasons: string[];
}

/** The limits of an attempt's containers, each by the controller it is set through: CPUs, memory, processes (docs/tests.md, isolation 9). */
const LIMIT_CONTROLLERS: Record<keyof SandboxLimits, string> = { cpus: 'cpu', memory: 'memory', pids: 'pids' };
const REQUIRED_CONTROLLERS = Object.values(LIMIT_CONTROLLERS);

/** What `info` says of the cgroups, whichever the engine. */
interface EngineCgroups {
  cgroupV2: boolean;
  controllers: string[];
  rootless: boolean;
  /** Docker's CgroupDriver, Podman's cgroupManager: rootless, the engine ignores the limits off `systemd`. */
  manager: string | undefined;
}

/**
 * Asks the engine the sandboxes run on (ORC-208), `FACTORY_CONTAINER_CLI`, rather than this process's cgroups: run in the
 * `factoryd` container, `doctor` sees a cgroup namespace of its own, and its uid is not the engine's. A rootless engine
 * reports the controllers delegated to its user, the only ones it can limit through.
 */
export async function checkHost(env: NodeJS.ProcessEnv, run: Exec = execCmd): Promise<HostReport> {
  const sandbox = sandboxConfig(env);
  if (!sandbox) return { verdict: 'refused', reasons: ['no container engine (FACTORY_CONTAINER_CLI is not set): nothing limits the sandbox'] };
  // What the start refuses, with its message (ORC-449), and a limit's refusal, which `sandboxConfig` drops behind another one (ORC-455).
  const limits = sandboxLimits(env);
  const refused = 'refusal' in sandbox ? [sandbox.refusal] : [];
  if ('refused' in limits && !refused.includes(limits.refused)) refused.push(limits.refused);
  const { cli } = sandbox;
  if (!cli) return { verdict: 'refused', reasons: refused };
  let cgroups: EngineCgroups;
  try {
    const args = cli === 'docker' ? ['info', '--format', '{{json .}}'] : ['info', '--format', 'json'];
    const info: unknown = JSON.parse(await mustExec(run, cli, args, { timeoutMs: 60_000 }));
    cgroups = cli === 'docker' ? dockerCgroups(info) : podmanCgroups(info);
  } catch (error) {
    return { engine: cli, verdict: 'refused', reasons: [...refused, `cannot read the cgroups of the engine (${cli} info): ${errorMessage(error).slice(0, 600)}`] };
  }
  const { cgroupV2, controllers, rootless, manager } = cgroups;
  const linger = 'sudo loginctl enable-linger <user>, docs/tests.md';
  const reasons = [...refused];
  // Only the limits set (ORC-451): one at `none` is the way out of a host without its controller; a refused one leaves every controller required.
  const required = Object.entries(LIMIT_CONTROLLERS)
    .filter(([limit]) => 'refused' in limits || limits[limit as keyof SandboxLimits] !== undefined)
    .map(([, controller]) => controller);
  const missing = required.filter((controller) => !controllers.includes(controller));
  // On cgroups v1, no delegation makes the limits work: the version alone is said.
  if (!cgroupV2) reasons.push(`no cgroup v2: ${cli} runs on cgroups v1 or the hybrid layout, the sandbox cannot limit processes, memory and CPUs`);
  else if (rootless && manager !== 'systemd') {
    // Whatever the controllers it lists: Docker's rootless driver `none` (no user session), Podman's `cgroupfs`.
    reasons.push(`rootless ${cli} on the ${manager ?? 'unknown'} cgroup manager ignores the limits: it needs systemd, a user session (${linger})`);
  } else if (missing.length > 0) {
    reasons.push(`${cli} cannot limit through the ${missing.join(', ')} controller(s)${rootless ? `, not delegated to its user (${linger})` : ''}`);
  }
  return {
    engine: cli,
    cgroupV2,
    controllers,
    rootless,
    verdict: reasons.length > 0 ? 'refused' : 'accepted',
    reasons: reasons.length > 0 ? reasons : [`${rootless ? 'rootless ' : ''}${cli} on cgroup v2, ${required.length > 0 ? `limits through ${required.join(', ')}` : 'no limit set (FACTORY_SANDBOX_*)'}`],
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** `docker info --format '{{json .}}'`: one flag per limit, which a rootless engine sets from its user's delegated controllers. */
function dockerCgroups(info: unknown): EngineCgroups {
  if (!isObject(info)) throw new Error('not a JSON object');
  const errors = info['ServerErrors'];
  if (Array.isArray(errors) && errors.length > 0) throw new Error(errors.join('; '));
  const version = info['CgroupVersion'];
  if (typeof version !== 'string' || version === '') throw new Error('no CgroupVersion in its answer');
  const flags: Record<string, string> = { cpu: 'CpuCfsQuota', memory: 'MemoryLimit', pids: 'PidsLimit' };
  const options = Array.isArray(info['SecurityOptions']) ? info['SecurityOptions'] : [];
  return {
    cgroupV2: version === '2',
    controllers: REQUIRED_CONTROLLERS.filter((controller) => info[flags[controller]!] === true),
    rootless: options.some((option) => typeof option === 'string' && option.split(',').includes('name=rootless')),
    manager: typeof info['CgroupDriver'] === 'string' ? info['CgroupDriver'] : undefined,
  };
}

/** `podman info --format json`: the controllers of its cgroup. */
function podmanCgroups(info: unknown): EngineCgroups {
  const host = isObject(info) ? info['host'] : undefined;
  if (!isObject(host)) throw new Error('no host in its answer');
  const version = host['cgroupVersion'];
  if (typeof version !== 'string' || version === '') throw new Error('no host.cgroupVersion in its answer');
  const listed = host['cgroupControllers'];
  const controllers = Array.isArray(listed) ? listed.filter((c): c is string => typeof c === 'string') : [];
  const rootless = isObject(host['security']) && host['security']['rootless'] === true;
  const manager = host['cgroupManager'];
  return { cgroupV2: version === 'v2', controllers, rootless, manager: typeof manager === 'string' ? manager : undefined };
}

/** The protection's verdict; what was read of it, absent when it could not be read. */
export interface BranchProtectionReport extends Partial<BranchProtection> {
  verdict: Verdict;
  reasons: string[];
  /** What `doctor` cannot check and a human must: told with an accepted verdict, never part of it. */
  warnings?: string[];
}

/**
 * Told with every accepted protection (ORC-428): GitHub shows a ruleset's `bypass_actors` only with the Administration
 * permission the App must not have, so a credential of the daemon's user that bypasses goes unread (docs/github.md).
 */
const BYPASS_ACTORS_WARNING =
  'Warning: bypass actors not read: GitHub shows them only with the Administration permission, which the App is not given (docs/github-app-manifest.json). ' +
  "Check by hand that no git credential of the daemon's user (SSH keys or agent, HTTPS credential helper, gh token) bypasses this branch's rules: " +
  'in each ruleset that requires a pull request, the repository\'s and the organization\'s, no bypass actor its account holds ' +
  '(Repository admin or another role, Organization admin, its team, its user, or Deploy key for a deploy key); ' +
  'on a classic protection, "Do not allow bypassing the above settings" checked and no allowed bypass for it. ' +
  'Otherwise any process of that user on this machine pushes to the default branch without a pull request; no agent holds such a credential, they run in containers only (docs/github.md).';

/**
 * Whether GitHub keeps the default branch for humans (ORC-208): a ruleset rule that requires a pull request, which the
 * App cannot bypass, or the classic protection, whose rules the App cannot read (credited on its flag, docs/github.md
 * says what it must hold).
 */
function judgeProtection(protection: BranchProtection): BranchProtectionReport {
  const report = (verdict: Verdict, reason: string): BranchProtectionReport => ({
    ...protection,
    verdict,
    reasons: [reason],
    ...(verdict === 'accepted' ? { warnings: [BYPASS_ACTORS_WARNING] } : {}),
  });
  const rules = protection.rules.join(', ');
  if (protection.pullRequestRulesets.some((ruleset) => ruleset.bypass === 'never')) {
    return report('accepted', `a ruleset the App cannot bypass requires a pull request (rules: ${rules})`);
  }
  const bypassed = protection.pullRequestRulesets.map((ruleset) => `ruleset ${ruleset.id} (${ruleset.bypass})`).join(', ');
  // A ruleset the App bypasses does not count, and takes nothing from a classic protection.
  if (protection.classic) {
    return report('accepted', 'branch protection on; its rules need the Administration permission, which the App does not have: check it requires a pull request (docs/github.md)');
  }
  if (bypassed) {
    return report('refused', `not protected from the factory: its App can bypass every ruleset that requires a pull request, ${bypassed}; remove it from their bypass list`);
  }
  return report(
    'refused',
    protection.rules.length > 0
      ? `not protected: its rulesets (${rules}) do not require a pull request (\`pull_request\` rule), a direct push still lands`
      : 'not protected: no branch protection and no ruleset',
  );
}

export interface DoctorOptions {
  repoPath: string;
  /** Its repository on GitHub, `owner/name`, as the daemon resolves it at its start (`projectGithub`, ORC-478). */
  github: string;
  api: DoctorApi;
  /** The host the daemon runs on (`checkHost`). */
  host: HostReport;
  out: (line: string) => void;
  json?: boolean;
  /** The repository's branch naming (`.factory/config.yml`, ORC-283): the team's convention without it. */
  naming?: BranchNaming;
  /** The repository's commands (`.factory/config.yml`): a warning without `test`, the red check's command (ORC-412). */
  commands?: Readonly<Record<string, string>>;
  /**
   * Whether this instance can take the visual proof (ORC-404), `browserImage`'s answer, for the JSON report, failures included:
   * never part of the verdict. In text, `runDoctorCommand` says it first.
   */
  visualProof?: { image?: string; detail: string };
  /** The server secrets (ORC-398): where each is kept and its rotation, for the JSON report; never part of the verdict. In text, `runDoctorCommand` says it first. */
  serverSecrets?: SecretReport[];
  /** The projects whose spec gate no validator can pass (ORC-421), for the JSON report; never part of the verdict. In text, `runDoctorCommand` says them first. */
  validatorWarnings?: string[];
  /**
   * The warnings of the daemon's start (`startRefusals`), for the JSON report: the Smee relay of a factory.yml without the development
   * mode's marker (ORC-446), a SQLite file left from before Postgres (ORC-463), a file of the instance from before factory.yml (ORC-199). Never part of the verdict (the refusals stop doctor
   * first, exit 1). In text, `runDoctorCommand` says them first.
   */
  startWarnings?: string[];
}

type InstanceReport = Pick<DoctorOptions, 'visualProof' | 'serverSecrets' | 'validatorWarnings' | 'startWarnings'>;

/** The visual proof (ORC-404), the server secrets (ORC-398), the validators (ORC-421) and the start's warnings (ORC-446, ORC-463) in the JSON report. */
const instanceReportOf = (o: InstanceReport) => ({
  ...(o.visualProof ? { visualProof: { available: !!o.visualProof.image, detail: o.visualProof.detail } } : {}),
  ...(o.serverSecrets ? { serverSecrets: o.serverSecrets } : {}),
  ...(o.validatorWarnings?.length ? { validatorWarnings: o.validatorWarnings } : {}),
  ...(o.startWarnings?.length ? { startWarnings: o.startWarnings } : {}),
});

export interface WorkflowReport {
  path: string;
  triggers: string[];
  secrets: boolean;
  /** The jobs whose GITHUB_TOKEN can write (ORC-353), with their rights: the token is a secret by what it can do. */
  githubToken: { job: string; rights: string }[];
  /** Whether a trigger can run the workflow on a branch the factory names (ORC-353). */
  factoryBranches: boolean;
  environments: { name: string; requiredReviewers: boolean }[];
  /** True when every job that can see a secret or a writable GITHUB_TOKEN is attached to a protected environment. */
  protected: boolean;
  verdict: 'accepted' | 'refused';
  reasons: string[];
}

interface TriggerFilters {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
}

interface ParsedWorkflow {
  triggers: Map<string, TriggerFilters>;
  jobEnvironments: Map<string, string>;
  environmentNames: string[];
  hasSecrets: boolean;
  /** Jobs that can see a secret; every job when a workflow-level value references one. */
  secretJobs: string[];
  /** Jobs whose GITHUB_TOKEN can write, by job, with their rights. */
  tokenWrites: Map<string, string>;
  /** Jobs that can see a secret or a writable GITHUB_TOKEN, in the workflow's order. */
  sensitiveJobs: string[];
}

type ParseResult = { ok: true; workflow: ParsedWorkflow } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const trimmed = item.trim();
    if (!trimmed || trimmed.includes('${{')) return undefined;
    out.push(trimmed);
  }
  return out;
}

function parseTriggerFilters(value: unknown): TriggerFilters | undefined {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const branches = value['branches'] === undefined ? undefined : asStringList(value['branches']);
  if (value['branches'] !== undefined && branches === undefined) return undefined;
  const branchesIgnore = value['branches-ignore'] === undefined ? undefined : asStringList(value['branches-ignore']);
  if (value['branches-ignore'] !== undefined && branchesIgnore === undefined) return undefined;
  const tags = value['tags'] === undefined ? undefined : asStringList(value['tags']);
  if (value['tags'] !== undefined && tags === undefined) return undefined;
  const tagsIgnore = value['tags-ignore'] === undefined ? undefined : asStringList(value['tags-ignore']);
  if (value['tags-ignore'] !== undefined && tagsIgnore === undefined) return undefined;
  if (branches !== undefined && branchesIgnore !== undefined) return undefined;
  if (tags !== undefined && tagsIgnore !== undefined) return undefined;
  return {
    ...(branches === undefined ? {} : { branches }),
    ...(branchesIgnore === undefined ? {} : { branchesIgnore }),
    ...(tags === undefined ? {} : { tags }),
    ...(tagsIgnore === undefined ? {} : { tagsIgnore }),
  };
}

function parseOn(value: unknown): Map<string, TriggerFilters> | string {
  if (typeof value === 'string') {
    const name = value.trim();
    if (!name || name.includes('${{')) return 'dynamic or empty `on` trigger';
    return new Map([[name, {}]]);
  }
  if (Array.isArray(value)) {
    const triggers = new Map<string, TriggerFilters>();
    for (const item of value) {
      if (typeof item !== 'string') return 'ambiguous `on` trigger list';
      const name = item.trim();
      if (!name || name.includes('${{')) return 'dynamic or empty `on` trigger';
      triggers.set(name, {});
    }
    return triggers;
  }
  if (!isRecord(value)) return 'ambiguous `on` trigger';
  const triggers = new Map<string, TriggerFilters>();
  for (const [rawName, rawFilters] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name || name.includes('${{')) return 'dynamic or empty `on` trigger';
    // A list of crons, without branch filter: it runs on the default branch only, never a factory branch (ORC-473).
    const filters = name === 'schedule' && Array.isArray(rawFilters) ? {} : parseTriggerFilters(rawFilters);
    if (!filters) return `ambiguous filters for the \`${name}\` trigger`;
    triggers.set(name, filters);
  }
  return triggers;
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * The `secrets` context in an expression: `secrets.X`, `secrets['X']`, or the whole context (`toJSON(secrets)`); never a
 * property of another one (`inputs.secrets`).
 */
const SECRETS_CONTEXT = /(?<![\w.-])secrets\b(?:\s*\.\s*([A-Za-z_][\w-]*)|\s*\[\s*(['"])([^'"]*)\2\s*\])?/gi;

/** Whether an expression reads a repository secret: `secrets.GITHUB_TOKEN` is the token, judged by its rights (ORC-353). */
function expressionReadsSecret(expression: string): boolean {
  for (const match of expression.matchAll(SECRETS_CONTEXT)) {
    const name = match[1] ?? match[3];
    if (name?.toUpperCase() !== 'GITHUB_TOKEN') return true;
  }
  return false;
}

/** The expressions of a value: each `${{ … }}`, and an `if:` whole, which GitHub reads as one without them. */
function expressionsOf(text: string, key?: string): string[] {
  const inline = [...text.matchAll(EXPRESSION)].map((match) => match[1] ?? '');
  return key === 'if' && inline.length === 0 ? [text] : inline;
}

/** Whether a subtree reads a repository secret (ORC-353): in its expressions only, never in a shell text that names one. */
function readsSecrets(value: unknown, key?: string): boolean {
  if (typeof value === 'string') return expressionsOf(value, key).some(expressionReadsSecret);
  if (Array.isArray(value)) return value.some((item) => readsSecrets(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, child]) => expressionsOf(childKey).some(expressionReadsSecret) || readsSecrets(child, childKey));
}

/** A job that calls a reusable workflow with `secrets: inherit` hands it every secret, which doctor does not read. */
const jobReadsSecrets = (job: Record<string, unknown>): boolean => (job['uses'] !== undefined && job['secrets'] === 'inherit') || readsSecrets(job);

const PERMISSION_LEVELS = new Set(['read', 'write', 'none']);

/**
 * The write rights a `permissions:` value gives the GITHUB_TOKEN (ORC-353): `read-all` and `{}` none, `write-all` all of
 * them, a map the scopes it sets to `write`. `undefined` for a value doctor cannot read.
 */
function writeRights(value: unknown): string | undefined {
  if (value === 'read-all') return '';
  if (value === 'write-all') return 'write-all';
  if (!isRecord(value)) return undefined;
  const scopes: string[] = [];
  for (const [scope, level] of Object.entries(value)) {
    if (typeof level !== 'string' || !PERMISSION_LEVELS.has(level)) return undefined;
    if (level === 'write') scopes.push(scope);
  }
  return scopes.length > 0 ? `write: ${scopes.join(', ')}` : '';
}

/** Without `permissions:`, the token has the repository's default rights, which the App cannot read: perhaps write. */
const REPOSITORY_DEFAULT = 'repository default';

function parseWorkflow(content: string): ParseResult {
  let documents;
  try {
    documents = parseAllDocuments(content);
  } catch {
    return { ok: false, reason: 'unreadable YAML (the parser refused the file)' };
  }
  if (documents.length !== 1) return { ok: false, reason: 'ambiguous YAML: a workflow must hold a single document' };
  const document = documents[0]!;
  if (document.errors.length > 0) return { ok: false, reason: 'invalid YAML (syntax error)' };
  if (document.warnings.length > 0) return { ok: false, reason: 'ambiguous YAML (parser warning)' };

  let root: unknown;
  try {
    root = document.toJS();
  } catch {
    return { ok: false, reason: 'ambiguous YAML (unreadable structure)' };
  }
  if (!isRecord(root)) return { ok: false, reason: 'empty workflow or invalid YAML root' };

  if (root['on'] === undefined) return { ok: false, reason: 'no `on` trigger: impossible to know when the CI runs' };
  const parsedOn = parseOn(root['on']);
  if (typeof parsedOn === 'string') return { ok: false, reason: parsedOn };

  const rawJobs = root['jobs'];
  if (!isRecord(rawJobs)) return { ok: false, reason: 'missing or invalid `jobs` section' };

  const workflowRights = root['permissions'] === undefined ? REPOSITORY_DEFAULT : writeRights(root['permissions']);
  if (workflowRights === undefined) return { ok: false, reason: 'ambiguous `permissions` of the workflow' };

  const jobs = new Map<string, Record<string, unknown>>();
  const jobEnvironments = new Map<string, string>();
  const environmentNames: string[] = [];
  const tokenWrites = new Map<string, string>();
  for (const [jobId, rawJob] of Object.entries(rawJobs)) {
    if (!isRecord(rawJob)) return { ok: false, reason: `job \`${jobId}\` invalide` };
    jobs.set(jobId, rawJob);
    const rights = rawJob['permissions'] === undefined ? workflowRights : writeRights(rawJob['permissions']);
    if (rights === undefined) return { ok: false, reason: `ambiguous \`permissions\` for the job \`${jobId}\`` };
    if (rights) tokenWrites.set(jobId, rights);
    const environment = rawJob['environment'];
    if (environment !== undefined) {
      let name: string | undefined;
      if (typeof environment === 'string') name = environment.trim();
      else if (isRecord(environment) && typeof environment['name'] === 'string') name = environment['name'].trim();
      if (!name || name.includes('${{')) return { ok: false, reason: `ambiguous environment for the job \`${jobId}\`` };
      jobEnvironments.set(jobId, name);
      if (!environmentNames.includes(name)) environmentNames.push(name);
    }
  }

  // Workflow-level values (its `env`, `defaults`) are inherited by every job.
  const rootSecrets = Object.entries(root).some(([key, child]) => key !== 'jobs' && readsSecrets(child, key));
  const secretJobs = [...jobs].filter(([, job]) => rootSecrets || jobReadsSecrets(job)).map(([jobId]) => jobId);

  return {
    ok: true,
    workflow: {
      triggers: parsedOn,
      jobEnvironments,
      environmentNames,
      hasSecrets: rootSecrets || secretJobs.length > 0,
      secretJobs,
      tokenWrites,
      // A writable GITHUB_TOKEN is a secret by what it can do on the repository (ORC-353): it pushes, tags, releases.
      sensitiveJobs: [...jobs.keys()].filter((jobId) => secretJobs.includes(jobId) || tokenWrites.has(jobId)),
    },
  };
}

/** Converts a GitHub branch glob to a regexp; `*` never crosses `/`, `**` does. */
function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index++;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', index + 1);
      if (end === -1) {
        source += '\\[';
      } else {
        let body = glob.slice(index + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        source += `[${body}]`;
        index = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\\/]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

/** A filter's pattern, compiled once: whether it lets a branch in, and what it matches (`regexp: null`, a glob doctor cannot read). */
interface FilterPattern {
  lets: boolean;
  glob: string;
  regexp: RegExp | null;
}

/** `ignore`: a `branches-ignore`, where a pattern leaves a branch out and a `!` brings it back. */
function compileFilter(patterns: readonly string[], ignore: boolean): FilterPattern[] {
  return patterns.map((pattern) => {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    let regexp: RegExp | null = null;
    try {
      regexp = globToRegExp(glob);
    } catch {
      // Unreadable: it counts when it would let the branch run, never when it would leave it out (fail closed).
    }
    return { lets: negated === ignore, glob, regexp };
  });
}

/** Whether a filter lets the workflow run on `branch`: GitHub reads its patterns in order, the last that matches wins. `runs`: before the first. */
function runsOn(filter: readonly FilterPattern[], branch: string, runs: boolean): boolean {
  for (const { lets, regexp } of filter) if (regexp ? regexp.test(branch) : lets) runs = lets;
  return runs;
}

/**
 * Whether a `branches` or `branches-ignore` filter can let the workflow run on a factory branch: on one of the probes, or
 * by a pattern that lets in under the factory's own space (`feat/…`), which may name a team key no probe has, unless the
 * patterns after it leave out every probe of that space.
 */
function filterReachesFactory(patterns: readonly string[], factory: FactoryBranches, ignore: boolean): boolean {
  // Negations only: GitHub runs on no branch, which doctor does not count on.
  if (!ignore && patterns.every((pattern) => pattern.startsWith('!'))) return true;
  const filter = compileFilter(patterns, ignore);
  if (factory.probes.some((probe) => runsOn(filter, probe, ignore))) return true;
  return filter.some(({ lets, glob }, index) => {
    const space = lets ? factory.spaces.find((s) => glob.startsWith(s)) : undefined;
    return space !== undefined && factory.probes.some((probe) => probe.startsWith(space) && runsOn(filter.slice(index + 1), probe, true));
  });
}

/** Branch push: an absent filter means all branches; a tags-only filter means no branch push. */
function pushReachesFactory(filters: TriggerFilters, factory: FactoryBranches): boolean {
  if (filters.branches !== undefined) return filterReachesFactory(filters.branches, factory, false);
  if (filters.branchesIgnore !== undefined) return filterReachesFactory(filters.branchesIgnore, factory, true);
  if (filters.tags !== undefined || filters.tagsIgnore !== undefined) return false;
  return true;
}

/** The triggers judged by their branch filters. */
const BRANCH_FILTERED_TRIGGERS = new Set(['push', 'workflow_run']);

function triggerLabel(name: string, filters: TriggerFilters): string {
  if (filters.branches !== undefined) return `${name} (branches: ${filters.branches.join(', ')})`;
  if (filters.branchesIgnore !== undefined) return `${name} (branches-ignore: ${filters.branchesIgnore.join(', ')})`;
  if (filters.tags !== undefined) return `${name} (tags only)`;
  if (filters.tagsIgnore !== undefined) return `${name} (tags-ignore: ${filters.tagsIgnore.join(', ')})`;
  if (BRANCH_FILTERED_TRIGGERS.has(name)) return `${name} (all branches)`;
  return name;
}

/**
 * The triggers that never run a factory branch's code: GitHub runs them on the last commit of the default branch, from a
 * workflow file on it, and their event names no factory commit nor pull request to check out, unlike `pull_request_target`
 * or `workflow_run`. `workflow_dispatch` runs on the ref a human picks (the App may not dispatch, ORC-443, unless its
 * installation went unread: `exposureReasons`, ORC-482); `workflow_call`
 * gets only the secrets its caller hands it, and doctor judges the caller. Every other trigger, an unknown one included,
 * counts as reaching the factory's branches (ORC-476).
 */
const DEFAULT_BRANCH_TRIGGERS = new Set([
  'schedule',
  'workflow_dispatch',
  'workflow_call',
  'issues',
  'label',
  'milestone',
  'discussion',
  'discussion_comment',
  'gollum',
  'page_build',
  'watch',
  'fork',
  'public',
  'branch_protection_rule',
  'delete',
]);

/** Why `workflow_dispatch` reaches the factory's branches when the installation's permissions went unread (ORC-482). */
const UNREAD_DISPATCH_REASON =
  "workflow_dispatch can run the CI on the factory's branches: the App's installation permissions were not read, so nothing shows " +
  'the App cannot dispatch it with Actions (write) (ORC-443)';
/** What to do about `UNREAD_DISPATCH_REASON`, a reason of its own. */
const MAKE_INSTALLATION_READABLE = 'make the installation readable (see its verdict) and run doctor again';

/**
 * Why a workflow with secrets can run on a factory branch; empty when no trigger does. `permissionsRead`: whether doctor read
 * the installation's permissions, which alone show the App cannot dispatch a workflow (ORC-482).
 */
function exposureReasons(triggers: Map<string, TriggerFilters>, factory: FactoryBranches, permissionsRead: boolean): string[] {
  const reasons: string[] = [];
  for (const [name, filters] of triggers) {
    if (name === 'workflow_dispatch' && !permissionsRead) {
      reasons.push(UNREAD_DISPATCH_REASON);
      continue;
    }
    if (DEFAULT_BRANCH_TRIGGERS.has(name)) continue;
    const filtered = BRANCH_FILTERED_TRIGGERS.has(name);
    if (filtered && !pushReachesFactory(filters, factory)) continue;
    reasons.push(`${filtered ? triggerLabel(name, filters) : name} can run the CI on the factory's branches`);
  }
  return reasons;
}

function protectedByEnvironment(jobId: string, workflow: ParsedWorkflow, environments: Map<string, EnvironmentProtection>): boolean {
  const name = workflow.jobEnvironments.get(jobId);
  return name !== undefined && environments.get(name)?.requiredReviewers === true;
}

function analyzeWorkflow(
  source: WorkflowSource,
  environments: Map<string, EnvironmentProtection>,
  factory: FactoryBranches,
  permissionsRead: boolean,
): WorkflowReport {
  const parsed = parseWorkflow(source.content);
  if (!parsed.ok) {
    return {
      path: source.path,
      triggers: [],
      secrets: false,
      githubToken: [],
      factoryBranches: false,
      environments: [],
      protected: false,
      verdict: 'refused',
      reasons: [parsed.reason],
    };
  }
  const workflow = parsed.workflow;
  const triggers = [...workflow.triggers].map(([name, filters]) => triggerLabel(name, filters));
  const environmentReport = workflow.environmentNames.map((name) => ({
    name,
    requiredReviewers: environments.get(name)?.requiredReviewers === true,
  }));
  const exposure = exposureReasons(workflow.triggers, factory, permissionsRead);
  const { sensitiveJobs } = workflow;
  const unprotectedJobs = sensitiveJobs.filter((jobId) => !protectedByEnvironment(jobId, workflow, environments));
  const what = [...(workflow.hasSecrets ? ['secrets'] : []), ...(workflow.tokenWrites.size > 0 ? ['a writable GITHUB_TOKEN'] : [])].join(' and ');

  const reasons: string[] = [];
  let verdict: WorkflowReport['verdict'] = 'accepted';
  if (!what) {
    reasons.push('no secret referenced, a read-only GITHUB_TOKEN');
  } else if (exposure.length === 0) {
    reasons.push(`${what} only on triggers that do not reach the factory's branches`);
  } else if (sensitiveJobs.length === 0) {
    reasons.push('workflow without jobs: no secret can be exposed');
  } else if (unprotectedJobs.length === 0) {
    reasons.push(`${what} limited to jobs under a protected environment (${[...new Set(workflow.environmentNames)].join(', ')})`);
  } else {
    verdict = 'refused';
    reasons.push(`${what} exposed on the factory's branches (${exposure.join('; ')}) without human approval`);
    const withoutEnvironment = unprotectedJobs.filter((jobId) => !workflow.jobEnvironments.has(jobId));
    const withUnprotectedEnvironment = unprotectedJobs.filter((jobId) => workflow.jobEnvironments.has(jobId));
    if (withoutEnvironment.length > 0) reasons.push(`job(s) without an environment: ${withoutEnvironment.join(', ')}`);
    if (withUnprotectedEnvironment.length > 0) reasons.push(`job(s) under an environment without required reviewers: ${withUnprotectedEnvironment.join(', ')}`);
    for (const name of workflow.environmentNames) {
      if (!environments.has(name)) reasons.push(`environment \`${name}\` not found in the GitHub API`);
    }
    if (!permissionsRead && workflow.triggers.has('workflow_dispatch')) reasons.push(MAKE_INSTALLATION_READABLE);
    if (unprotectedJobs.some((jobId) => workflow.tokenWrites.get(jobId) === REPOSITORY_DEFAULT)) {
      reasons.push("declare `permissions:` (read rights, such as `contents: read`) in the workflow or the job: the App cannot read the repository's default rights for the GITHUB_TOKEN");
    }
  }

  return {
    path: source.path,
    triggers,
    secrets: workflow.hasSecrets,
    githubToken: [...workflow.tokenWrites].map(([job, rights]) => ({ job, rights })),
    factoryBranches: exposure.length > 0,
    environments: environmentReport,
    protected: sensitiveJobs.length > 0 && unprotectedJobs.length === 0,
    verdict,
    reasons,
  };
}

export interface InstallationReport {
  /** As GitHub granted them to the installation, absent when it could not be read. */
  permissions?: Record<string, string>;
  /** `unchecked`: the call failed (network, authentication), said with a warning, never a refusal (ORC-439). */
  verdict: Verdict | 'unchecked';
  reasons: string[];
  warnings?: string[];
}

/**
 * A permission the App must not hold: where each of its kinds is set, and what it would let the daemon do. Forbidden at
 * any level, or, with `allowed`, above that level.
 */
interface Forbidden {
  name: string;
  settings: Record<string, string>;
  risk: string;
  allowed?: string;
}

const FORBIDDEN: Forbidden[] = [
  {
    name: 'Administration',
    settings: { administration: 'Repository permissions → Administration', organization_administration: 'Organization permissions → Administration' },
    risk: 'the daemon could edit or delete the rules that keep it from merging alone (ORC-439)',
  },
  { name: 'Workflows', settings: { workflows: 'Repository permissions → Workflows' }, risk: "the daemon could push a workflow that exposes the repository's secrets, after doctor read the workflows (ORC-441)" },
  {
    // `workflow_dispatch` is not among the triggers `exposureReasons` counts as reaching a factory branch, once the installation is read.
    name: 'Actions (write)',
    settings: { actions: 'Repository permissions → Actions' },
    risk: "the daemon could dispatch a workflow on a factory branch, running that branch's code with the workflow's secrets, and re-run, cancel or delete runs and their logs (ORC-443)",
    allowed: GITHUB_APP_PERMISSIONS.actions,
  },
];

const forbiddenNames = FORBIDDEN.map(({ name }) => name);
/** "Administration, Workflows or Actions (write)". */
const FORBIDDEN_NAMES = `${forbiddenNames.slice(0, -1).join(', ')} or ${forbiddenNames.at(-1)}`;
/** Every kind of every forbidden permission: refused apart, never also warned about. */
const FORBIDDEN_KINDS = new Set(FORBIDDEN.flatMap(({ settings }) => Object.keys(settings)));

const LEVELS = ['read', 'write', 'admin'];
const LEVEL_LABELS: Record<string, string> = { read: 'Read-only', write: 'Read and write' };
/** GitHub's label for a level, as the App's settings show it. */
const levelLabel = (level: string) => LEVEL_LABELS[level] ?? level;

/** Whether `level` is above `asked`; any level is above none, and an unknown level above every one. */
function above(level: string, asked: string | undefined): boolean {
  if (asked === undefined) return true;
  const rank = LEVELS.indexOf(level);
  return rank === -1 || rank > LEVELS.indexOf(asked);
}

/** The forbidden permissions the installation holds, each with the kinds it holds. */
const heldForbidden = (permissions: Record<string, string>) =>
  FORBIDDEN.map((forbidden) => ({
    ...forbidden,
    held: Object.keys(forbidden.settings).filter((permission) => permissions[permission] !== undefined && above(permissions[permission], forbidden.allowed)),
  })).filter((forbidden) => forbidden.held.length > 0);

/** What an installation may hold without a warning: the manifest's permissions, and those added by hand for the dashboard. */
const ACCEPTED_PERMISSIONS: Record<string, string> = { ...GITHUB_APP_PERMISSIONS, ...GITHUB_APP_OPTIONAL_PERMISSIONS };

/** The permissions above `ACCEPTED_PERMISSIONS`, but not forbidden, named in one warning with the level each goes back to (ORC-443). */
function excessWarning(permissions: Record<string, string>): string | undefined {
  const named = Object.entries(permissions)
    .map(([permission, level]) => ({ permission, level, asked: ACCEPTED_PERMISSIONS[permission] }))
    .filter(({ permission, level, asked }) => !FORBIDDEN_KINDS.has(permission) && above(level, asked))
    .map(({ permission, level, asked }) => `${permission} (${level}, ${asked === undefined ? 'not in the manifest: No access' : `the manifest asks ${levelLabel(asked)}`})`);
  if (named.length === 0) return undefined;
  return (
    `Warning: the App is installed with permissions the manifest does not ask for: ${named.join(', ')}. ` +
    "Each widens what the daemon can do with the App's token. In the App's settings (Permissions & events), set each to the level named " +
    '(docs/github-app-manifest.json) and save, then accept the change in the installation (Settings → Applications → Installed GitHub Apps → Configure).'
  );
}

/** Whether the App's installation holds none of `FORBIDDEN`, as GitHub granted it; a permission above the manifest warns. */
function judgeInstallation(permissions: Record<string, string>): InstallationReport {
  const warning = excessWarning(permissions);
  const warnings = warning === undefined ? {} : { warnings: [warning] };
  const held = heldForbidden(permissions);
  if (held.length === 0) return { permissions, verdict: 'accepted', reasons: [`installed without the ${FORBIDDEN_NAMES} permission`], ...warnings };
  return {
    permissions,
    verdict: 'refused',
    reasons: held.map(({ name, settings, risk, allowed, held: kinds }, i) => {
      // Forbidden at any level: removed; above a level: lowered to it.
      const [verb, target, check] =
        allowed === undefined ? ['Remove', 'No access', `${name} is no longer listed`] : ['Lower', levelLabel(allowed), `${kinds.join(' and ')} is ${levelLabel(allowed)}`];
      return (
        // Joined after one another: each after the first opens a sentence.
        `${i === 0 ? 'installed' : 'Installed'} with ${kinds.map((permission) => `${permission} (${permissions[permission]})`).join(' and ')}: ${risk}. ` +
        `${verb} it: in the App's settings (Settings → Developer settings → GitHub Apps → the App → Permissions & events), ` +
        `set ${kinds.map((permission) => settings[permission]).join(' and ')} to ${target} and save, then check in the installation ` +
        `(Settings → Applications → Installed GitHub Apps → Configure) that ${check} (docs/github-app-manifest.json).`
      );
    }),
    ...warnings,
  };
}

/**
 * An installation that could not be read. A failed call (network, authentication) is a warning, never the verdict; an answer
 * GitHub gave without readable permissions refuses, never taken for one without them (ORC-273).
 */
function unreadInstallation(error: unknown): InstallationReport {
  if (error instanceof UnreadableAnswerError) return { verdict: 'refused', reasons: [`Cannot read the installation's permissions: ${error.message}`] };
  return {
    verdict: 'unchecked',
    reasons: ['not checked, see the warning'],
    warnings: [
      `Warning: the App's installation permissions not read: ${errorMessage(error)}. ` +
        `Check by hand that the installation holds no ${FORBIDDEN_NAMES}, nor any permission above the manifest (docs/github-app-manifest.json) ` +
        '(Settings → Applications → Installed GitHub Apps → Configure).',
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const { repoPath, github, api, out } = options;
  // A workflow file an older factory read (ORC-388): named whatever the verdict, never read.
  const ignored = ignoredWorkflowFiles(repoPath);
  // Neither is part of the verdict: said whatever it is.
  const warnings = testCommandWarnings(options.commands);
  if (!options.json) for (const line of [...ignored.map(ignoredWorkflowWarning), ...warnings]) out(line);
  // Read beside the workflows; an unreadable protection is a refusal with its reason, the other verdicts still told.
  const protectionRead = api.branchProtection(github).then(judgeProtection, (error: unknown): BranchProtectionReport => ({
    verdict: 'refused',
    reasons: [`Cannot read the protection of the default branch: ${errorMessage(error)}`],
  }));
  const installationRead = api.installationPermissions(github).then(judgeInstallation, unreadInstallation);
  // Unreadable workflows or environments still tell the host's, the protection's and the installation's verdicts.
  const failure = async (message: string) =>
    doctorFailure(options, message, ignored, warnings, { host: options.host, branchProtection: await protectionRead, installation: await installationRead });
  let workflows: WorkflowSource[];
  try {
    workflows = await api.listWorkflows(github);
  } catch (error) {
    return failure(`Cannot read the workflows: ${errorMessage(error)}`);
  }
  let environments: EnvironmentProtection[] = [];
  if (workflows.length > 0) {
    try {
      environments = await api.listEnvironments(github);
    } catch (error) {
      return failure(`Cannot read the environments: ${errorMessage(error)}`);
    }
  }
  const protection = await protectionRead;
  const installation = await installationRead;
  const unchecked = installation.verdict === 'unchecked';
  const installationWarned = installation.warnings !== undefined;
  const { host } = options;
  const environmentMap = new Map(environments.map((environment) => [environment.name, environment] as const));
  const factory = factoryBranches(options.naming ?? DEFAULT_BRANCH_NAMING);
  const permissionsRead = installation.permissions !== undefined;
  const reports = workflows.map((workflow) => analyzeWorkflow(workflow, environmentMap, factory, permissionsRead));
  const refused = reports.filter((report) => report.verdict === 'refused').length;
  const branch = protection.branch ? ` ${protection.branch}` : '';
  const refusals = [
    ...(host.verdict === 'refused' ? ['the host cannot run a limited sandbox'] : []),
    // Unread, the protection is unknown: never told as absent.
    ...(protection.verdict === 'refused'
      ? [protection.branch === undefined ? "the default branch's protection cannot be read" : `the default branch${branch} is not protected`]
      : []),
    ...(installation.verdict === 'refused'
      ? [installation.permissions ? installedWith(installation.permissions) : "the GitHub App installation's permissions cannot be read"]
      : []),
    ...(refused > 0
      ? [
          `${refused} workflow(s) of ${reports.length} can expose secrets or a writable GITHUB_TOKEN to the factory's branches` +
            (!permissionsRead && reports.some((report) => report.reasons.includes(MAKE_INSTALLATION_READABLE))
              ? ' (workflow_dispatch counted as reaching them: the installation could not be read)'
              : ''),
        ]
      : []),
  ];
  const accepted = refusals.length === 0;

  if (options.json) {
    out(JSON.stringify({ repoPath, accepted, host, branchProtection: protection, installation, workflows: reports, ...notes(ignored, warnings), ...instanceReportOf(options) }, null, 2));
  } else {
    for (const line of verdictLines({ host, branchProtection: protection, installation })) out(line);
    if (reports.length === 0) out('No GitHub Actions workflow found.');
    else {
      out(`GitHub Actions workflows: ${reports.length}`);
      out('');
      for (const report of reports) {
        out(report.path);
        out(`  triggers: ${report.triggers.length > 0 ? report.triggers.join(', ') : 'unknown'}`);
        out(`  factory branches: ${report.factoryBranches ? 'reached' : 'not reached'}`);
        out(`  secrets: ${report.secrets ? 'yes' : 'no'}`);
        out(`  GITHUB_TOKEN: ${report.githubToken.length > 0 ? report.githubToken.map((token) => `${token.job} (${token.rights})`).join(', ') : 'read only'}`);
        out(
          `  environments: ${
            report.environments.length > 0
              ? report.environments
                  .map((environment) => `${environment.name} (${environment.requiredReviewers ? 'required reviewers' : 'without required reviewers'})`)
                  .join(', ')
              : 'none'
          }`,
        );
        out(`  protected environment: ${report.protected ? 'yes' : 'no'}`);
        out(`  verdict: ${report.verdict} — ${report.reasons.join(' ')}`);
        out('');
      }
    }
    out(
      accepted
        ? `Result: accepted — a cgroup v2 host, a protected default branch, ${unchecked ? '' : `an App installed without ${FORBIDDEN_NAMES}, `}and no workflow can expose a secret or a writable GITHUB_TOKEN to the factory's branches. ` +
            `Check by hand what the warning under the default branch names${installationWarned ? ', and act on the one under the GitHub App installation' : ''}.`
        : `Result: refused — ${refusals.join('; ')}.`,
    );
  }
  return accepted ? 0 : 1;
}

/** The refusal of an installation holding forbidden permissions, named. */
function installedWith(permissions: Record<string, string>): string {
  const names = heldForbidden(permissions).map(({ name }) => name);
  return `the GitHub App is installed with the ${names.join(' and ')} permission${names.length > 1 ? 's' : ''}`;
}

/** The ignored workflow files and the warnings in the JSON report, each only when there is one. */
const notes = (ignored: string[], warnings: string[]) => ({ ...(ignored.length ? { ignored } : {}), ...(warnings.length ? { warnings } : {}) });

interface Verdicts {
  host: HostReport;
  branchProtection: BranchProtectionReport;
  installation: InstallationReport;
}

/** The host's, the default branch's and the App installation's verdicts, in text, then a blank line. */
function verdictLines({ host, branchProtection: protection, installation }: Verdicts): string[] {
  const branch = protection.branch ? ` ${protection.branch}` : '';
  return [
    `Host: ${host.verdict} — ${host.reasons.join(' ')}`,
    `Default branch${branch}: ${protection.verdict} — ${protection.reasons.join(' ')}`,
    ...(protection.warnings ?? []).map((warning) => `  ${warning}`),
    `GitHub App installation: ${installation.verdict} — ${installation.reasons.join(' ')}`,
    ...(installation.warnings ?? []).map((warning) => `  ${warning}`),
    '',
  ];
}

function doctorFailure(
  options: Pick<DoctorOptions, 'repoPath' | 'out' | 'json'> & InstanceReport,
  message: string,
  ignored: string[] = [],
  warnings: string[] = [],
  verdicts?: Verdicts,
): number {
  if (options.json) {
    options.out(JSON.stringify({ repoPath: options.repoPath, accepted: false, error: message, ...verdicts, ...notes(ignored, warnings), ...instanceReportOf(options) }, null, 2));
  } else {
    if (verdicts) for (const line of verdictLines(verdicts)) options.out(line);
    options.out(message);
  }
  return 1;
}

export interface DoctorCommandOptions {
  repoPath: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  out?: (line: string) => void;
  http?: HttpClient;
  exec?: Exec;
  now?: () => number;
  /** The statuses of a Linear team (ORC-382); the daemon's Linear connection by default (`cliLinearTracker`). */
  teamStatuses?: (teamKey: string) => Promise<string[]>;
}

/**
 * The statuses factory.yml names that the Linear team of each project lacks (ORC-382): a warning, never the verdict. The daemon
 * cannot refuse them at load, before it reads the team: `doctor` reads it, through the daemon's Linear connection.
 */
async function statusWarnings(projects: readonly Pick<ProjectConfig, 'id' | 'linearTeamKey' | 'preset'>[], o: { home: string; env: NodeJS.ProcessEnv; states: Workflow['states']; read?: ((teamKey: string) => Promise<string[]>) | undefined }): Promise<string[]> {
  const mine = projects.filter((p) => !isFantome(p));
  if (!mine.length) return [];
  let teamStatuses = o.read;
  if (!teamStatuses) {
    let tracker;
    try {
      // Linear's secrets read apart from the GitHub App's: one that cannot be read leaves the other checks as they were.
      tracker = cliLinearTracker(o.home, (await loadSealedFactoryYml(o.home, o.env, { only: LINEAR_SECRETS })).yml);
    } catch (error) {
      return [`Linear statuses not checked: ${errorMessage(error)}`];
    }
    if (typeof tracker === 'string') return [`Linear statuses not checked: ${tracker}`];
    teamStatuses = (teamKey) => tracker.teamStatuses(teamKey);
  }
  const lines: string[] = [];
  for (const p of mine) {
    try {
      const warning = missingStatusWarning({ id: p.id, teamKey: p.linearTeamKey }, o.states, await teamStatuses(p.linearTeamKey));
      if (warning) lines.push(warning);
    } catch (error) {
      lines.push(`Linear statuses of ${p.id} not checked: ${errorMessage(error)}`);
    }
  }
  return lines;
}

/**
 * CLI adapter: loads the instance, requires the GitHub App, asks the engine for the host's
 * cgroups, reads the repository's branch naming (ORC-283) and commands (ORC-412) on its default branch as the clone last
 * fetched it, then runs the same analysis as `runDoctor`.
 */
export async function runDoctorCommand(options: DoctorCommandOptions): Promise<number> {
  const out = options.out ?? ((line) => console.log(line));
  // Of the instance, not of the repository: said first, whatever stops the check after.
  const env = options.env ?? process.env;
  const visualProof = await browserImage(env, options.exec);
  if (!options.json) out(visualProofLine(visualProof));
  // Where each server secret is kept and its rotation (ORC-398), without reading a value: a warning, never the verdict.
  let serverSecrets: SecretReport[] | undefined;
  try {
    serverSecrets = await serverSecretReport(options.home, env, options.now ? { now: options.now() } : {});
  } catch {
    // An invalid factory.yml: said just below, by the load the check needs.
  }
  if (!options.json && serverSecrets) for (const line of serverSecretLines(serverSecrets)) out(line);
  let githubApp;
  let validators: string[] = [];
  let startWarnings: string[] = [];
  // What every failure from here reports, the warnings said so far included: `--json` keeps its form whatever stops the check (ORC-449).
  const reportOf = () => ({ repoPath: options.repoPath, out, visualProof, validatorWarnings: validators, startWarnings, ...(serverSecrets ? { serverSecrets } : {}), ...(options.json ? { json: true } : {}) });
  let projects;
  let states;
  let repos;
  try {
    const { yml, sealed } = await loadSealedFactoryYml(options.home, env, { only: GITHUB_APP_SECRETS });
    // Each refusal of the daemon's start, in its order and by the function it calls, with its message (ORC-448): the exposed
    // host's sign-in and secrets_key, the Smee relay (ORC-446). Its warnings are said here: the relay's, an old SQLite file's (ORC-463).
    const instance = effectiveInstance(yml);
    startWarnings = startRefusals(options.home, instance, yml, env).warnings;
    if (!options.json) for (const line of startWarnings) out(line);
    projects = instance.projects.filter((p) => samePath(p.repoPath, options.repoPath));
    repos = yml?.repos;
    // The project of this repository whose spec gate no validator can pass (ORC-421): a warning, never the verdict.
    validators = validatorWarnings(projects);
    if (!options.json) for (const line of validators) out(line);
    githubApp = resolveGithubApp(instance, env);
    // factory.yml's step settings and statuses (ORC-382) the daemon refuses at load.
    states = defaultWorkflow(stepSettings(yml)).states;
    // The Claude token (ORC-337). The active account's of a source other than env is unread here: the start, which reads it, never
    // falls back to CLAUDE_CODE_OAUTH_TOKEN then, so neither is checked.
    const unread = yml?.claude && !activeClaudeAccount(yml)?.token;
    if (!unread) claudeAccountReader(options.home, env, undefined, sealed)();
  } catch (error) {
    // Through doctorFailure (ORC-449): `--json` stays JSON.
    return doctorFailure(reportOf(), errorMessage(error));
  }
  // Its Linear team's statuses against factory.yml's (ORC-382): a warning, never the verdict.
  if (!options.json) for (const line of await statusWarnings(projects, { home: options.home, env, states, read: options.teamStatuses })) out(line);
  const report = reportOf();
  if (!githubApp) {
    return doctorFailure(
      report,
      'GitHub App not configured: `factory doctor` needs github.app_id and github.private_key in factory.yml (or GH_APP_ID and GH_APP_KEY) ' +
        'to read the workflows and the environments.',
    );
  }
  // The repository on GitHub as the daemon resolves it at its start, refused alike when its origin is not on GitHub (ORC-478).
  let github: string;
  try {
    ({ github } = await projectGithub({ repoPath: options.repoPath, teamKey: projects[0]?.linearTeamKey, repos, ...(options.exec ? { exec: options.exec } : {}) }));
  } catch (error) {
    return doctorFailure(report, errorMessage(error));
  }
  const api = new GitHubAppApi({
    ...githubApp,
    ...(options.http ? { http: options.http } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let config: RepoConfig;
  try {
    // The checkout it runs in stands for the daemon's mirror (ORC-479): its `origin/HEAD`, never fetched.
    config = await makeRepoConfig(options.exec ? { exec: options.exec } : {})({ mirror: options.repoPath }, { fetch: false });
  } catch (error) {
    return doctorFailure(report, `Cannot read the repository's branch naming: ${errorMessage(error)}`);
  }
  return runDoctor({ ...report, github, api, host: await checkHost(env, options.exec), naming: config.branches, commands: config.commands });
}
