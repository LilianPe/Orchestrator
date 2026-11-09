import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PG_TABLES, PG_TABLE_NAMES } from './schema.js';

describe('Postgres store schema', () => {
  it('declares exactly the twelve ORC-132 tables, the three of the security log (ORC-296), the known flaky tests (ORC-164) and the baselines (ORC-230)', () => {
    expect(Object.values(PG_TABLES).map((table) => getTableName(table))).toEqual([...PG_TABLE_NAMES]);
    expect(PG_TABLE_NAMES).toHaveLength(17);
    expect(new Set(PG_TABLE_NAMES).size).toBe(17);
  });

  it('keeps pg-boss out of the dependency tree', () => {
    const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(dependencies).not.toHaveProperty('pg-boss');
    expect(dependencies).toHaveProperty('drizzle-orm');
    expect(dependencies).toHaveProperty('pg');
    expect(pkg.devDependencies).toHaveProperty('drizzle-kit');
  });
});
