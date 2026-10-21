import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const url = process.env['DATABASE_URL'] ?? '';

describe.skipIf(!url)('Postgres integration', () => {
  it('connects and round-trips a row', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('create temp table relais_ci (id integer primary key, label text not null)');
      await client.query("insert into relais_ci (id, label) values (1, 'ok')");
      const result = await client.query<{ label: string }>('select label from relais_ci where id = 1');
      expect(result.rows[0]?.label).toBe('ok');
    } finally {
      await client.end();
    }
  });
});
