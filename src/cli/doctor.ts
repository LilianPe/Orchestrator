import { parseAllDocuments } from 'yaml';
import type { Exec } from '../adapters/exec.js';
import {
  GitHubAppApi,
  type EnvironmentProtection,
  type WorkflowSource,
} from '../adapters/forge/github-app-api.js';
import type { HttpClient } from '../adapters/forge/github-app.js';
import { resolveGithubApp } from '../config/github-app.js';
import { loadInstance } from '../config/instance.js';

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
  verdict: 'accepté' | 'refusé';
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
    if (!name || name.includes('${{')) return 'déclencheur `on` dynamique ou vide';
    return new Map([[name, {}]]);
  }
  if (Array.isArray(value)) {
    const triggers = new Map<string, TriggerFilters>();
    for (const item of value) {
      if (typeof item !== 'string') return 'liste de déclencheurs `on` ambiguë';
      const name = item.trim();
      if (!name || name.includes('${{')) return 'déclencheur `on` dynamique ou vide';
      triggers.set(name, {});
    }
    return triggers;
  }
  if (!isRecord(value)) return 'déclencheur `on` ambigu';
  const triggers = new Map<string, TriggerFilters>();
  for (const [rawName, rawFilters] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name || name.includes('${{')) return 'déclencheur `on` dynamique ou vide';
    const filters = parseTriggerFilters(rawFilters);
    if (!filters) return `filtres ambigus pour le déclencheur \`${name}\``;
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
    return { ok: false, reason: 'YAML illisible (le parseur a refusé le fichier)' };
  }
  if (documents.length !== 1) return { ok: false, reason: 'YAML ambigu : un workflow doit contenir un seul document' };
  const document = documents[0]!;
  if (document.errors.length > 0) return { ok: false, reason: 'YAML invalide (erreur de syntaxe)' };
  if (document.warnings.length > 0) return { ok: false, reason: 'YAML ambigu (avertissement du parseur)' };

  let root: unknown;
  try {
    root = document.toJS();
  } catch {
    return { ok: false, reason: 'YAML ambigu (structure impossible à lire)' };
  }
  if (!isRecord(root)) return { ok: false, reason: 'workflow vide ou racine YAML invalide' };

  if (root['on'] === undefined) return { ok: false, reason: 'déclencheur `on` absent : impossible de savoir quand la CI tourne' };
  const parsedOn = parseOn(root['on']);
  if (typeof parsedOn === 'string') return { ok: false, reason: parsedOn };

  const rawJobs = root['jobs'];
  if (!isRecord(rawJobs)) return { ok: false, reason: 'section `jobs` absente ou invalide' };

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
      if (!name || name.includes('${{')) return { ok: false, reason: `environnement du job \`${jobId}\` ambigu` };
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
  if (filters.branches !== undefined) return `${name} (branches : ${filters.branches.join(', ')})`;
  if (filters.branchesIgnore !== undefined) return `${name} (branches-ignore : ${filters.branchesIgnore.join(', ')})`;
  if (filters.tags !== undefined) return `${name} (tags seulement)`;
  if (filters.tagsIgnore !== undefined) return `${name} (tags-ignore : ${filters.tagsIgnore.join(', ')})`;
  if (name === 'push' || name === 'workflow_run') return `${name} (toutes les branches)`;
  return name;
}

