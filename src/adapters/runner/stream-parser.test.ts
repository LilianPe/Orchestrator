import { describe, expect, it } from 'vitest';
import { parseStreamLine, parseUsage, summarizeToolInput } from './stream-parser.js';

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
  it('reads the token usage of the result line, and only a well-formed one (ORC-235)', () => {
    const usage = '"usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":56}';
    expect(parseStreamLine(`{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.4,"num_turns":3,"result":"ok",${usage}}`)).toEqual([
      { kind: 'result', isError: false, costUsd: 0.4, turns: 3, text: 'ok', tokens: { input: 12, output: 56, cacheRead: 4000, cacheCreation: 300 } },
    ]);
    // Cache counts are optional; a usage without input or output counts is no report.
    expect(parseUsage({ input_tokens: 1, output_tokens: 2 })).toEqual({ input: 1, output: 2, cacheRead: 0, cacheCreation: 0 });
    expect(parseUsage({ output_tokens: 2 })).toBeUndefined();
    expect(parseUsage('12 tokens')).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
    // The agent's text announcing a usage is not one.
    expect(parseStreamLine('{"type":"result","subtype":"success","result":"usage: 10 input_tokens"}')[0]).not.toHaveProperty('tokens');
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
