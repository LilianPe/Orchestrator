import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';

/**
 * The environment of a replayed ticket (ORC-231), as it was when the human started: the repository at the parent of the human PR's
 * merge commit, the knowledge base at its last commit before that, the linked tickets as they were. Nothing written after enters it.
 */

/** A local path as git's `file://` URL: a shallow fetch from a plain path is ignored, git copies the whole repository then. */
const remoteOf = (remote: string) => (isAbsolute(remote) ? pathToFileURL(remote).href : remote);

/**
 * The fetch of a sha from `remote`: a forge allows any sha; a local repository only by this setting of its upload-pack, which is
 * given for a local one only (over SSH, the command is the server's to run, and GitHub's runs none but its own).
 */
const fetchArgs = (remote: string, depth: number, sha: string) => [
  'fetch', '-q', '--no-tags', '--depth', String(depth),
  ...(isAbsolute(remote) || remote.startsWith('file:') ? ['--upload-pack', 'git -c uploadpack.allowAnySHA1InWant=true upload-pack'] : []),
  remoteOf(remote), sha,
];

/**
 * `dir` as a repository holding `sha` alone: fetched at depth 1, checked out detached, no remote. Nothing after it is in it, nor
 * anything a `git fetch` of the agent could bring back.
 */
async function shallowAt(remote: string, sha: string, dir: string, exec: Exec): Promise<void> {
  const git = (args: string[]) => mustExec(exec, 'git', ['-C', dir, ...args]);
  await mkdir(dir, { recursive: true });
  await git(['init', '-q']);
  await git(fetchArgs(remote, 1, sha));
  await git(['checkout', '-q', '--detach', sha]);
}

/**
 * Criterion 2: the clone of a replayed ticket, at the parent of the human PR's merge commit (its first parent: the default branch
 * before the merge; for a squash, the commit it was squashed onto). Returns that start. The merge commit is read in a probe of its
 * own, thrown away: the clone never holds it.
 *
 * A rebase merge puts the PR's commits one by one on the base, the merge commit being the last of them: its parent would already
 * hold the human's work. Given `prCommits`, the PR's commit headlines oldest first, a merge commit with a single parent whose last
 * commits carry exactly these headlines is taken for a rebase, and the start is the commit before the first of them.
 */
export async function cloneAtStart(o: { remote: string; mergeSha: string; dir: string; prCommits?: readonly string[]; exec?: Exec }): Promise<string> {
  const exec = o.exec ?? execCmd;
  const probe = await mkdtemp(join(tmpdir(), 'factory-ghost-probe-'));
  const n = o.prCommits?.length ?? 0;
  let start: string;
  try {
    const git = async (args: string[]) => (await mustExec(exec, 'git', ['-C', probe, ...args])).trim();
    await git(['init', '-q']);
    await git(fetchArgs(o.remote, Math.max(2, n + 1), o.mergeSha));
    const parents = (await git(['rev-list', '--parents', '-n', '1', o.mergeSha])).split(' ').length - 1;
    const headlines = n > 1 && parents === 1 ? (await git(['log', '--format=%s', '-n', String(n), o.mergeSha])).split('\n').reverse() : [];
    const rebased = n > 1 && headlines.length === n && headlines.every((h, i) => h === o.prCommits![i]);
    start = await git(['rev-parse', rebased ? `${o.mergeSha}~${n}` : `${o.mergeSha}^1`]);
    // From the probe, which holds the start already: the forge is fetched from once.
    await shallowAt(probe, start, o.dir, exec);
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  return start;
}

/**
 * The knowledge base at transaction time (ORC-231, ORC-257): its last commit before `before` (ms), by commit date, not a date a
 * note claims, so that a note learned from the replayed PR cannot leak into its own replay. Undefined when it had none yet.
 */
export async function knowledgeAt(o: { repo: string; before: number; dir: string; exec?: Exec }): Promise<string | undefined> {
  const exec = o.exec ?? execCmd;
  const sha = (await mustExec(exec, 'git', ['-C', o.repo, 'rev-list', '-1', `--before=${new Date(o.before).toISOString()}`, 'HEAD'])).trim();
  if (!sha) return undefined;
  await shallowAt(o.repo, sha, o.dir, exec);
  return sha;
}

/** A linked ticket as the replay reads it: its comments with their dates. */
export interface HistoricalIssue {
  identifier: string;
  title: string;
  description: string;
  createdAt: number;
  comments: { body: string; createdAt: number }[];
}

/**
 * The linked tickets as they were at `start` (ms): those created before it, with the comments written before it. Linear keeps no
 * history of a description: an edit made after the start stays, a limit the report states.
 */
export function linkedAsOf(issues: readonly HistoricalIssue[], start: number): HistoricalIssue[] {
  return issues.filter((i) => i.createdAt < start).map((i) => ({ ...i, comments: i.comments.filter((c) => c.createdAt < start) }));
}
