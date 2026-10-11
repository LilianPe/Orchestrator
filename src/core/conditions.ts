import { isLogicalState, type LogicalState } from './types.js';

type Atom =
  | { kind: 'state_eq'; value: LogicalState; negate: boolean }
  | { kind: 'state_in'; values: LogicalState[] }
  | { kind: 'blocked'; negate: boolean }
  | { kind: 'job_eq'; value: string };

export type Condition = Atom[];

export interface ConditionContext {
  state: LogicalState;
  blocked: boolean;
  job?: string;
}

function fail(src: string): never {
  throw new Error(`invalid condition: ${src}`);
}

function state(v: string, src: string): LogicalState {
  if (!isLogicalState(v)) fail(src);
  return v;
}

function parseAtom(raw: string, src: string): Atom {
  const a = raw.trim();
  let m: RegExpExecArray | null;
  if (a === 'blocked') return { kind: 'blocked', negate: false };
  if (a === '!blocked') return { kind: 'blocked', negate: true };
  if ((m = /^state\s*(==|!=)\s*([a-z_]+)$/.exec(a))) {
    return { kind: 'state_eq', value: state(m[2]!, src), negate: m[1] === '!=' };
  }
  if ((m = /^state\s+in\s+\[([a-z_,\s]+)\]$/.exec(a))) {
    const values = m[1]!.split(',').map((v) => state(v.trim(), src));
    return { kind: 'state_in', values };
  }
  if ((m = /^job\s*==\s*([a-z0-9_-]+)$/.exec(a))) return { kind: 'job_eq', value: m[1]! };
  return fail(src);
}

export function parseCondition(src: string): Condition {
  if (/\|\|/.test(src)) fail(src);
  return src.split('&&').map((part) => parseAtom(part, src));
}

export function evalCondition(c: Condition, ctx: ConditionContext): boolean {
  return c.every((a) => {
    switch (a.kind) {
      case 'state_eq':
        return (ctx.state === a.value) !== a.negate;
      case 'state_in':
        return a.values.includes(ctx.state);
      case 'blocked':
        return ctx.blocked !== a.negate;
      case 'job_eq':
        return ctx.job === a.value;
    }
  });
}
