import type { Role } from '../../core/authz.js';

/**
 * The roles of a signed actor on a project (ORC-186), resolved before the decision and journaled
 * with the event. Throws when a source does not answer: the event then waits and is retried, rather
 * than be decided on roles that may be wrong.
 */
export interface RoleResolver {
  rolesOf(projectId: string, actorId: string): Promise<Role[]>;
}

/** The ids of the active members of a Linear team (`LinearTracker`, `FakeTracker`). */
export interface TeamDirectory {
  teamMembers(teamKey: string): Promise<string[]>;
}

/** A GitHub user's permission on a repository, as `GET /repos/{owner}/{repo}/collaborators/{user}/permission` gives it. */
export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

/** Reads a user's permission on the repo of `repoPath` (the GitHub App forge, the `gh` forge, `FakeForge`). */
export interface RepoPermissions {
  repoPermission(repoPath: string, login: string): Promise<RepoPermission>;
}

/** Who holds the roles of a project that no source gives: from the instance configuration until `.factory/config.yml` (ORC-209). */
export interface ProjectAuthz {
  teamKey: string;
  repoPath: string;
  /** Linear user ids of the designated maintainers (`/refreeze`). */
  maintainers: readonly string[];
  /** Linear user ids of the designated spec validators. */
  validators: readonly string[];
  /** GitHub login of each Linear user id: Linear gives none the factory can read. */
  githubLogins: Readonly<Record<string, string>>;
}
