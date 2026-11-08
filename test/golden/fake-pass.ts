import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RunRequest } from '../../src/adapters/runner/types.js';
import type { GoldenTicket } from '../../src/golden/golden-set.js';
import type { GoldenPass, RunGoldenPass } from '../../src/golden/replay.js';
import { canonical } from '../../src/runtime/workflow-version.js';
import { createHarness } from '../helpers/harness.js';

/** The files under `dir`, relative and sorted, with their text (line endings aside). */
function tree(dir: string): [string, string][] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e): [string, string] => {
      const path = join(e.parentPath, e.name);
      return [relative(dir, path).split(sep).join('/'), readFileSync(path, 'utf8').replace(/\r\n/g, '\n')];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What a run receives: its prompt, model and bounds, and the text of its skill, the pack's hooks and settings. */
function runInputs(req: RunRequest, packDir: string): unknown {
  const skill = /^\/[^:\s]+:(\S+)/.exec(req.prompt)?.[1];
  return {
    prompt: req.prompt, model: req.model, effort: req.effort, readOnly: req.readOnly, limits: req.limits,
    skill: skill ? tree(join(packDir, 'skills', skill)) : null,
    hooks: tree(join(packDir, 'hooks')),
    settings: readFileSync(join(packDir, 'settings.json'), 'utf8').replace(/\r\n/g, '\n'),
  };
}

/**
 * A golden pass on the fake adapters and the fake runner (ORC-236): no model, no network, no external effect.
 * The ticket is delegated on the standard pack and the current preset; the fake agent does its job and commits,
 * and the PR the factory would open stays in the fake publisher, kept as the pass's artifact. `packDir` reads the
 * skills from another pack than the harness's, for a test that changes one.
 */
export function fakeGoldenPass({ packDir }: { packDir?: string } = {}): RunGoldenPass {
  return async (ticket: GoldenTicket): Promise<GoldenPass> => {
    const h = createHarness();
    const id = ticket.ticket;
    h.tracker.addIssue({ identifier: id, title: ticket.title, description: `${ticket.title}. Replayed from ${ticket.repo} at ${ticket.startCommit}.` });
    h.workspaces.heads.set(`/tmp/factory-fake/p/${id}`, 'golden-head');
    await h.send('ticket.delegated', { linearSessionId: `ls-${id}` }, id);
    await h.advance(60_000);
    const state = await h.ticket(id);
    const published = h.publisher.published.at(-1);
    const inputs = createHash('sha256')
      .update(canonical({ workflow: state.workflowHash, runs: h.runner.requests.map((r) => runInputs(r, packDir ?? r.pluginDir)) }))
      .digest('hex');
    return {
      verdict: published ? 'pr' : state.blocked ? 'blocked' : 'no_pr',
      inputs,
      ...(published ? { pr: { branch: published.branch, title: published.title } } : {}),
    };
  };
}
