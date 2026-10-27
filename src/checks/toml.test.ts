import { describe, expect, it } from 'vitest';
import { parseToml, TomlError } from './toml.js';

describe('parseToml', () => {
  it('reads tables, dotted keys, strings, arrays and inline tables', () => {
    const doc = parseToml(`
# comment
title = "a \\"quoted\\" \\u00e9"
project.name = 'lit\\eral'
[tool.poetry.group."dev".dependencies]
black = { version = "^24", extras = ["d"] }   # trailing
[[tool.x]]
n = 1
[[tool.x]]
n = 2
[multi]
s = """
line1
line2"""
l = '''raw\\n'''
arr = [
  "a", # one
  [1, 2],
  { k = true },
]
when = 1979-05-27T07:32:00Z
`);
    expect(doc).toEqual({
      title: 'a "quoted" é',
      project: { name: 'lit\\eral' },
      tool: { poetry: { group: { dev: { dependencies: { black: { version: '^24', extras: ['d'] } } } } }, x: [{ n: '1' }, { n: '2' }] },
      multi: { s: 'line1\nline2', l: 'raw\\n', arr: ['a', ['1', '2'], { k: 'true' }], when: '1979-05-27T07:32:00Z' },
    });
  });

  it('throws with the line on what it cannot read', () => {
    expect(() => parseToml('[project\nx = 1')).toThrow(TomlError);
    expect(() => parseToml('a = 1\nb = "x')).toThrow(/line 2/);
    expect(() => parseToml('a = 1\na = 2')).toThrow(/duplicate key/);
    expect(() => parseToml('a = [1 2]')).toThrow(/expected ','/);
  });
});
