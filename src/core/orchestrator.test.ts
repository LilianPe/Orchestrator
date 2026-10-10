import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeForge } from '../adapters/forge/fake.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { EventBus } from './bus.js';
import { FakeClock } from './clock.js';
import { Orchestrator } from './orchestrator.js';
import { Scheduler } from './scheduler.js';
import type { RelaisEvent } from './types.js';

function setup() {
  const packDir = join(import.meta.dirname, '../../packs/standard');
  const workflow = loadWorkflow({ packDir });
  const store = new SqliteStore(':memory:');
  const tracker = new FakeTracker();
  const runner = new FakeRunner();
  let n = 0;
  const orch = new Orchestrator({
    store, clock: new FakeClock(1_000), bus: new EventBus(), scheduler: new Scheduler(store, { dev: 3, questions: 2 }),
    tracker, forge: new FakeForge(), runner, workspaces: new FakeWorkspaces(), verify: async () => ({ ok: true, failures: [] }),
    projects: [{ id: 'p', repoPath: '/repo', teamKey: 'REL', workflow }], packDir,
    agentEnv: (r) => ({ RELAIS_RUN_TOKEN: r.token }), newId: () => `id-${++n}`, activityIntervalMs: 0,
  });
  return { store, tracker, runner, orch };
}

const delegated = (id = 'e1'): RelaisEvent => ({ id, type: 'ticket.delegated', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });

describe('Orchestrator', () => {
  it('ignores a duplicate event id', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.submit(delegated());
    await orch.idle();
    expect(runner.requests).toHaveLength(1);
  });

  it('ignores moves of tickets it does not manage', async () => {
    const { store, orch } = setup();
    await orch.submit({ id: 'm', type: 'ticket.moved', at: 1, projectId: 'p', ticketId: 'REL-9', payload: { from: 'todo', to: 'dev' } });
    await orch.idle();
    expect(store.getTicket('p', 'REL-9')).toBeUndefined();
  });

  it('passes the pack, settings and agent env to the runner', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.idle();
    const r = runner.requests[0]!;
    expect(r.pluginDir.endsWith('packs/standard')).toBe(true);
    expect(r.settingsPath.endsWith('packs/standard/settings.json')).toBe(true);
    expect(r.env['RELAIS_RUN_TOKEN']).toBeDefined();
    expect(r.env['PORT']).toBe('4200');
  });

  it('recover() blocks tickets whose run was interrupted', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    runner.enqueue({ hold: true });
    await orch.submit(delegated());
    orch.recover();
    const t = store.getTicket('p', 'REL-1')!;
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
    expect(store.runsByStatus('running')).toEqual([]);
  });
});
