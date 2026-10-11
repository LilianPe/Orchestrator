import { describe, expect, it } from 'vitest';
import { parseStreamLine, summarizeToolInput } from './stream-parser.js';

describe('parseStreamLine', () => {
  it('parses init, assistant blocks, tool results and result', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s-1"}')).toEqual([{ kind: 'init', sessionId: 's-1' }]);
    expect(
      parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}'),
    ).toEqual([{ kind: 'text', text: 'a' }, { kind: 'tool', name: 'Bash', input: 'ls' }]);
    expect(parseStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","is_error":true}]}}')).toEqual([{ kind: 'tool_result', isError: true }]);
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.4,"num_turns":3,"result":"ok"}')).toEqual([
      { kind: 'result', isError: false, costUsd: 0.4, turns: 3, text: 'ok' },
    ]);
  });
  it('ignores garbage and unknown types', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine('{"type":"stream_event"}')).toEqual([]);
  });
});

describe('summarizeToolInput', () => {
  it.each([
    [{ command: 'npm test' }, 'npm test'],
    [{ file_path: '/a/b.ts', content: 'x' }, '/a/b.ts'],
    [{ pattern: 'TODO' }, 'TODO'],
    [{ other: 1 }, '{"other":1}'],
  ])('%j', (input, out) => expect(summarizeToolInput(input)).toBe(out));
});

describe('parseStreamLine totality', () => {
  it('never throws on valid-but-unexpected JSON', () => {
    expect(parseStreamLine('{"type":"user","message":{"content":"plain string"}}')).toEqual([]);
    expect(parseStreamLine('{"type":"user","message":{"content":[null,{"type":"tool_result"}]}}')).toEqual([{ kind: 'tool_result', isError: false }]);
    expect(parseStreamLine('{"type":"assistant","message":{"content":[null,{"type":"tool_use","name":"X"}]}}')).toEqual([{ kind: 'tool', name: 'X', input: '' }]);
    expect(parseStreamLine('{"type":"assistant"}')).toEqual([]);
    expect(parseStreamLine('{"type":"assistant","message":{"content":"str"}}')).toEqual([]);
    expect(parseStreamLine('null')).toEqual([]);
    expect(parseStreamLine('42')).toEqual([]);
  });
});
