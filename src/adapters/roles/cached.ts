import type { Role } from '../../core/authz.js';
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

  async rolesOf(projectId: string, actorId: string): Promise<Role[]> {
    const p = this.o.projects(projectId);
    if (!p) return [];
    const login = p.githubLogins[actorId];
    const repo = this.o.repo;
    const [members, permission] = await Promise.all([
      this.cached(`team:${p.teamKey}`, async () => new Set(await this.o.team.teamMembers(p.teamKey))),
      login && repo ? this.cached(`repo:${p.repoPath}:${login}`, () => repo.repoPermission(p.repoPath, login)) : undefined,
    ]);
    const roles: Role[] = [];
    if (members.has(actorId)) roles.push('team_member');
    if (permission && WRITES.has(permission)) roles.push('repo_writer', 'repo_merger');
    if (p.maintainers.includes(actorId)) roles.push('maintainer');
    if (p.validators.includes(actorId)) roles.push('validator');
    return roles;
  }
}
