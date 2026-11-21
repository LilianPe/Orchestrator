import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATABASE_URL_ENV, openStore } from './open.js';

describe('openStore', () => {
  it.each([{}, { [DATABASE_URL_ENV]: '' }, { [DATABASE_URL_ENV]: '  ' }, { NODE_ENV: 'production', FACTORY_STORE: 'sqlite' }])(
    'refuses to open without a Postgres URL, whatever else is set: Postgres is the only store (ORC-178) (%o)',
    async (env) => {
      await expect(openStore({ env, migrationsFolder: '/nowhere' })).rejects.toThrow(
        `${DATABASE_URL_ENV} is not set: the factory keeps its state in Postgres only. Set it to the Postgres URL.`,
      );
    },
  );

  it('fails to start when Postgres is unreachable', async () => {
    const env = { [DATABASE_URL_ENV]: 'postgres://nobody:secret@127.0.0.1:1/none' };
    await expect(openStore({ env, migrationsFolder: join(import.meta.dirname, '../../drizzle') })).rejects.toThrow();
  });
});
