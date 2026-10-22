import { it } from 'vitest';

/**
 * A known gap is a case of the contract that an implementation does not meet yet. The case runs as `it.fails`:
 * it stays green while the gap exists and turns red the day the implementation aligns, so the gap list cannot rot.
 */
export function caseFor<G extends string>(gaps: readonly G[] | undefined, gap: G): typeof it | typeof it.fails {
  return gaps?.includes(gap) ? it.fails : it;
}

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
