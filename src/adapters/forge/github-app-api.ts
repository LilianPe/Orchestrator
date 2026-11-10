import { GitHubApiError, GitHubAppAuth, isRecord } from './github-app.js';

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

/** `GET /app`: a slug that names it, the only one GitHub gives (lowercase letters, digits and dashes). */
const isApp = (v: unknown): v is { slug: string } => isRecord(v) && typeof v.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(v.slug);

function hasRequiredReviewers(rules: EnvironmentDto['protection_rules']): boolean {
  return (rules ?? []).some((rule) => rule.type === 'required_reviewers' && (rule.reviewers ?? []).length > 0);
}

/**
 * Read-only GitHub App client for `factory doctor`.
 * It reuses the App authentication of the forge (JWT, repo-scoped token) and adds
 * the two reads the CI secret check needs: workflow files and environment rules.
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

  /** The App's login as an actor, `<slug>[bot]` (ORC-283): `github.actor` on its pushes and the PRs it opens. */
  async appLogin(): Promise<string> {
    const app = await this.read('GET', '/app', this.appJwt(), isApp, 'the App');
    return `${app.slug}[bot]`;
  }
}
