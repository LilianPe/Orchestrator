import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../../../store/sqlite-store.js';
import { knownLabels, labelChanges, recordLabels } from './labels.js';

describe('labels known to the factory (ORC-185)', () => {
  it('keeps the newest reading: an older one, a webhook out of order or a pass read before it, does not overwrite it', async () => {
    const store = new SqliteStore(':memory:');
    expect(await knownLabels(store, 'p', 'REL-1')).toBeUndefined();
    await recordLabels(store, 'p', 'REL-1', ['b', 'a', 'a'], 200);
    await recordLabels(store, 'p', 'REL-1', ['old'], 100);
    expect(await knownLabels(store, 'p', 'REL-1')).toEqual({ labels: ['a', 'b'], at: 200 });
    await recordLabels(store, 'p', 'REL-1', ['c'], 200);
    expect(await knownLabels(store, 'p', 'REL-1')).toEqual({ labels: ['c'], at: 200 });
  });

  it('reports what was added and taken off', () => {
    expect(labelChanges(['a', 'b'], ['b', 'c'])).toEqual([
      { label: 'c', change: 'added' },
      { label: 'a', change: 'removed' },
    ]);
  });
});
