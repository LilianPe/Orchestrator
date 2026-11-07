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

interface EnvironmentsDto {
  total_count?: number;
  environments?: unknown;
}

const WORKFLOWS_DIR = '.github/workflows';
/** Until the guards of `doctor`'s reads land: the answer as it comes, as the previous `request` gave it. */
const anything = (_v: unknown): _v is unknown => true;
const MAX_ENVIRONMENT_PAGES = 10;

function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Each path segment is encoded so a file name may contain spaces or `#`. */
function encodedPath(path: string): string {
  return path.split('/').map(segment).join('/');
}

function isWorkflowEntry(value: unknown): value is { type: 'file'; name?: string; path: string } {
  return isRecord(value) && value.type === 'file' && typeof value.path === 'string';
}

function hasRequiredReviewers(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  return rules.some(
    (rule) =>
      isRecord(rule) &&
      rule.type === 'required_reviewers' &&
      Array.isArray(rule.reviewers) &&
      rule.reviewers.length > 0,
  );
}

/**
 * Read-only GitHub App client for `factory doctor`.
 * It reuses the App authentication of the forge (JWT, repo-scoped token) and adds
 * the two reads the CI secret check needs: workflow files and environment rules.
 * A 404 on `.github/workflows` means no CI, not an error.
 */
export class GitHubAppApi extends GitHubAppAuth {
  async listWorkflows(repoPath: string): Promise<WorkflowSource[]> {
    let entries: unknown;
    try {
      entries = await this.requestRead(repoPath, (repo) => {
        return `/repos/${segment(repo.owner)}/${segment(repo.name)}/contents/${encodedPath(WORKFLOWS_DIR)}`;
      }, anything, 'anything');
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return [];
      throw err;
    }
    if (!Array.isArray(entries)) return [];
    const files = entries.filter(isWorkflowEntry).filter((entry) => /\.ya?ml$/i.test(entry.name ?? entry.path));
    const sources: WorkflowSource[] = [];
    for (const file of files) {
      const dto = await this.requestRead(repoPath, (repo) => {
        return `/repos/${segment(repo.owner)}/${segment(repo.name)}/contents/${encodedPath(file.path)}`;
      }, anything as (v: unknown) => v is ContentEntryDto | undefined, 'anything');
      if (typeof dto?.content !== 'string' || dto.encoding !== 'base64') {
        throw new Error(`GitHub : contenu illisible pour ${file.path} (fichier trop gros ou encodage inattendu)`);
      }
      sources.push({ path: file.path, content: Buffer.from(dto.content, 'base64').toString('utf8') });
    }
    return sources.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listEnvironments(repoPath: string): Promise<EnvironmentProtection[]> {
    const environments: EnvironmentProtection[] = [];
    for (let page = 1; page <= MAX_ENVIRONMENT_PAGES; page++) {
      const data = await this.requestRead(repoPath, (repo) => {
        return `/repos/${segment(repo.owner)}/${segment(repo.name)}/environments?per_page=100&page=${page}`;
      }, anything as (v: unknown) => v is EnvironmentsDto | undefined, 'anything');
      const batch = Array.isArray(data?.environments) ? data.environments : [];
      for (const environment of batch) {
        if (!isRecord(environment) || typeof environment.name !== 'string' || !environment.name) continue;
        environments.push({
          name: environment.name,
          requiredReviewers: hasRequiredReviewers(environment.protection_rules),
        });
      }
      const total = typeof data?.total_count === 'number' ? data.total_count : environments.length;
      if (batch.length === 0 || environments.length >= total) break;
    }
    return environments;
  }
}
