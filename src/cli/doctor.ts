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

const FACTORY_BRANCH = /^factory\//;
/** Representative factory branch names: enough to decide whether a filter can reach the factory space. */
const FACTORY_PROBES = [
  'factory/x',
  'factory/REL-1',
  'factory/0',
  'factory/a-b',
  'factory/a-foo',
  'factory/foo-bar',
];

export interface DoctorApi {
  listWorkflows(repoPath: string): Promise<WorkflowSource[]>;
  listEnvironments(repoPath: string): Promise<EnvironmentProtection[]>;
}

export interface DoctorOptions {
  repoPath: string;
  api: DoctorApi;
  out: (line: string) => void;
  json?: boolean;
}

export interface WorkflowReport {
  path: string;
  triggers: string[];
  secrets: boolean;
  environments: { name: string; requiredReviewers: boolean }[];
  /** True when every job that can see secrets is attached to a protected environment. */
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

/** Detects `secrets.X`, `secrets[X]`, and any expression that mentions the `secrets` context. */
function textReferencesSecrets(text: string): boolean {
  if (/\bsecrets\s*[.[]/i.test(text)) return true;
  for (const match of text.matchAll(EXPRESSION)) {
    if (/\bsecrets\b/i.test(match[1] ?? '')) return true;
  }
  return false;
}

/** Scans every value and key of a subtree; a `secrets:` key means indirect secrets (reusable workflow). */
function scanForSecrets(value: unknown): boolean {
  if (typeof value === 'string') return textReferencesSecrets(value);
  if (Array.isArray(value)) return value.some((item) => scanForSecrets(item));
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'secrets' || textReferencesSecrets(key)) return true;
    if (scanForSecrets(child)) return true;
  }
  return false;
}

/** Same scan, but skips the `jobs` subtree: workflow-level secrets are inherited by every job. */
function scanOutsideJobs(root: Record<string, unknown>): boolean {
  for (const [key, child] of Object.entries(root)) {
    if (key === 'jobs') continue;
    if (key === 'secrets' || textReferencesSecrets(key)) return true;
    if (scanForSecrets(child)) return true;
  }
  return false;
}

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

  const jobs = new Map<string, Record<string, unknown>>();
  const jobEnvironments = new Map<string, string>();
  const environmentNames: string[] = [];
  for (const [jobId, rawJob] of Object.entries(rawJobs)) {
    if (!isRecord(rawJob)) return { ok: false, reason: `job \`${jobId}\` invalide` };
    jobs.set(jobId, rawJob);
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

  const rootSecrets = scanOutsideJobs(root);
  const secretJobs: string[] = [];
  for (const [jobId, job] of jobs) {
    if (rootSecrets || scanForSecrets(job)) secretJobs.push(jobId);
  }

  return {
    ok: true,
    workflow: {
      triggers: parsedOn,
      jobEnvironments,
      environmentNames,
      hasSecrets: rootSecrets || secretJobs.length > 0,
      secretJobs,
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

function canMatchFactory(pattern: string): boolean {
  if (FACTORY_BRANCH.test(pattern)) return true;
  try {
    const regexp = globToRegExp(pattern);
    return FACTORY_PROBES.some((probe) => regexp.test(probe));
  } catch {
    // Unreadable glob: fail closed, the workflow may reach a factory branch.
    return true;
  }
}

/** `factory/**`, `factory/*` and `**` exclude every factory branch when used as a negation. */
function coversAllFactoryBranches(pattern: string): boolean {
  return pattern === '**' || pattern === 'factory/**' || pattern === 'factory/*';
}

function branchesReachFactory(patterns: string[]): boolean {
  // GitHub applies patterns in order: a later negative can exclude a positive,
  // and a later positive can re-include a branch. Only positives after the last
  // "exclude every factory branch" pattern can bring factory branches back.
  let lastCover = -1;
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index]!;
    if (pattern.startsWith('!') && coversAllFactoryBranches(pattern.slice(1))) lastCover = index;
  }
  if (lastCover === -1) {
    const positives = patterns.filter((pattern) => !pattern.startsWith('!'));
    return positives.length === 0 || positives.some(canMatchFactory);
  }
  for (let index = lastCover + 1; index < patterns.length; index++) {
    const pattern = patterns[index]!;
    if (!pattern.startsWith('!') && canMatchFactory(pattern)) return true;
  }
  return false;
}

function branchesIgnoreReachFactory(patterns: string[]): boolean {
  let lastCover = -1;
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index]!;
    if (!pattern.startsWith('!') && coversAllFactoryBranches(pattern)) lastCover = index;
  }
  if (lastCover === -1) return true;
  for (let index = lastCover + 1; index < patterns.length; index++) {
    const pattern = patterns[index]!;
    if (pattern.startsWith('!') && canMatchFactory(pattern.slice(1))) return true;
  }
  return false;
}

