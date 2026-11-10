import { parseAllDocuments } from 'yaml';
import type { Exec } from '../adapters/exec.js';
import {
  GitHubAppApi,
  type EnvironmentProtection,
  type WorkflowSource,
} from '../adapters/forge/github-app-api.js';
import type { HttpClient } from '../adapters/forge/github-app.js';
import { resolveGithubApp } from '../config/github-app.js';
import { loadFactoryYml } from '../config/factory-yml.js';
import { effectiveInstance } from '../config/instance.js';
import { makeRepoConfig } from '../app/repo-variables.js';
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

export interface DoctorApi {
  listWorkflows(repoPath: string): Promise<WorkflowSource[]>;
  listEnvironments(repoPath: string): Promise<EnvironmentProtection[]>;
  /** The login GitHub gives the factory's App as an actor, `<slug>[bot]` (ORC-283): what a workflow's `if:` keeps out. */
  appLogin(): Promise<string>;
}

export interface DoctorOptions {
  repoPath: string;
  api: DoctorApi;
  out: (line: string) => void;
  json?: boolean;
  /** The repository's branch naming (`.factory/config.yml`, ORC-283): the team's convention without it. */
  naming?: BranchNaming;
}

export interface WorkflowReport {
  path: string;
  triggers: string[];
  secrets: boolean;
  /** The jobs whose GITHUB_TOKEN can write (ORC-353), with their rights: the token is a secret by what it can do. */
  githubToken: { job: string; rights: string }[];
  /** Whether a trigger can run the workflow on a branch the factory names (ORC-353). */
  factoryBranches: boolean;
  environments: { name: string; requiredReviewers: boolean }[];
  /** The jobs whose `if:` keeps the factory's App out (ORC-283): `github.actor != '<app>[bot]'`, joined to the rest by `&&` only. */
  actorExcluded: string[];
  /** True when every job that can see a secret or a writable GITHUB_TOKEN is attached to a protected environment or keeps the App out. */
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
  /** Each job's `if:`, as the YAML gives it. */
  jobConditions: Map<string, unknown>;
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
    const filters = parseTriggerFilters(rawFilters);
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
  const jobConditions = new Map<string, unknown>();
  const environmentNames: string[] = [];
  const tokenWrites = new Map<string, string>();
  for (const [jobId, rawJob] of Object.entries(rawJobs)) {
    if (!isRecord(rawJob)) return { ok: false, reason: `job \`${jobId}\` invalide` };
    jobs.set(jobId, rawJob);
    if (rawJob['if'] !== undefined) jobConditions.set(jobId, rawJob['if']);
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
      jobConditions,
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

/**
 * Whether a filter lets the workflow run on `branch`: GitHub reads its patterns in order, the last that matches wins.
 * `ignore`: a `branches-ignore`, where a pattern leaves a branch out and a `!` brings it back. `runs`: before the first
 * pattern. A glob doctor cannot read counts when it would let the branch run, never when it would leave it out: fail closed.
 */
function runsOn(patterns: readonly string[], branch: string, ignore: boolean, runs: boolean): boolean {
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const lets = negated === ignore;
    let matches: boolean;
    try {
      matches = globToRegExp(negated ? pattern.slice(1) : pattern).test(branch);
    } catch {
      matches = lets;
    }
    if (matches) runs = lets;
  }
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
  if (factory.probes.some((probe) => runsOn(patterns, probe, ignore, ignore))) return true;
  return patterns.some((pattern, index) => {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    const space = negated === ignore ? factory.spaces.find((s) => glob.startsWith(s)) : undefined;
    const rest = patterns.slice(index + 1);
    return space !== undefined && factory.probes.some((probe) => probe.startsWith(space) && runsOn(rest, probe, ignore, true));
  });
}

/** Branch push: an absent filter means all branches; a tags-only filter means no branch push. */
function pushReachesFactory(filters: TriggerFilters, factory: FactoryBranches): boolean {
  if (filters.branches !== undefined) return filterReachesFactory(filters.branches, factory, false);
  if (filters.branchesIgnore !== undefined) return filterReachesFactory(filters.branchesIgnore, factory, true);
  if (filters.tags !== undefined || filters.tagsIgnore !== undefined) return false;
  return true;
}

function triggerLabel(name: string, filters: TriggerFilters): string {
  if (filters.branches !== undefined) return `${name} (branches: ${filters.branches.join(', ')})`;
  if (filters.branchesIgnore !== undefined) return `${name} (branches-ignore: ${filters.branchesIgnore.join(', ')})`;
  if (filters.tags !== undefined) return `${name} (tags only)`;
  if (filters.tagsIgnore !== undefined) return `${name} (tags-ignore: ${filters.tagsIgnore.join(', ')})`;
  if (name === 'push' || name === 'workflow_run') return `${name} (all branches)`;
  return name;
}

/** Why a workflow with secrets can run on a factory branch; empty when no trigger does. */
function exposureReasons(triggers: Map<string, TriggerFilters>, factory: FactoryBranches): string[] {
  const reasons: string[] = [];
  for (const [name, filters] of triggers) {
    if (name === 'pull_request' || name === 'pull_request_target') {
      reasons.push(`${name} can run the CI on the factory's branches`);
    } else if ((name === 'push' || name === 'workflow_run') && pushReachesFactory(filters, factory)) {
      reasons.push(`${triggerLabel(name, filters)} can run the CI on the factory's branches`);
    }
  }
  return reasons;
}

function protectedByEnvironment(jobId: string, workflow: ParsedWorkflow, environments: Map<string, EnvironmentProtection>): boolean {
  const name = workflow.jobEnvironments.get(jobId);
  return name !== undefined && environments.get(name)?.requiredReviewers === true;
}

/** `expression` cut at `separator` where it stands outside quotes and parentheses. */
function splitTopLevel(expression: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]!;
    if (char === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && expression.startsWith(separator, i)) {
      parts.push(expression.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((part) => part.trim());
}

/** A term without the parentheses that wrap it whole: `((a))` is `a`; `(a) == (b)`, whose first one closes early, stays. */
function unwrap(term: string): string {
  while (term.startsWith('(') && term.endsWith(')')) {
    const inner = term.slice(1, -1);
    let depth = 0;
    for (const char of inner) {
      if (char === '(') depth++;
      else if (char === ')' && --depth < 0) return term;
    }
    term = inner.trim();
  }
  return term;
}

const ACTOR_EXCLUDED = [/^github\.actor\s*!=\s*'([^']*)'$/, /^'([^']*)'\s*!=\s*github\.actor$/];

/**
 * Whether a job's `if:` keeps the factory's App out (ORC-283): one of its terms joined by `&&` alone, at the top, is
 * `github.actor != '<login>'` (GitHub compares strings without case). Anything it cannot read so, a `||` at the top, a
 * negation, another context, an expression beside text, is no exclusion: fail closed.
 */
function excludesActor(condition: unknown, login: string): boolean {
  if (typeof condition !== 'string') return false;
  let expression = condition.trim();
  const inline = [...expression.matchAll(EXPRESSION)];
  if (inline.length > 1 || (inline.length === 1 && inline[0]![0] !== expression)) return false;
  if (inline.length === 1) expression = (inline[0]![1] ?? '').trim();
  if (splitTopLevel(expression, '||').length > 1) return false;
  return splitTopLevel(expression, '&&').some((term) => {
    const read = unwrap(term);
    return ACTOR_EXCLUDED.some((form) => form.exec(read)?.[1]?.toLowerCase() === login.toLowerCase());
  });
}

function analyzeWorkflow(source: WorkflowSource, environments: Map<string, EnvironmentProtection>, factory: FactoryBranches, login: string): WorkflowReport {
  const parsed = parseWorkflow(source.content);
  if (!parsed.ok) {
    return {
      path: source.path,
      triggers: [],
      secrets: false,
      githubToken: [],
      factoryBranches: false,
      environments: [],
      actorExcluded: [],
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
  const exposure = exposureReasons(workflow.triggers, factory);
  const { sensitiveJobs } = workflow;
  const actorExcluded = [...workflow.jobConditions].filter(([, condition]) => excludesActor(condition, login)).map(([jobId]) => jobId);
  const byEnvironment = sensitiveJobs.filter((jobId) => protectedByEnvironment(jobId, workflow, environments));
  const unprotectedJobs = sensitiveJobs.filter((jobId) => !byEnvironment.includes(jobId) && !actorExcluded.includes(jobId));
  const exclusion = `\`if: github.actor != '${login}'\``;
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
    const how = [
      ...(byEnvironment.length ? [`under a protected environment (${[...new Set(byEnvironment.map((jobId) => workflow.jobEnvironments.get(jobId)!))].join(', ')})`] : []),
      ...(sensitiveJobs.some((jobId) => !byEnvironment.includes(jobId)) ? [`that exclude the factory's App (${exclusion})`] : []),
    ];
    reasons.push(`${what} limited to jobs ${how.join(' or ')}`);
  } else {
    verdict = 'refused';
    reasons.push(`${what} exposed on the factory's branches (${exposure.join('; ')}) without human approval`);
    reasons.push(`attach each of these jobs to an environment with required reviewers, or keep the factory's App out of it with ${exclusion} on the job`);
    const withoutEnvironment = unprotectedJobs.filter((jobId) => !workflow.jobEnvironments.has(jobId));
    const withUnprotectedEnvironment = unprotectedJobs.filter((jobId) => workflow.jobEnvironments.has(jobId));
    if (withoutEnvironment.length > 0) reasons.push(`job(s) without an environment: ${withoutEnvironment.join(', ')}`);
    if (withUnprotectedEnvironment.length > 0) reasons.push(`job(s) under an environment without required reviewers: ${withUnprotectedEnvironment.join(', ')}`);
    for (const name of workflow.environmentNames) {
      if (!environments.has(name)) reasons.push(`environment \`${name}\` not found in the GitHub API`);
    }
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
    actorExcluded,
    protected: sensitiveJobs.length > 0 && unprotectedJobs.length === 0,
    verdict,
    reasons,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const { repoPath, api, out } = options;
  let workflows: WorkflowSource[];
  try {
    workflows = await api.listWorkflows(repoPath);
  } catch (error) {
    return doctorFailure(options, `Cannot read the workflows: ${errorMessage(error)}`);
  }
  let environments: EnvironmentProtection[] = [];
  let login = '';
  if (workflows.length > 0) {
    try {
      environments = await api.listEnvironments(repoPath);
    } catch (error) {
      return doctorFailure(options, `Cannot read the environments: ${errorMessage(error)}`);
    }
    try {
      login = await api.appLogin();
    } catch (error) {
      return doctorFailure(options, `Cannot read the GitHub App's login: ${errorMessage(error)}`);
    }
  }
  const environmentMap = new Map(environments.map((environment) => [environment.name, environment] as const));
  const factory = factoryBranches(options.naming ?? DEFAULT_BRANCH_NAMING);
  const reports = workflows.map((workflow) => analyzeWorkflow(workflow, environmentMap, factory, login));
  const accepted = reports.every((report) => report.verdict === 'accepted');
  const refused = reports.filter((report) => report.verdict === 'refused').length;

  if (options.json) {
    out(JSON.stringify({ repoPath, accepted, workflows: reports }, null, 2));
  } else {
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
        out(`  factory's App excluded: ${report.actorExcluded.length > 0 ? report.actorExcluded.join(', ') : 'no job'}`);
        out(`  protected: ${report.protected ? 'yes' : 'no'}`);
        out(`  verdict: ${report.verdict} — ${report.reasons.join(' ')}`);
        out('');
      }
    }
    out(
      accepted
        ? "Result: accepted — no workflow can expose a secret or a writable GITHUB_TOKEN to the factory's branches."
        : `Result: refused — ${refused} workflow(s) of ${reports.length} can expose secrets or a writable GITHUB_TOKEN to the factory's branches.`,
    );
  }
  return accepted ? 0 : 1;
}

function doctorFailure(options: Pick<DoctorOptions, 'repoPath' | 'out' | 'json'>, message: string): number {
  if (options.json) {
    options.out(JSON.stringify({ repoPath: options.repoPath, accepted: false, error: message }, null, 2));
  } else {
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
}

/**
 * CLI adapter: loads the instance, requires the GitHub App (no `gh` fallback for this check), reads the repository's
 * branch naming on its default branch as the clone last fetched it (ORC-283), then runs the same analysis as `runDoctor`.
 */
export async function runDoctorCommand(options: DoctorCommandOptions): Promise<number> {
  const out = options.out ?? ((line) => console.log(line));
  let githubApp;
  try {
    githubApp = resolveGithubApp(effectiveInstance(options.home, loadFactoryYml(options.home, options.env)), options.env);
  } catch (error) {
    out(errorMessage(error));
    return 1;
  }
  if (!githubApp) {
    out(
      'GitHub App not configured: `factory doctor` needs github.appId and github.privateKey (or GH_APP_ID and GH_APP_KEY) ' +
        'to read the workflows and the environments. No `gh` fallback for this check.',
    );
    return 1;
  }
  const api = new GitHubAppApi({
    ...githubApp,
    ...(options.http ? { http: options.http } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let naming: BranchNaming;
  try {
    naming = (await makeRepoConfig(options.exec ? { exec: options.exec } : {})({ repoPath: options.repoPath }, { fetch: false })).branches;
  } catch (error) {
    return doctorFailure({ repoPath: options.repoPath, out, ...(options.json ? { json: true } : {}) }, `Cannot read the repository's branch naming: ${errorMessage(error)}`);
  }
  return runDoctor({
    repoPath: options.repoPath,
    api,
    out,
    naming,
    ...(options.json ? { json: true } : {}),
  });
}
