import type { RunStreamEvent } from './types.js';

export function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'pattern', 'url', 'path']) if (typeof o[k] === 'string') return (o[k] as string).slice(0, 200);
  }
  return (JSON.stringify(input) ?? '').slice(0, 200);
}

function blocks(obj: any): any[] {
  const c = obj?.message?.content;
  return Array.isArray(c) ? c : [];
}

export function parseStreamLine(line: string): RunStreamEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  switch (obj?.type) {
    case 'system':
      return obj.subtype === 'init' && obj.session_id ? [{ kind: 'init', sessionId: obj.session_id }] : [];
    case 'assistant': {
      const out: RunStreamEvent[] = [];
      for (const b of blocks(obj)) {
        if (b?.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text });
        if (b?.type === 'tool_use') out.push({ kind: 'tool', name: String(b.name), input: summarizeToolInput(b.input) });
      }
      return out;
    }
    case 'user':
      return blocks(obj)
        .filter((b: any) => b?.type === 'tool_result')
        .map((b: any) => ({ kind: 'tool_result', isError: !!b.is_error }) as RunStreamEvent);
    case 'result':
      return [
        {
          kind: 'result',
          isError: obj.is_error ?? obj.subtype !== 'success',
          costUsd: obj.total_cost_usd ?? 0,
          turns: obj.num_turns ?? 0,
          text: typeof obj.result === 'string' ? obj.result : '',
        },
      ];
    default:
      return [];
  }
}
