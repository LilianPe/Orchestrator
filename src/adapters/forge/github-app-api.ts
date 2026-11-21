import { GitHubApiError, GitHubAppAuth, isRecord, repoApi } from './github-app.js';

/** One workflow file, decoded from the Contents API. */
export interface WorkflowSource {
  path: string;
  content: string;
}

/** Environment protection as `factory doctor` needs it: a human approval rule or not. */
export interface EnvironmentProtection {
  name: string;
  /** True only with a `required_reviewers` rule that lists at least one reviewer. */
  requiredReviewers: boolean;
}

/**
 * The default branch's protection as `factory doctor` reads it (ORC-208), with the App's read permissions only: the
 * classic protection's flag (its rules need the *Administration* permission, which the App does not have) and the types
 * of the rules the repository's active rulesets apply to it.
 */
export interface BranchProtection {
  branch: string;
  classic: boolean;
  rules: string[];
  /**
   * The rulesets with a `pull_request` rule, each with whether the App may bypass it (`current_user_can_bypass`:
   * `always`, `pull_requests_only`, `exempt` or `never`): a ruleset the App bypasses does not keep the branch from it.
   */
  pullRequestRulesets: { id: number; bypass: string }[];
}

interface ContentEntryDto {
  type?: string;
  name?: string;
  path?: string;
  content?: string;
  encoding?: string;
}

const WORKFLOWS_DIR = '.github/workflows';

function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Each path segment is encoded so a file name may contain spaces or `#`. */
function encodedPath(path: string): string {
  return path.split('/').map(segment).join('/');
}

interface DirEntryDto {
  type: string;
  name?: string;
  path: string;
}

interface EnvironmentDto {
  name: string;
  protection_rules?: { type: string; reviewers?: unknown[] }[];
}

/** A file of the Contents API: its content and encoding, both strings (a file too big has `encoding: 'none'`, rejected below). */
const isFile = (v: unknown): v is ContentEntryDto & { content: string; encoding: string } =>
  isRecord(v) && typeof v.content === 'string' && typeof v.encoding === 'string';

const isDirEntry = (v: unknown): v is DirEntryDto =>
  isRecord(v) && typeof v.type === 'string' && typeof v.path === 'string' && (v.name === undefined || typeof v.name === 'string');

/** A listing of `.github/workflows`: read as "no workflow" when it is not one, `doctor` would skip the CI secret check (ORC-135). */
const isDirListing = (v: unknown): v is DirEntryDto[] => Array.isArray(v) && v.every(isDirEntry);

/** A reviewer of a rule, as GitHub lists it: its type and the user or team behind it. Anything else is no proof of a human approval. */
const isReviewer = (v: unknown): boolean => isRecord(v) && typeof v.type === 'string' && isRecord(v.reviewer);

/** A rule that requires reviewers carries their list: without it, "no reviewer" would be a guess, and "protected" a worse one. */
const isProtectionRule = (r: unknown): r is { type: string; reviewers?: unknown[] } =>
  isRecord(r) && typeof r.type === 'string' && (r.type !== 'required_reviewers' || (Array.isArray(r.reviewers) && r.reviewers.every(isReviewer)));

const isEnvironment = (v: unknown): v is EnvironmentDto =>
  isRecord(v) &&
  typeof v.name === 'string' &&
  v.name !== '' &&
  (v.protection_rules === undefined || (Array.isArray(v.protection_rules) && v.protection_rules.every(isProtectionRule)));

const isRepository = (v: unknown): v is { default_branch: string } => isRecord(v) && typeof v.default_branch === 'string' && v.default_branch !== '';
/**
 * A branch with its classic protection's flag, `protection.enabled`. Not the branch's `protected`: GitHub sets it for
 * an active ruleset too, whatever its rules, so a ruleset that only blocks deletion would read as a classic protection.
 */
const isBranch = (v: unknown): v is { protection: { enabled: boolean } } =>
  isRecord(v) && isRecord(v.protection) && typeof v.protection.enabled === 'boolean';
const isRule = (r: unknown): r is { type: string; ruleset_id: number } => isRecord(r) && typeof r.type === 'string' && typeof r.ruleset_id === 'number';
const isRuleset = (v: unknown): v is { current_user_can_bypass: string } => isRecord(v) && typeof v.current_user_can_bypass === 'string';

