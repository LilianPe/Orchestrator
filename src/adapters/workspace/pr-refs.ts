import { join } from 'node:path';
import { STALLED } from '../../publish/publish.js';
import { execCmd, HARDENING, mustExec, type Exec, type ExecOpts, type ExecResult } from '../exec.js';

/** The agent's git, in its own repository: in its sandbox, or on the host without one. */
export type InWorktree = (args: readonly string[]) => Promise<ExecResult>;

export interface PrRefsRequest {
  /** The factory's repository: the only one that reaches the forge. */
  repoPath: string;
  branch: string;
  base: string;
  /** On the host, written by the factory alone: mounted read-only where `inWorktree` reads it. */
  bundleDir: string;
  /** `bundleDir` as the agent's git sees it; `bundleDir` itself without a sandbox. */
  bundleTarget?: string;
  inWorktree: InWorktree;
  /** `git fetch origin` on the factory's repository first; false when the caller has just fetched it. */
  fetch?: boolean;
  exec?: Exec;
  fetchTimeoutMs?: number;
}

const BUNDLE = 'pr.bundle';
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const FETCH_DEADLINE_MS = 2 * 60_000;

/**
 * The PR's head and base, from the forge into the agent's repository without network for the agent (ORC-322): the
 * factory fetches its own repository, bundles what the agent's lacks, and the agent's git fetches that file. No host
 * git ever runs in the agent's repository (ORC-317): what the factory reads from it, the shas of its refs, is data.
 * Returns the shas `origin/<branch>` and `origin/<base>` now name there.
 */
export async function bringPrRefs(o: PrRefsRequest): Promise<{ head: string; base: string }> {
  const exec = o.exec ?? execCmd;
  const run = gitAt(o.repoPath, exec);
  const host = async (args: string[], opts: ExecOpts = {}) => (await mustExec(exec, 'git', gitArgs(o.repoPath, args), opts)).trim();
  // Git's own rules, and never an option: the names come from the forge.
  for (const name of [o.branch, o.base]) {
    if (name.startsWith('-') || name.includes('@{') || (await run(['check-ref-format', '--branch', name])).code !== 0) throw new Error(`invalid branch name: ${JSON.stringify(name)}`);
  }
  if (o.branch === o.base) throw new Error(`the PR's branch ${o.branch} is its base`);
  const tips = [o.branch, o.base].map((b) => ({ branch: b, ref: `refs/remotes/origin/${b}` }));
  if (o.fetch) {
    await host(['fetch', '--quiet', '--no-tags', 'origin', ...tips.map((t) => `+refs/heads/${t.branch}:${t.ref}`)], { env: { GIT_TERMINAL_PROMPT: '0', ...STALLED }, timeoutMs: o.fetchTimeoutMs ?? FETCH_DEADLINE_MS });
  }
  const [want, have] = await Promise.all([Promise.all(tips.map((t) => host(['rev-parse', '--verify', '--end-of-options', `${t.ref}^{commit}`]))), agentShas(o.inWorktree, tips.map((t) => t.ref))]);
  const moved = tips.map((t, i) => ({ ref: t.ref, want: want[i]!, have: have.get(t.ref) })).filter((t) => t.want !== t.have);
  if (moved.length) {
    // The agent's shas are only prerequisites, and only those the factory has: a bundle the agent's repository cannot read fails its fetch, nothing else.
    const known = await Promise.all([...have.values()].map(async (sha) => ((await run(['cat-file', '-e', `${sha}^{commit}`])).code === 0 ? sha : undefined)));
    const prereqs = [...new Set(known.filter((s): s is string => !!s))];
    const reachable = async (tip: string) => {
      for (const p of prereqs) if ((await run(['merge-base', '--is-ancestor', tip, p])).code === 0) return true;
      return false;
    };
    // A ref already reachable from a prerequisite is left out of a bundle: the agent has its commit, the ref is set directly.
    const bundled: string[] = [];
    for (const t of moved) {
      if (await reachable(t.want)) await agent(o.inWorktree, ['update-ref', t.ref, t.want]);
      else bundled.push(t.ref);
    }
    if (bundled.length) {
      await host(['bundle', 'create', '--quiet', join(o.bundleDir, BUNDLE), ...bundled, ...prereqs.map((p) => `^${p}`)]);
      await agent(o.inWorktree, ['fetch', '--quiet', '--no-tags', '--', join(o.bundleTarget ?? o.bundleDir, BUNDLE), ...bundled.map((r) => `+${r}:${r}`)]);
    }
  }
  return { head: want[0]!, base: want[1]! };
}

/**
 * The worktree's branch moved to `origin/<branch>` when only the forge has new commits: what the review reviews is
 * the PR's head. `diverged`: both have commits of their own, nothing is moved.
 */
export async function fastForward(inWorktree: InWorktree, branch: string): Promise<'fast-forwarded' | 'up-to-date' | 'diverged'> {
  const remote = `refs/remotes/origin/${branch}`;
  if (await isAncestor(inWorktree, remote, 'HEAD')) return 'up-to-date';
  if (!(await isAncestor(inWorktree, 'HEAD', remote))) return 'diverged';
  await agent(inWorktree, ['merge', '--quiet', '--ff-only', remote]);
  return 'fast-forwarded';
}

/** The agent's git on the host, for a run without a sandbox, where none of ORC-317's guarantees hold anyway. */
export function hostWorktree(path: string, exec: Exec = execCmd): InWorktree {
  return gitAt(path, exec);
}

/** Host git in `path`, hardened: no hook, no fsmonitor. */
const gitArgs = (path: string, args: readonly string[]) => [...HARDENING.flatMap((c) => ['-c', c]), '-C', path, ...args];
const gitAt = (path: string, exec: Exec) => (args: readonly string[], opts?: ExecOpts) => exec('git', gitArgs(path, args), opts);

/** The shas of `refs` in the agent's repository, in one call: anything but a sha is no sha, a ref it lacks is absent. */
async function agentShas(inWorktree: InWorktree, refs: readonly string[]): Promise<Map<string, string>> {
  const r = await inWorktree(['for-each-ref', '--format=%(refname) %(objectname)', '--', ...refs]);
  const shas = new Map<string, string>();
  if (r.code !== 0) return shas;
  for (const line of r.stdout.split('\n')) {
    const [ref = '', sha = ''] = line.trim().split(' ');
    // A pattern also matches the refs under it (`origin/main/x`): only the ref itself counts.
    if (refs.includes(ref) && SHA.test(sha)) shas.set(ref, sha);
  }
  return shas;
}

/** `merge-base --is-ancestor`: 0 yes, 1 no; any other code is git failing (a missing commit, an unborn HEAD), never an answer. */
async function isAncestor(inWorktree: InWorktree, a: string, b: string): Promise<boolean> {
  const r = await inWorktree(['merge-base', '--is-ancestor', a, b]);
  if (r.code === 0 || r.code === 1) return r.code === 0;
  throw new Error(`git merge-base in the worktree: ${r.stderr.trim() || `code ${r.code}`}`);
}

async function agent(inWorktree: InWorktree, args: string[]): Promise<void> {
  const r = await inWorktree(args);
  if (r.code !== 0) throw new Error(`git ${args[0]} in the worktree: ${r.stderr.trim() || `code ${r.code}`}`);
}
