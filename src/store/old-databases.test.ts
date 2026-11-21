import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { oldDatabaseWarnings } from './old-databases.js';

describe('oldDatabaseWarnings', () => {
  it('names each SQLite file left in the home, by its presence alone, and nothing in a home without one (ORC-178)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-old-db-'));
    expect(oldDatabaseWarnings(home)).toEqual([]);
    writeFileSync(join(home, 'relais.db'), 'not a database'); // transition, à retirer
    writeFileSync(join(home, 'factory.db'), '');
    expect(oldDatabaseWarnings(home)).toEqual([
      'relais.db: left from the SQLite store, not read (ORC-178): archive it off the server, then delete it (docs/operations.md)', // transition, à retirer
      'factory.db: left from the SQLite store, not read (ORC-178): archive it off the server, then delete it (docs/operations.md)',
    ]);
  });
});