/** An installation with its permissions, each a level (`read`, `write`): anything else is no proof of what it holds. */
const isInstallation = (v: unknown): v is { permissions: Record<string, string> } =>
  isRecord(v) && isRecord(v.permissions) && Object.values(v.permissions).every((level) => typeof level === 'string');

function hasRequiredReviewers(rules: EnvironmentDto['protection_rules']): boolean {
  return (rules ?? []).some((rule) => rule.type === 'required_reviewers' && (rule.reviewers ?? []).length > 0);
}

/**
 * Read-only GitHub App client for `factory doctor`.
 * It reuses the App authentication of the forge (JWT, repo-scoped token) and adds
 * the reads its checks need: workflow files and environment rules for the CI secret check, the default branch's
 * protection (ORC-208), the permissions the App's installation holds (ORC-439).
 * A 404 on `.github/workflows` means no CI, not an error. A 2xx answer it cannot read rejects, never read as
 * "no workflow" or "no environment" (ORC-273): `doctor` would then skip the CI secret check.
 */
export class GitHubAppApi extends GitHubAppAuth {
  async listWorkflows(repoPath: string): Promise<WorkflowSource[]> {
    // Resolved before the try: a 404 on the installation or its token is a configuration error, never "no CI".
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const contents = `/repos/${segment(repo.owner)}/${segment(repo.name)}/contents`;
    let entries: DirEntryDto[];
    try {
      entries = await this.read('GET', `${contents}/${encodedPath(WORKFLOWS_DIR)}`, token, isDirListing, 'a directory listing');
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return [];
      throw err;
    }
    const files = entries.filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name ?? entry.path));
    const sources: WorkflowSource[] = [];
    for (const file of files) {
      const dto = await this.read('GET', `${contents}/${encodedPath(file.path)}`, token, isFile, 'a file');
      if (dto.encoding !== 'base64') {
        throw new Error(`GitHub: unreadable content for ${file.path} (file too large or unexpected encoding)`);
      }
      sources.push({ path: file.path, content: Buffer.from(dto.content, 'base64').toString('utf8') });
    }
    return sources.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listEnvironments(repoPath: string): Promise<EnvironmentProtection[]> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const path = `/repos/${segment(repo.owner)}/${segment(repo.name)}/environments`;
    const environments = await this.allPages(path, 'environments', 'a list of environments', isEnvironment, token);
    return environments.map((environment) => ({ name: environment.name, requiredReviewers: hasRequiredReviewers(environment.protection_rules) }));
  }

  /** The default branch's, as `doctor` judges it; `named`, another branch's (the real GitHub's test, ORC-427). */
  async branchProtection(repoPath: string, named?: string): Promise<BranchProtection> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const base = repoApi(repo);
    const branch = named || (await this.read('GET', base, token, isRepository, 'a repository with its default branch')).default_branch;
    const [{ protection: { enabled: classic } }, rules] = await Promise.all([
      this.read('GET', `${base}/branches/${segment(branch)}`, token, isBranch, 'a branch with its classic protection flag'),
      this.allPages(`${base}/rules/branches/${segment(branch)}`, null, 'a list of branch rules', isRule, token),
    ]);
    const ids = [...new Set(rules.filter((rule) => rule.type === 'pull_request').map((rule) => rule.ruleset_id))].sort((a, b) => a - b);
    const pullRequestRulesets = await Promise.all(
      ids.map(async (id) => ({ id, bypass: (await this.read('GET', `${base}/rulesets/${id}`, token, isRuleset, 'a ruleset')).current_user_can_bypass })),
    );
    return { branch, classic, rules: [...new Set(rules.map((rule) => rule.type))].sort(), pullRequestRulesets };
  }

  /** What the App's installation on the repository holds, as granted, not as the manifest asks: read with the App's JWT. */
  async installationPermissions(repoPath: string): Promise<Record<string, string>> {
    const repo = await this.repo(repoPath);
    return (await this.read('GET', `${repoApi(repo)}/installation`, this.appJwt(), isInstallation, 'an installation with its permissions')).permissions;
  }
}
