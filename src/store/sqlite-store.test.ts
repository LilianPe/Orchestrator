import { describe } from 'vitest';
import { storeContract } from '../../test/helpers/store-suite.js';
import { SqliteStore } from './sqlite-store.js';

// The six cases live in the shared Store contract, also run on PgStore (test/integration/pg-store.test.ts).
describe('SqliteStore', () => {
  storeContract(() => new SqliteStore(':memory:'));
});
