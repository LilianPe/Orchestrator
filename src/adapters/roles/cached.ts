import { githubLogin, type Role } from '../../core/authz.js';
import type { ProjectAuthz, RepoPermission, RepoPermissions, RoleResolver, TeamDirectory } from './types.js';

/**
 * How long a team's members or a user's GitHub permission are kept (ORC-186). Short on purpose: roles
 * read once at startup would let someone who left the team, or lost their rights, act until a restart.
 */
export const ROLES_TTL_MS = 60_000;

/** GitHub lets write access merge a PR (branch protection aside): both rights read the same permissions. */
const WRITES: ReadonlySet<RepoPermission> = new Set(['write', 'maintain', 'admin']);

export interface CachedRoleResolverOptions {
  projects: (projectId: string) => ProjectAuthz | undefined;
  team: TeamDirectory;
  /** Without it (no forge that reads permissions), nobody gets a GitHub right. */
  repo?: RepoPermissions;
  ttlMs?: number;
  now?: () => number;
}

/**
 * The `RoleResolver` of the daemon: Linear team members and GitHub permissions read through their
 * ports, each answer kept `ttlMs`; maintainers, validators and the Linear → GitHub login map from the
 * project's configuration. A failure is not kept: the next resolution reads again.
 */
export class CachedRoleResolver implements RoleResolver {
  private readonly cache = new Map<string, { value: unknown; until: number }>();
  /** Reads under way: concurrent resolutions share one read per key. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly o: CachedRoleResolverOptions) {
    this.ttlMs = o.ttlMs ?? ROLES_TTL_MS;
    this.now = o.now ?? Date.now;
  }

  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return Promise.resolve(hit.value as T);
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const request = read()
      .then((value) => {
        this.cache.set(key, { value, until: now + this.ttlMs });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  /**
   * `actorId`: a Linear user id, its GitHub rights read through its configured login; or a GitHub actor (`github:<login>`, ORC-190),
   * its Linear roles those of the user configured with that login, if any.
   */
  async rolesOf(projectId: string, actorId: string): Promise<Role[]> {
    const p = this.o.projects(projectId);
    if (!p) return [];
    const github = githubLogin(actorId)?.toLowerCase();
    // GitHub logins ignore case: one cache entry per user, whatever case the webhook or the configuration wrote.
    const login = (github ?? p.githubLogins[actorId])?.toLowerCase();
    const repo = this.o.repo;
    const permission = login && repo ? this.cached(`repo:${p.repoPath}:${login}`, () => repo.repoPermission(p.repoPath, login)) : undefined;
    const id = github === undefined ? actorId : Object.keys(p.githubLogins).find((u) => p.githubLogins[u]!.toLowerCase() === github);
    // A GitHub login configured for no Linear user holds no Linear role, and reads no team.
    if (id === undefined) return writes(await permission);
    const [members, read] = await Promise.all([this.cached(`team:${p.teamKey}`, async () => new Set(await this.o.team.teamMembers(p.teamKey))), permission]);
    const roles: Role[] = members.has(id) ? ['team_member'] : [];
    roles.push(...writes(read));
    if (p.maintainers.includes(id)) roles.push('maintainer');
    if (p.validators.includes(id)) roles.push('validator');
    return roles;
  }
}

/** The roles a GitHub permission gives: write access lets a user merge a PR too (branch protection aside). */
const writes = (permission: RepoPermission | undefined): Role[] => (permission && WRITES.has(permission) ? ['repo_writer', 'repo_merger'] : []);
