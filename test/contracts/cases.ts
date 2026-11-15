import { describe, expect, it as vitestIt, type TestContext } from 'vitest';

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

/** What `p` resolves to. A port call that must answer and rejects instead fails the case on an assertion, not on the subject's error. */
export function resolved<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => expect.fail(`expected an answer, got a rejection: ${String(e)}`));
}

/** What `p` rejects with. A port call that must reject and answers instead fails the case on an assertion. */
export function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => expect.fail('expected a rejection'),
    (e: unknown) => e,
  );
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
 * The body of a negative control: it passes only if the case fails on an assertion. A missing subject field
 * fails it too, instead of skipping it as `ctx.skip` would.
 */
export function asNegativeControl(body: CaseBody): CaseBody {
  return async (ctx) => {
    const skip = () => {
      throw new Error('negative control: the subject lacks a field the case needs');
    };
    await expect(Promise.resolve().then(() => body(Object.create(ctx, { skip: { value: skip } }) as TestContext))).rejects.toMatchObject({
      name: 'AssertionError',
    });
  };
}

/**
 * The `it` of a contract suite, and `end`, to call once every case is declared: it rejects a `violates`
 * entry that names no case, so a renamed case cannot turn its negative control into a silent no-op.
 * Suites use it through `describeContract`, which calls `end`.
 */
export function contractCases({ violates }: ContractOptions = {}): { it: (name: string, body: CaseBody) => void; end: () => void } {
  if (violates?.length === 0) throw new Error('violates names no case: an empty list would run no case at all');
  const declared = new Set<string>();
  const it = (name: string, body: CaseBody): void => {
    declared.add(name);
    if (!violates) return void vitestIt(name, body);
    if (!violates.includes(name)) return;
    vitestIt(`${name} (negative control)`, asNegativeControl(body));
  };
  const end = (): void => {
    const unknown = (violates ?? []).filter((n) => !declared.has(n));
    if (unknown.length) throw new Error(`violates names no case of the suite: ${unknown.join(', ')}`);
  };
  return { it, end };
}

/** A contract suite: `define` declares its cases with the `it` it is given. */
export function describeContract(title: string, options: ContractOptions | undefined, define: (it: (name: string, body: CaseBody) => void) => void): void {
  describe(title, () => {
    const { it, end } = contractCases(options);
    define(it);
    end();
  });
}
