import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { causeOf } from '../../src/core/block-cause.js';
import { createHarness } from '../helpers/harness.js';

/** A repository that makes delegation start with `intake` (ORC-206). */
const INTAKE_FIRST = `version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: intake }
`;
const DESCRIPTION = 'Export the audits as CSV from the audit list.\n\nAcceptance criteria:\n1. A CSV button downloads the list.';
const PR = 'https://github.com/acme/app/pull/12';

/** What intake submits: complete, size `s`, low risk, no screen, unless `patch` says otherwise. */
const assessment = (patch: Partial<NonNullable<AgentOutput['intake']>> = {}) => ({
  output: {
    status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [],
    intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false, ...patch },
  } satisfies AgentOutput,
});
const DEV = { events: [{ kind: 'text' as const, text: 'Done.' }] };
const skills = (h: ReturnType<typeof createHarness>) => h.runner.requests.map((r) => r.prompt.split('\n')[0]);

function harness() {
  const h = createHarness({ projectYaml: INTAKE_FIRST });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
  return h;
}

describe('intake: duplicates (ORC-207)', () => {
  it('an open PR on the same files: intake reads it with its files, the guard blocks the run with its link', async () => {
    const h = harness();
    h.forge.openPullRequests = [{ number: 12, url: PR, title: 'CSV export of audits', branch: 'feat/csv', files: ['src/audits/export.ts', 'src/audits/list.tsx'] }];
    h.forge.branchNames = ['main', 'feat/csv', 'wip/other'];
    h.tracker.addIssue({ identifier: 'REL-9', title: 'Export CSV of the audits, again', description: DESCRIPTION });
    h.runner.enqueue(assessment({ duplicates: [{ url: PR, why: 'PR #12 changes src/audits/export.ts for the same export.' }] }), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });

    // What the factory read of the work in progress is in intake's prompt: the PR with its files, the branches, the close ticket.
    const prompt = h.runner.requests[0]!.prompt;
    expect(prompt).toContain(PR);
    expect(prompt).toContain('src/audits/export.ts');
    expect(prompt).toContain('wip/other');
    expect(prompt).toContain('REL-9');
    expect(prompt).not.toContain('- REL-1 (');

    expect(skills(h)).toEqual(['/factory:intake']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake', logical: 'todo' });
    expect(causeOf(t.blockKind)).toBe('pickup');
    expect(t.blockReason).toContain(PR);
    expect(h.tracker.comments('REL-1').at(-1)).toContain(PR);
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo')).toEqual([]);
  });

  it("the ticket's own branch already on the forge blocks it with the link, whatever intake judged (not_started, absorbed)", async () => {
    const h = harness();
    h.forge.branchNames = ['factory/rel-1-export-csv'];
    h.forge.openPullRequests = [{ number: 3, url: 'https://github.com/acme/app/pull/3', title: 'REL-1', branch: 'factory/rel-1-export-csv', files: ['a.ts'] }];
    h.runner.enqueue(assessment(), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:intake']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake' });
    expect(t.blockReason).toContain('https://github.com/acme/app/pull/3');
  });

  it('a forge that cannot be read starts no intake that would see no duplicate', async () => {
    const h = harness();
    h.forge.offline = true;
    h.runner.enqueue(assessment(), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toEqual([]);
  });

  it('without intake, the pickup job still refuses a ticket whose branch is on the forge (the pack: not_started)', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
    h.forge.branchNames = ['factory/rel-1-old'];
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toEqual([]);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(t.blockReason).toContain('https://github.test/acme/app/tree/factory/rel-1-old');
  });
});

describe('intake: existing code to reuse (ORC-207)', () => {
  it('the functions intake found close to the request are in build\'s inputs as leads to reuse', async () => {
    const h = harness();
    h.runner.enqueue(assessment({ reuse: [{ path: 'src/csv.ts', symbol: 'toCsv', why: 'Already writes a CSV line, quoting included.' }] }), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:intake', '/factory:dev']);
    const build = h.runner.requests[1]!.prompt;
    expect(build).toContain('## Existing code to reuse');
    expect(build).toContain('`src/csv.ts` (`toCsv`): Already writes a CSV line, quoting included.');
  });
});

describe('intake: scope (ORC-207)', () => {
  it('a big refactor is refused with its explanation and the split proposed, no ticket created, nothing started', async () => {
    const h = harness();
    h.runner.enqueue(assessment({ size: 'xl', scope: { refuse: 'A refactor of every adapter: too big for one PR.', split: [{ title: 'Port the forge adapters', summary: 'GitHub and gh first.' }] } }), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:intake']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake', logical: 'todo' });
    const comment = h.tracker.comments('REL-1').at(-1)!;
    expect(comment).toContain('A refactor of every adapter: too big for one PR.');
    expect(comment).toContain('Port the forge adapters');
    expect(h.tracker.calls.map((c) => c.method)).not.toContain('createIssue');
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo')).toEqual([]);
  });
});
