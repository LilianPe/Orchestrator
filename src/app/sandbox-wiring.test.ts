import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultLimits } from '../adapters/sandbox/docker-rootless.js';
import { instanceId, sandboxLimits } from './sandbox-wiring.js';

describe('instanceId', () => {
  it('is 12 hex chars, stable for one daemon home whatever its spelling, distinct across homes', () => {
    const home = join(process.cwd(), 'h');
    expect(instanceId(home)).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceId(join(home, '.', 'x', '..'))).toBe(instanceId(home));
    expect(instanceId(join(process.cwd(), 'other'))).not.toBe(instanceId(home));
  });
});

describe('sandboxLimits', () => {
  it('keeps the defaults without the variables', () => {
    expect(sandboxLimits({})).toEqual(defaultLimits());
    expect(sandboxLimits({ FACTORY_SANDBOX_PIDS: '' })).toEqual(defaultLimits());
  });

  it('takes a value per limit, and drops one on 0 or none', () => {
    expect(sandboxLimits({ FACTORY_SANDBOX_PIDS: '128', FACTORY_SANDBOX_MEMORY: '512m', FACTORY_SANDBOX_CPUS: '0.5' })).toEqual({ pids: 128, memory: '512m', cpus: 0.5 });
    expect(sandboxLimits({ FACTORY_SANDBOX_PIDS: '0', FACTORY_SANDBOX_MEMORY: 'none', FACTORY_SANDBOX_CPUS: 'NONE' })).toEqual({});
  });

  it('refuses garbage, naming the variable', () => {
    for (const [k, v] of [['FACTORY_SANDBOX_PIDS', '1.5'], ['FACTORY_SANDBOX_PIDS', '-1'], ['FACTORY_SANDBOX_MEMORY', '4 GB'], ['FACTORY_SANDBOX_MEMORY', 'lots'], ['FACTORY_SANDBOX_CPUS', 'two'], ['FACTORY_SANDBOX_CPUS', '1.']]) {
      expect(() => sandboxLimits({ [k!]: v })).toThrow(`${k}=${v}`);
    }
  });
});