/** Branch push: an absent filter means all branches; a tags-only filter means no branch push. */
function pushReachesFactory(filters: TriggerFilters): boolean {
  if (filters.branches !== undefined) return branchesReachFactory(filters.branches);
  if (filters.branchesIgnore !== undefined) return branchesIgnoreReachFactory(filters.branchesIgnore);
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
function exposureReasons(triggers: Map<string, TriggerFilters>): string[] {
  const reasons: string[] = [];
  for (const [name, filters] of triggers) {
    if (name === 'pull_request' || name === 'pull_request_target') {
      reasons.push(`${name} can run the CI on a \`factory/*\` branch`);
    } else if ((name === 'push' || name === 'workflow_run') && pushReachesFactory(filters)) {
      reasons.push(`${triggerLabel(name, filters)} can run the CI on a \`factory/*\` branch`);
    }
  }
  return reasons;
}

function protectedByEnvironment(jobId: string, workflow: ParsedWorkflow, environments: Map<string, EnvironmentProtection>): boolean {
  const name = workflow.jobEnvironments.get(jobId);
  return name !== undefined && environments.get(name)?.requiredReviewers === true;
}

function analyzeWorkflow(source: WorkflowSource, environments: Map<string, EnvironmentProtection>): WorkflowReport {
  const parsed = parseWorkflow(source.content);
  if (!parsed.ok) {
    return {
      path: source.path,
      triggers: [],
      secrets: false,
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
  const exposure = exposureReasons(workflow.triggers);
  const unprotectedJobs = workflow.secretJobs.filter((jobId) => !protectedByEnvironment(jobId, workflow, environments));
  const protectedWorkflow =
    workflow.hasSecrets &&
    workflow.secretJobs.length > 0 &&
    workflow.secretJobs.every((jobId) => protectedByEnvironment(jobId, workflow, environments));

  const reasons: string[] = [];
  let verdict: WorkflowReport['verdict'] = 'accepted';
  if (!workflow.hasSecrets) {
    reasons.push('no secret referenced');
  } else if (exposure.length === 0) {
    reasons.push("secrets referenced only on triggers that do not reach the factory's branches");
  } else if (workflow.secretJobs.length === 0) {
    reasons.push('workflow without jobs: no secret can be exposed');
  } else if (unprotectedJobs.length === 0) {
    reasons.push(`secrets limited to jobs under a protected environment (${[...new Set(workflow.environmentNames)].join(', ')})`);
  } else {
    verdict = 'refused';
    reasons.push(`secrets exposed on the factory's branches (${exposure.join('; ')}) without human approval`);
    const withoutEnvironment = unprotectedJobs.filter((jobId) => !workflow.jobEnvironments.has(jobId));
    const withUnprotectedEnvironment = unprotectedJobs.filter((jobId) => workflow.jobEnvironments.has(jobId));
    if (withoutEnvironment.length > 0) reasons.push(`job(s) without an environment: ${withoutEnvironment.join(', ')}`);
    if (withUnprotectedEnvironment.length > 0) reasons.push(`job(s) under an environment without required reviewers: ${withUnprotectedEnvironment.join(', ')}`);
    for (const name of workflow.environmentNames) {
      if (!environments.has(name)) reasons.push(`environment \`${name}\` not found in the GitHub API`);
    }
  }

  return {
    path: source.path,
    triggers,
    secrets: workflow.hasSecrets,
    environments: environmentReport,
    protected: protectedWorkflow,
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
  if (workflows.length > 0) {
    try {
      environments = await api.listEnvironments(repoPath);
    } catch (error) {
      return doctorFailure(options, `Cannot read the environments: ${errorMessage(error)}`);
    }
  }
  const environmentMap = new Map(environments.map((environment) => [environment.name, environment] as const));
  const reports = workflows.map((workflow) => analyzeWorkflow(workflow, environmentMap));
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
        out(`  secrets: ${report.secrets ? 'yes' : 'no'}`);
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
        ? "Result: accepted — no workflow can expose a secret to the factory's branches."
        : `Result: refused — ${refused} workflow(s) of ${reports.length} can expose secrets to the factory's branches.`,
    );
  }
  return accepted ? 0 : 1;
}

function doctorFailure(options: DoctorOptions, message: string): number {
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
 * CLI adapter: loads the instance, requires the GitHub App (no `gh` fallback for this check),
 * then runs the same analysis as `runDoctor`.
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
  return runDoctor({
    repoPath: options.repoPath,
    api,
    out,
    ...(options.json ? { json: true } : {}),
  });
}
