const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(s: string | number): number {
  if (typeof s === 'number') return s;
  const m = /^(\d+)(ms|s|m|h)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s}`);
  return Number(m[1]) * UNITS[m[2]!]!;
}
