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
