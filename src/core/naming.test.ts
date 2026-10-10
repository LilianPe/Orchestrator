import { describe, expect, it } from 'vitest';
import { branchName, slugify } from './naming.js';

describe('slugify', () => {
  it('lowercases, strips accents and collapses separators', () => {
    expect(slugify('Corriger l’arrondi des Scores !')).toBe('corriger-l-arrondi-des-scores');
  });
  it('truncates without a trailing dash', () => {
    expect(slugify('a'.repeat(30) + ' ' + 'b'.repeat(30), 40)).toBe('a'.repeat(30) + '-' + 'b'.repeat(9));
  });
  it('returns "ticket" for an empty result', () => {
    expect(slugify('!!!')).toBe('ticket');
  });
});

describe('branchName', () => {
  it('prefixes with relais/ and the lowercased identifier', () => {
    expect(branchName('REL-12', 'Export CSV des audits')).toBe('relais/rel-12-export-csv-des-audits');
  });
});
