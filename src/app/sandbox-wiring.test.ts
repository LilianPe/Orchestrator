import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instanceId } from './sandbox-wiring.js';

describe('instanceId', () => {
  it('is 12 hex chars, stable for one daemon home whatever its spelling, distinct across homes', () => {
    const home = join(process.cwd(), 'h');
    expect(instanceId(home)).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceId(join(home, '.', 'x', '..'))).toBe(instanceId(home));
    expect(instanceId(join(process.cwd(), 'other'))).not.toBe(instanceId(home));
  });
});
