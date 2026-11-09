import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUIREMENTS, type Sandbox } from '../../src/adapters/sandbox/types.js';
import { holdsSecret, POSTGRES_DUMP } from '../../src/core/sealed-setup.js';
import { cli, enabled, useSandboxes } from './helpers.js';

const PG = { ...DEFAULT_REQUIREMENTS, services: ['postgres'] };
const SECRET = 'iso-309-secret-value';

/**
 * An attempt's services (ORC-309), on the real engine: Postgres in a network of its own without route, the attempt's
 * sandboxes on its loopback, `DATABASE_URL` made by the factory, nothing reachable from another attempt.
 */
describe.skipIf(!enabled)(`an attempt's Postgres (${cli}, ORC-309)`, () => {
  const { provider, request, sh } = useSandboxes('309');
  const running = (label: string) => execFileSync(cli, ['ps', '-q', '--filter', `label=${label}`], { encoding: 'utf8' }).trim();
  /** `psql` in the service's own container, through TCP on the loopback its sandboxes share, as `url` says. */
  const psql = (box: Sandbox, url: string, sql: string) => provider.exec(box.services!, ['psql', url, '-tAc', sql], { cwd: '/' });
  const urlOf = async (box: Sandbox) => (await sh(box.id, 'printf %s "$DATABASE_URL"')).stdout;

  it("gives the setup and then the agent the attempt's database, through DATABASE_URL, password required", async () => {
    const attempt = request();
    const setup = await provider.create({ ...attempt, runId: `${attempt.runId}-setup`, servicesOf: attempt.runId, requirements: PG });
    const url = await urlOf(setup);
    expect(url).toMatch(/^postgres:\/\/factory:[0-9a-f]{48}@127\.0\.0\.1:5432\/factory$/);
    // The sandbox reaches it on its own loopback.
    expect((await sh(setup.id, 'exec 3<>/dev/tcp/127.0.0.1/5432 && echo open')).stdout).toBe('open');
    expect((await psql(setup, url, 'create table t (v text); insert into t values (1)')).code).toBe(0);
    expect((await psql(setup, url.replace(/:[0-9a-f]{48}@/, ':wrong@'), 'select 1')).code).not.toBe(0);
    // No superuser: nothing the setup starts in the service's container would outlive its own.
    expect((await psql(setup, url, 'select rolsuper from pg_roles where rolname = current_user')).stdout.trim()).toBe('f');
    expect((await psql(setup, url, "copy (select 1) to program 'true'")).code).not.toBe(0);
    await provider.destroy(setup.id);

    const agent = await provider.create({ ...attempt, requirements: PG });
    expect(agent.services).toBe(setup.services);
    expect(await urlOf(agent)).toBe(url);
    expect((await psql(agent, url, 'select v from t')).stdout.trim()).toBe('1');
    await provider.destroy(agent.id);
    expect(running(`factory.services=${attempt.runId}`)).toBe('');
  });

  it("two attempts at once: neither reaches the other's database", async () => {
    const [a, b] = await Promise.all([provider.create(request({ requirements: PG })), provider.create(request({ requirements: PG }))]);
    expect(a.services).not.toBe(b.services);
    expect((await psql(a, await urlOf(a), 'create table only_a (v int)')).code).toBe(0);
    // The same address leads each to its own server: b's password is refused by a's, b's server has no such table.
    expect((await psql(a, await urlOf(b), 'select 1')).code).not.toBe(0);
    expect((await psql(b, await urlOf(b), 'select count(*) from only_a')).code).not.toBe(0);
  });

  it('the service has no route out: only the loopback, no default route, no name resolved', async () => {
    const box = await provider.create(request({ requirements: PG }));
    const inService = (script: string) => provider.exec(box.services!, ['sh', '-c', script], { cwd: '/' });
    expect((await inService("awk 'NR>2 {print $1}' /proc/net/dev")).stdout.trim()).toBe('lo:');
    expect((await inService("awk 'NR>1' /proc/net/route")).stdout.trim()).toBe('');
    expect((await inService('getent hosts example.com')).code).not.toBe(0);
    // The sandbox shares that loopback and nothing else.
    expect((await sh(box.id, "awk 'NR>2 {print $1}' /proc/net/dev")).stdout).toBe('lo:');
  });

  it("the sandbox's only new variable is DATABASE_URL, to a throwaway database: no credential of the daemon", async () => {
    const plain = await provider.create(request());
    const withPg = await provider.create(request({ requirements: PG }));
    const names = async (box: Sandbox) => (await sh(box.id, 'env | cut -d= -f1 | sort')).stdout.split('\n');
    const before = await names(plain);
    expect((await names(withPg)).filter((n) => !before.includes(n))).toEqual(['DATABASE_URL']);
  });

  it("the factory's dump finds a secret written in the database", async () => {
    const box = await provider.create(request({ requirements: PG }));
    expect((await psql(box, await urlOf(box), `create table s (v text); insert into s values ('${SECRET}')`)).code).toBe(0);
    const dump = await provider.exec(box.services!, POSTGRES_DUMP, { cwd: '/' });
    expect(dump.code).toBe(0);
    expect(holdsSecret(Buffer.from(dump.stdout), SECRET)).toBe(true);
  });

  it('a daemon restart finds the services under the attempt they serve, for recover() to destroy', async () => {
    const attempt = request();
    const setup = await provider.create({ ...attempt, runId: `${attempt.runId}-setup`, servicesOf: attempt.runId, requirements: PG });
    await provider.destroy(setup.id);
    const listed = (await provider.list()).find((x) => x.sandbox.id === setup.services);
    expect(listed?.runId).toBe(attempt.runId);
    await provider.destroy(listed!.sandbox.id);
    expect(running(`factory.services=${attempt.runId}`)).toBe('');
  });
});
