import { describe, expect, it } from 'vitest';
import { journalSchemaOf } from './migrate.js';

describe('journalSchemaOf (ORC-334)', () => {
  it('keeps the journal of the public schema where it always was', () => {
    expect(journalSchemaOf('public')).toBe('drizzle');
  });

  it('puts the journal of another schema beside it', () => {
    expect(journalSchemaOf('tenant')).toBe('tenant_drizzle');
  });

  it('refuses a schema whose journal name Postgres would truncate', () => {
    expect(journalSchemaOf('t'.repeat(55))).toHaveLength(63);
    expect(() => journalSchemaOf('t'.repeat(56))).toThrow(/too long/);
  });
});
