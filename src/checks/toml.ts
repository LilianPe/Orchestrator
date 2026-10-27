/**
 * Minimal TOML reader for the dependency check: enough of TOML 1.0 to read `pyproject.toml`
 * (tables, array tables, dotted keys, strings, arrays, inline tables). Numbers, booleans and dates
 * are kept as their raw text: the check never reads them. Anything it does not understand throws
 * `TomlError`, and the check then blocks on the manifest instead of guessing.
 */
export class TomlError extends Error {
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = 'TomlError';
  }
}

export type TomlValue = string | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/** Number, boolean, date or time, read in place (sticky: no copy of the rest of the file). */
const SCALAR = /[A-Za-z0-9_:.+-]+(?: [0-9]{2}:[0-9:.+\-Z]*)?/y;

export const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseToml(text: string): TomlTable {
  const src = text.replace(/\r\n/g, '\n');
  let i = 0;
  const root: TomlTable = {};
  let current = root;

  const line = (): number => src.slice(0, i).split('\n').length;
  // A declaration, not an arrow in a const: TypeScript narrows after a call to it.
  function fail(message: string): never {
    throw new TomlError(message, line());
  }
  const skipSpaces = (): void => {
    while (src[i] === ' ' || src[i] === '\t') i++;
  };
  const skipComment = (): void => {
    if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
  };
  // Whitespace, newlines and comments, as allowed inside arrays.
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (src[i] !== '\n') return;
      i++;
    }
  };
  const endOfLine = (): void => {
    skipSpaces();
    skipComment();
    if (i < src.length && src[i] !== '\n') fail(`unexpected '${src[i]}'`);
  };

  const basicString = (): string => {
    const multi = src.startsWith('"""', i);
    i += multi ? 3 : 1;
    if (multi && src[i] === '\n') i++;
    let out = '';
    for (;;) {
      if (i >= src.length) fail('unterminated string');
      const c = src[i]!;
      if (multi ? src.startsWith('"""', i) && !src.startsWith('""""', i) : c === '"') {
        i += multi ? 3 : 1;
        return out;
      }
      if (c === '\n' && !multi) fail('newline in string');
      if (c === '\\') {
        const e = src[i + 1] ?? '';
        if (multi && /[ \t\n]/.test(e)) {
          // Line-ending backslash: trim up to the next non-blank character.
          i++;
          while (/[ \t\n]/.test(src[i] ?? '')) i++;
          continue;
        }
        if (e === 'u' || e === 'U') {
          const hex = src.slice(i + 2, i + (e === 'u' ? 6 : 10));
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== (e === 'u' ? 4 : 8)) fail('bad unicode escape');
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + hex.length;
          continue;
        }
        const mapped = ESCAPES[e];
        if (mapped === undefined) fail(`bad escape '\\${e}'`);
        out += mapped;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
  };

  const literalString = (): string => {
    const multi = src.startsWith("'''", i);
    i += multi ? 3 : 1;
    if (multi && src[i] === '\n') i++;
    const end = src.indexOf(multi ? "'''" : "'", i);
    if (end === -1) fail('unterminated string');
    const out = src.slice(i, end);
    if (!multi && out.includes('\n')) fail('newline in string');
    i = end + (multi ? 3 : 1);
    return out;
  };

  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      if (src[i] === '"') parts.push(basicString());
      else if (src[i] === "'") parts.push(literalString());
      else {
        const start = i;
        while (i < src.length && BARE_KEY.test(src[i]!)) i++;
        if (i === start) fail('expected a key');
        parts.push(src.slice(start, i));
      }
      skipSpaces();
      if (src[i] !== '.') return parts;
      i++;
    }
  };

  const tableAt = (from: TomlTable, path: string[]): TomlTable => {
    let t = from;
    for (const k of path) {
      const next = t[k];
      if (next === undefined) t = t[k] = {};
      else if (isTable(next)) t = next;
      else {
        const last = Array.isArray(next) ? next.at(-1) : undefined;
        if (isTable(last)) t = last;
        else fail(`'${k}' is not a table`);
      }
    }
    return t;
  };

  const assign = (into: TomlTable, path: string[], v: TomlValue): void => {
    const t = tableAt(into, path.slice(0, -1));
    const last = path[path.length - 1]!;
    if (last in t) fail(`duplicate key '${last}'`);
    t[last] = v;
  };

  const value = (): TomlValue => {
    skipSpaces();
    const c = src[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        skipBlank();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail("expected ',' or ']'");
      }
    }
    if (c === '{') {
      i++;
      const t: TomlTable = {};
      skipSpaces();
      if (src[i] === '}') {
        i++;
        return t;
      }
      for (;;) {
        const k = key();
        if (src[i] !== '=') fail("expected '='");
        i++;
        assign(t, k, value());
        skipSpaces();
        if (src[i] === '}') {
          i++;
          return t;
        }
        if (src[i] !== ',') fail("expected ',' or '}'");
        i++;
      }
    }
    // Number, boolean, date or time: kept as raw text.
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(src);
    if (!m) fail('expected a value');
    i += m[0].length;
    return m[0];
  };

  while (i < src.length) {
    skipBlank();
    if (i >= src.length) break;
    if (src[i] === '[') {
      const isArray = src[i + 1] === '[';
      const close = isArray ? ']]' : ']';
      i += close.length;
      const path = key();
      if (!src.startsWith(close, i)) fail('unterminated table header');
      i += close.length;
      if (isArray) {
        const parent = tableAt(root, path.slice(0, -1));
        const last = path[path.length - 1]!;
        const list = parent[last] ?? (parent[last] = []);
        if (!Array.isArray(list)) fail(`'${last}' is not an array of tables`);
        const t: TomlTable = {};
        list.push(t);
        current = t;
      } else current = tableAt(root, path);
      endOfLine();
      continue;
    }
    const k = key();
    if (src[i] !== '=') fail("expected '='");
    i++;
    assign(current, k, value());
    endOfLine();
  }
  return root;
}