/** Why a workflow with secrets can run on a factory branch; empty when no trigger does. */
function exposureReasons(triggers: Map<string, TriggerFilters>): string[] {
  const reasons: string[] = [];
  for (const [name, filters] of triggers) {
    if (name === 'pull_request' || name === 'pull_request_target') {
      reasons.push(`${name} peut exécuter la CI sur une branche \`factory/*\``);
    } else if ((name === 'push' || name === 'workflow_run') && pushReachesFactory(filters)) {
      reasons.push(`${triggerLabel(name, filters)} peut exécuter la CI sur une branche \`factory/*\``);
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
      verdict: 'refusé',
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
  let verdict: WorkflowReport['verdict'] = 'accepté';
  if (!workflow.hasSecrets) {
    reasons.push('aucun secret référencé');
  } else if (exposure.length === 0) {
    reasons.push("secrets référencés uniquement sur des déclencheurs qui n'atteignent pas les branches de l'usine");
  } else if (workflow.secretJobs.length === 0) {
    reasons.push('workflow sans job : aucun secret ne peut être exposé');
  } else if (unprotectedJobs.length === 0) {
    reasons.push(`secrets limités aux jobs sous environnement protégé (${[...new Set(workflow.environmentNames)].join(', ')})`);
  } else {
    verdict = 'refusé';
    reasons.push(`secrets exposés sur les branches de l'usine (${exposure.join(' ; ')}) sans approbation humaine`);
    const withoutEnvironment = unprotectedJobs.filter((jobId) => !workflow.jobEnvironments.has(jobId));
    const withUnprotectedEnvironment = unprotectedJobs.filter((jobId) => workflow.jobEnvironments.has(jobId));
    if (withoutEnvironment.length > 0) reasons.push(`job(s) sans environnement : ${withoutEnvironment.join(', ')}`);
    if (withUnprotectedEnvironment.length > 0) reasons.push(`job(s) sous environnement sans required reviewers : ${withUnprotectedEnvironment.join(', ')}`);
    for (const name of workflow.environmentNames) {
      if (!environments.has(name)) reasons.push(`environnement \`${name}\` introuvable dans l'API GitHub`);
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
    return doctorFailure(options, `Lecture des workflows impossible : ${errorMessage(error)}`);
  }
  let environments: EnvironmentProtection[] = [];
  if (workflows.length > 0) {
    try {
      environments = await api.listEnvironments(repoPath);
    } catch (error) {
      return doctorFailure(options, `Lecture des environnements impossible : ${errorMessage(error)}`);
    }
  }
  const environmentMap = new Map(environments.map((environment) => [environment.name, environment] as const));
  const reports = workflows.map((workflow) => analyzeWorkflow(workflow, environmentMap));
  const accepted = reports.every((report) => report.verdict === 'accepté');
  const refused = reports.filter((report) => report.verdict === 'refusé').length;

  if (options.json) {
    out(JSON.stringify({ repoPath, accepted, workflows: reports }, null, 2));
  } else {
    if (reports.length === 0) out('Aucun workflow GitHub Actions trouvé.');
    else {
      out(`Workflows GitHub Actions : ${reports.length}`);
      out('');
      for (const report of reports) {
        out(report.path);
        out(`  déclencheurs : ${report.triggers.length > 0 ? report.triggers.join(', ') : 'inconnus'}`);
        out(`  secrets : ${report.secrets ? 'oui' : 'non'}`);
        out(
          `  environnements : ${
            report.environments.length > 0
              ? report.environments
                  .map((environment) => `${environment.name} (${environment.requiredReviewers ? 'required reviewers' : 'sans required reviewers'})`)
                  .join(', ')
              : 'aucun'
          }`,
        );
        out(`  environnement protégé : ${report.protected ? 'oui' : 'non'}`);
        out(`  verdict : ${report.verdict} — ${report.reasons.join(' ')}`);
        out('');
      }
    }
    out(
      accepted
        ? "Résultat : accepté — aucun workflow ne peut exposer de secret aux branches de l'usine."
        : `Résultat : refusé — ${refused} workflow(s) sur ${reports.length} peuvent exposer des secrets aux branches de l'usine.`,
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
    githubApp = resolveGithubApp(loadInstance(options.home), options.env);
  } catch (error) {
    out(errorMessage(error));
    return 1;
  }
  if (!githubApp) {
    out(
      'GitHub App non configurée : `factory doctor` a besoin de github.appId et github.privateKey (ou GH_APP_ID et GH_APP_KEY) ' +
        'pour lire les workflows et les environnements. Aucun repli `gh` pour ce contrôle.',
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
