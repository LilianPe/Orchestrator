import { join } from 'node:path';
import { STALLED } from '../../publish/publish.js';
import { execCmd, execFailure, HARDENING, type Exec, type ExecResult } from '../exec.js';

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
  const run = (args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}) => exec('git', [...HARDENING.flatMap((c) => ['-c', c]), '-C', o.repoPath, ...args], opts);
  const host = async (args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}) => {
    const r = await run(args, opts);
    if (r.code !== 0) throw execFailure('git', args, r);
    return r.stdout.trim();
  };
  // Git's own rules, and never an option: the names come from the forge.
  for (const name of [o.branch, o.base]) {
    if (name.startsWith('-') || name.includes('@{') || (await run(['check-ref-format', '--branch', name])).code !== 0) throw new Error(`invalid branch name: ${JSON.stringify(name)}`);
  }
  if (o.branch === o.base) throw new Error(`the PR's branch ${o.branch} is its base`);
  if (o.fetch) await host(['fetch', '--quiet', 'origin'], { env: { GIT_TERMINAL_PROMPT: '0', ...STALLED }, timeoutMs: o.fetchTimeoutMs ?? FETCH_DEADLINE_MS });

  const refs = [o.branch, o.base].map((b) => `refs/remotes/origin/${b}`);
  const want = await Promise.all(refs.map((ref) => host(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])));
  const have = await Promise.all(refs.map((ref) => agentSha(o.inWorktree, ref)));
  const moved = refs.filter((_, i) => want[i] !== have[i]);
  if (moved.length) {
    // The agent's shas are only prerequisites, and only those the factory has: a bundle the agent's repository cannot read fails its fetch, nothing else.
    const known = await Promise.all(have.map(async (sha) => (sha && (await run(['cat-file', '-e', `${sha}^{commit}`])).code === 0 ? sha : undefined)));
    const prereqs = [...new Set(known.filter((s): s is string => !!s))];
    // A ref already reachable from a prerequisite is left out of a bundle: the agent has its commit, the ref is set directly.
    const direct: string[] = [];
    const bundled: string[] = [];
    for (const ref of moved) {
      const tip = want[refs.indexOf(ref)]!;
      let reachable = false;
      for (const p of prereqs) if ((await run(['merge-base', '--is-ancestor', tip, p])).code === 0) reachable = true;
      (reachable ? direct : bundled).push(ref);
    }
    for (const ref of direct) await agent(o.inWorktree, ['update-ref', ref, want[refs.indexOf(ref)]!]);
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
  if ((await inWorktree(['merge-base', '--is-ancestor', remote, 'HEAD'])).code === 0) return 'up-to-date';
  if ((await inWorktree(['merge-base', '--is-ancestor', 'HEAD', remote])).code !== 0) return 'diverged';
  await agent(inWorktree, ['merge', '--quiet', '--ff-only', remote]);
  return 'fast-forwarded';
}

/** The agent's git on the host, for a run without a sandbox, where none of ORC-317's guarantees hold anyway. */
export function hostWorktree(path: string, exec: Exec = execCmd): InWorktree {
  return (args) => exec('git', [...HARDENING.flatMap((c) => ['-c', c]), '-C', path, ...args]);
}

/** A ref's sha in the agent's repository: anything but a sha is no sha. */
async function agentSha(inWorktree: InWorktree, ref: string): Promise<string | undefined> {
  const r = await inWorktree(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : undefined;
}

async function agent(inWorktree: InWorktree, args: string[]): Promise<void> {
  const r = await inWorktree(args);
  if (r.code !== 0) throw new Error(`git ${args[0]} in the worktree: ${r.stderr.trim() || `code ${r.code}`}`);
}
