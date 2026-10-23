import { expect, it as vitestIt, type TestContext } from 'vitest';

/** A fresh subject that carries the optional fields a case needs; without them, the case is skipped. */
export async function subjectWith<S, K extends keyof S>(
  make: () => S | Promise<S>,
  skip: () => void,
  ...keys: K[]
): Promise<S & Required<Pick<S, K>>> {
  const s = await make();
  if (keys.some((k) => s[k] === undefined)) skip();
  return s as S & Required<Pick<S, K>>;
}

export interface ContractOptions {
  /**
   * Turns the suite into a negative control: the subject breaks these cases on purpose, only they run,
   * and each passes only if the case fails on an assertion.
   */
  violates?: string[];
}

type CaseBody = (ctx: TestContext) => unknown;

/**
 * The `it` of a contract suite, and `end`, to call once every case is declared: it rejects a `violates`
 * entry that names no case, so a renamed case cannot turn its negative control into a silent no-op.
 */
export function contractCases({ violates }: ContractOptions = {}): { it: (name: string, body: CaseBody) => void; end: () => void } {
  const declared = new Set<string>();
  const it = (name: string, body: CaseBody): void => {
    declared.add(name);
    if (!violates) return void vitestIt(name, body);
    if (!violates.includes(name)) return;
    vitestIt(`${name} (negative control)`, async (ctx) => {
      await expect((async () => body(ctx))()).rejects.toMatchObject({ name: 'AssertionError' });
    });
  };
  const end = (): void => {
    const unknown = (violates ?? []).filter((n) => !declared.has(n));
    if (unknown.length) throw new Error(`violates names no case of the suite: ${unknown.join(', ')}`);
  };
  return { it, end };
}
