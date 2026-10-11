import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

describe('VERSION', () => {
  it('matches package.json', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    expect(VERSION).toBe(pkg.default.version);
  });
});
