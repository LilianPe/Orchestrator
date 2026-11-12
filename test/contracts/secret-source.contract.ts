import { expect } from 'vitest';
import type { SecretSource, SecretSourceKind } from '../../src/adapters/secrets/types.js';
import { describeContract, rejection, resolved, subjectWith, type ContractOptions } from './cases.js';

/** What the implementation under test arranged for the suite. Docs: docs/ports/secret-source.md. */
export interface SecretSourceSubject {
  source: SecretSource;
  /** A path the source holds, and its value. */
  present: { path: string; value: string };
  /** A valid path the source does not hold. */
  missing: string;
  /** The same source, out of service (unreachable, its credential refused); absent, the case is skipped. */
  down?: SecretSource;
  /** The adapter's kind, and a path it refuses at startup; absent, the case is skipped. */
  syntax?: { kind: SecretSourceKind; valid: string; invalid: string };
}

export function describeSecretSourceContract(name: string, make: () => SecretSourceSubject | Promise<SecretSourceSubject>, options?: ContractOptions): void {
  describeContract(`SecretSource contract: ${name}`, options, (it) => {
    it('reads the value at a path it holds', async () => {
      const s = await make();
      expect(await resolved(s.source.read(s.present.path))).toBe(s.present.value);
    });

    it('a read is replayed with the same value', async () => {
      const s = await make();
      await s.source.read(s.present.path);
      expect(await resolved(s.source.read(s.present.path))).toBe(s.present.value);
    });

    it('a path it does not hold rejects, without any value', async () => {
      const s = await make();
      const err = await rejection(s.source.read(s.missing));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(s.present.value);
    });

    it('a source out of service rejects, without any value', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'down');
      const err = await rejection(s.down.read(s.present.path));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(s.present.value);
    });

    it('its kind checks a path without reading it', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'syntax');
      expect(s.syntax.kind.checkPath(s.syntax.valid)).toBeUndefined();
      expect(s.syntax.kind.checkPath(s.syntax.invalid)).toEqual(expect.any(String));
    });
  });
}
