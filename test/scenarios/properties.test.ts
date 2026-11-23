import { describe, expect, it } from 'vitest';
import { FREEZE_CHECK } from '../../src/checks/freeze.js';
import type { EventPayloads } from '../../src/core/types.js';
import { exportJournal } from '../../src/runtime/replay.js';
import { assessment, drafted, SPEC, toBuild } from '../helpers/chain.js';
import { createHarness, withTestCommand } from '../helpers/harness.js';

/**
 * ORC-261: the « for any input » properties of the approved spec. The factory names each one's test file, the `tests` step
 * writes it, the red check wants it, and the freeze holds it with the generators it imports.
 */
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const LEAD = 'user-lilian';
const MEMBER = 'user-armand';
const PROPERTY = { statement: 'Every exported row has as many cells as the header.', domain: 'any list of audits', target: 'toCsv' };
const ACCEPTANCE = "it('exports', () => expect(toCsv([])).toBe(''));\n";
const PROPERTY_TEST = "import fc from 'fast-check';\nimport { audits } from './arb/audits';\nit('rows', () => fc.assert(fc.property(audits, (a) => true)));\n";
const GENERATOR = "import fc from 'fast-check';\nexport const audits = fc.array(fc.record({ id: fc.nat() }));\n";
const AT_FREEZE = { 'src/export.test.ts': ACCEPTANCE, 'test/rel-1.property-1.test.ts': PROPERTY_TEST, 'test/arb/audits.ts': GENERATOR, 'src/export.ts': '' };

type Harness = ReturnType<typeof createHarness>;

/** A ticket whose spec, with `properties`, is approved; the tests step committed `changed`, the build held. */
async function approved(properties: (typeof PROPERTY)[], changed: string[], head: Record<string, string> = AT_FREEZE): Promise<Harness> {
  const h = createHarness({ authz: { maintainers: [LEAD], validators: [MEMBER], githubLogins: { [LEAD]: 'lilian-gh', [MEMBER]: 'armand-gh' } }, repoConfig: withTestCommand(), fullChain: true });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.tracker.setTeamMembers('REL', [LEAD, MEMBER]);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.forge.setRepoPermission('armand-gh', 'write');
  h.workspaces.heads.set(WORKTREE, 'sha-freeze');
  h.workspaces.steps.set(WORKTREE, { changed: changed.map((path) => ({ path, deleted: false })), head });
  h.runner.enqueue(assessment(), drafted({ ...SPEC, properties }));
  await h.send('ticket.delegated', { linearSessionId: 'as-1' }, 'REL-1', { actor: LEAD });
  await toBuild(h, { build: [{ hold: true }], actor: MEMBER, linearSessionId: 'as-1' });
  return h;
}

const verdicts = async (h: Harness) =>
  (await exportJournal(h.store, 'p', 'REL-1')).entries.flatMap((e) => (e.event.type === 'verify.failed' || e.event.type === 'verify.passed' ? [e.event.payload as EventPayloads['verify.failed']] : []));

describe('the property tests of the approved spec (ORC-261)', () => {
  it('criterion 2: the tests step is told the file of each property, and its test and generators enter the freeze', async () => {
    const h = await approved([PROPERTY], ['src/export.test.ts', 'test/rel-1.property-1.test.ts', 'test/arb/audits.ts']);
    const tests = h.runner.requests.find((r) => r.prompt.startsWith('/factory:tests'))!;
    expect(tests.prompt).toContain('## Property tests');
    expect(tests.prompt).toContain('Property 1: `rel-1.property-1.test.ts` (TypeScript, JavaScript) or `test_rel_1_property_1.py` (Python)');
    expect(Object.keys((await h.ticket()).frozenTests!.files).sort()).toEqual(['src/export.test.ts', 'test/arb/audits.ts', 'test/rel-1.property-1.test.ts']);
  });

  it('a generator the property test imports, written before the ticket, is frozen with it', async () => {
    const h = await approved([PROPERTY], ['src/export.test.ts', 'test/rel-1.property-1.test.ts']);
    expect(Object.keys((await h.ticket()).frozenTests!.files)).toContain('test/arb/audits.ts');
  });

  it('criterion 3: a commit that narrows a frozen generator fails verify', async () => {
    const h = await approved([PROPERTY], ['src/export.test.ts', 'test/rel-1.property-1.test.ts']);
    h.workspaces.heads.set(WORKTREE, 'sha-dev');
    const head = { ...AT_FREEZE, 'test/arb/audits.ts': GENERATOR.replace('fc.nat()', 'fc.constant(0)') };
    h.workspaces.steps.set(`${WORKTREE}@sha-freeze`, { changed: [{ path: 'test/arb/audits.ts', deleted: false }], head });
    h.workspaces.steps.set(`${WORKTREE}@sha-dev`, { changed: [], head });
    h.runner.release(h.runner.requests.find((r) => r.prompt.startsWith('/factory:build'))!.runId);
    await h.orch.drained();
    expect((await verdicts(h)).flatMap((v) => v.failures?.map((f) => f.command) ?? [])).toContain(FREEZE_CHECK);
  });

  it('an approved property left without its test: the red check says so, measured like any red (the run goes on)', async () => {
    const { 'test/rel-1.property-1.test.ts': _, ...without } = AT_FREEZE;
    const h = await approved([PROPERTY], ['src/export.test.ts'], without);
    const red = (await verdicts(h)).find((v) => v.red !== undefined)!;
    expect(red.red).toBe('missing_property');
    expect(red.failures[0]!.output).toContain('rel-1.property-1.test.ts');
    expect(h.runner.requests.some((r) => r.prompt.startsWith('/factory:build'))).toBe(true);
  });

  it('criterion 5: a spec without properties asks for none, and the run goes on to the build', async () => {
    const h = await approved([], ['src/export.test.ts']);
    expect(h.runner.requests.find((r) => r.prompt.startsWith('/factory:tests'))!.prompt).not.toContain('## Property tests');
    expect((await verdicts(h)).find((v) => v.red !== undefined)!.red).toBe('assertion');
    expect(h.runner.requests.some((r) => r.prompt.startsWith('/factory:build'))).toBe(true);
  });
});
