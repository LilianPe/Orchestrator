# Relais MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Relais, a local-first orchestrator that takes Linear tickets delegated to its app user, runs one Claude Code session per ticket in an isolated git worktree, routes the ticket through human review then AI review, and exposes a live local dashboard.

**Architecture:** A single Node process. Events (Linear webhooks relayed by smee, GitHub polling via `gh`, timers, UI) are normalised, deduplicated in a `node:sqlite` store, and fed to a pure `decide()` function driven by a YAML workflow; the resulting commands are executed by adapters (Tracker=Linear, Forge=gh CLI, Runner=Claude Code CLI, Workspace=git worktrees). Business logic lives in a Claude Code plugin ("pack") loaded with `--plugin-dir`.

**Tech Stack:** Node 24 (ESM, TypeScript strict, `tsx` for dev), `node:sqlite`, Hono + `@hono/node-server`, zod, yaml, eventsource, graphql (schema validation only), Vitest, React 18 + Vite 6 for the UI.

**Spec:** `docs/superpowers/specs/2026-10-10-relais-mvp-design.md`

## Global Constraints

- Node `>=24`, `"type": "module"`, TypeScript `strict` + `noUncheckedIndexedAccess`, `module`/`moduleResolution` `NodeNext`: relative imports end in `.js`.
- No native npm dependencies (no better-sqlite3, no node-gyp): SQLite is `node:sqlite` (`DatabaseSync`).
- Code, identifiers, comments and commit messages in English. Every text Relais posts to Linear (activities, comments) is in French.
- Never pass `--bare` to `claude`. Always pass `--plugin-dir <pack>`, `--settings <pack>/settings.json`, `--setting-sources project,local`.
- Unit tests never spawn the real `claude` binary or call the real Linear/GitHub APIs. Live checks are gated by env vars (`LINEAR_API_KEY`, `RELAIS_E2E=1`) and skipped otherwise.
- The Linear access token never leaves the daemon: it is never logged, never put in a run's environment, never sent to the UI.
- Default port `4100`, default home `~/.relais` (override `RELAIS_HOME`), default state names: `Todo`, `In Progress`, `Human Review`, `AI Review`, `Ready to Merge`, `Done`.
- Subagents run **scoped** tests only (`npx vitest run <file>`). Never run the full suite, `npm run lint`, `npm run typecheck` or `git push` inside a task: the controller runs them once per milestone (WSL RAM limit).
- Workflow YAML keys: rule filters `from`, `to`, `label`, `say`, `when`; rule actions `run`, `debounce`, `move`, `labels`, `comment`, `do`. (`labels` is the label-edit action; `label` is the `label.added` filter.)

## Branches and worktrees

Each milestone is a branch in its own worktree, stacked on the previous milestone, with a PR whose base is the previous milestone branch. The human merges.

| Milestone | Tasks | Branch | Base |
|---|---|---|---|
| M0 Bootstrap | 1 | `m0-bootstrap` | `main` |
| M1 Core | 2–8 | `m1-core` | `m0-bootstrap` |
| M2 Orchestrator | 9–12 | `m2-orchestrator` | `m1-core` |
| M3 Linear | 13–15 | `m3-linear` | `m2-orchestrator` |
| M4 Server & relay | 16–18 | `m4-server` | `m3-linear` |
| M5 Workspaces & forge | 19–20 | `m5-workspace-forge` | `m4-server` |
| M6 Runner | 21 | `m6-runner` | `m5-workspace-forge` |
| M7 Pack | 22 | `m7-pack` | `m6-runner` |
| M8 CLI | 23 | `m8-cli` | `m7-pack` |
| M9 UI | 24 | `m9-ui` | `m8-cli` |
| M10 Knowledge | 25 | `m10-knowledge` | `m9-ui` |
| M11 Deploy & recette | 26 | `m11-deploy` | `m10-knowledge` |

Worktree path: `/home/lilian/perso/relais-wt/<branch>`. Create with `git -C /home/lilian/perso/orchestrateur worktree add /home/lilian/perso/relais-wt/<branch> -b <branch> <base>`, then `npm ci` inside it (from M1 on).

Milestone gate (controller only, after the milestone's last task): `npm run typecheck && npm run lint && npm test`, then `git push -u origin <branch>` and `gh pr create --base <base> --title "<Milestone>" --body "<tasks list>"`.

## File map

```
package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, eslint.config.js, .github/workflows/ci.yml
bin/relais, bin/relais-agent          shell shims (dist if built, else tsx); bin/ is put on the agent's PATH
src/version.ts
src/core/types.ts                     LogicalState, events, TicketState, FeedbackItem
src/core/commands.ts                  Command union
src/core/clock.ts                     Clock, SystemClock, FakeClock
src/core/naming.ts                    slugify, branchName
src/core/duration.ts                  parseDuration
src/core/conditions.ts                when: mini-language
src/core/engine.ts                    decide()
src/core/prompt.ts                    buildPrompt, formatFeedback, formatVerifyFailures
src/core/scheduler.ts                 slots + persisted queue
src/core/timers.ts                    TimerService (debounce)
src/core/bus.ts                       EventBus (SSE fan-out)
src/core/verify.ts                    runVerify
src/core/pickup.ts                    PickupChecker
src/core/orchestrator.ts              Orchestrator
src/config/workflow-schema.ts         zod schema + Workflow types
src/config/load-workflow.ts           pack + project merge, extends, validation
src/config/instance.ts                ~/.relais config.yaml + secrets.json
src/store/types.ts, src/store/sqlite-store.ts
src/adapters/tracker/types.ts, src/adapters/tracker/fake.ts
src/adapters/tracker/activity-relay.ts
src/adapters/tracker/linear/{api.ts,queries.ts,tracker.ts,oauth.ts,webhook.ts,ingest.ts,reconcile.ts}
src/adapters/forge/{types.ts,fake.ts,gh-cli.ts,pr-poller.ts}
src/adapters/runner/{types.ts,fake.ts,stream-parser.ts,claude-code.ts}
src/adapters/workspace/{types.ts,fake.ts,git-workspaces.ts}
src/adapters/exec.ts                  spawn wrapper used by git and gh adapters
src/knowledge/kb.ts
src/server/app.ts, src/server/static.ts
src/relay/smee.ts
src/app/bootstrap.ts, src/app/root.ts, src/app/tracker-switch.ts
src/cli/relais.ts, src/cli/relais-agent.ts, src/cli/init.ts, src/cli/plan.ts
packs/standard/{workflow.yml,settings.json,.claude-plugin/plugin.json,hooks/hooks.json,hooks/session-start.mjs,skills/*/SKILL.md}
web/{index.html,vite.config.ts,src/main.tsx,src/App.tsx,src/state.ts,src/api.ts,src/styles.css}
test/scenarios/*.test.ts, test/helpers/harness.ts
Dockerfile, compose.yaml, docs/recette.md
```

Tests are colocated (`src/**/x.test.ts`) except scenarios (`test/scenarios`).

---

## M0 — Bootstrap

### Task 1: Project scaffolding, tooling and CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `.github/workflows/ci.yml`, `src/version.ts`, `src/version.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `test`, `typecheck`, `lint`; `VERSION` constant.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "relais",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": {
    "relais": "dist/src/cli/relais.js",
    "relais-agent": "dist/src/cli/relais-agent.js"
  },
  "scripts": {
    "dev": "tsx src/cli/relais.ts",
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm i hono @hono/node-server zod yaml eventsource
npm i -D typescript tsx vitest @types/node eslint @eslint/js typescript-eslint graphql
```
Expected: `package-lock.json` created, no native build step in the output.

- [ ] **Step 3: Write tsconfig files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```
`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: Write vitest, eslint and CI config**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
```
`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'web/dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```
`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 5: Write the failing smoke test**

`src/version.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

describe('VERSION', () => {
  it('matches package.json', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    expect(VERSION).toBe(pkg.default.version);
  });
});
```
Run: `npx vitest run src/version.test.ts` — Expected: FAIL (cannot find `./version.js`).

- [ ] **Step 6: Implement**

`src/version.ts`:
```ts
export const VERSION = '0.1.0';
```
Append to `.gitignore`: `.relais-home/` (already present) — verify `node_modules/`, `dist/`, `web/dist/` are listed.

- [ ] **Step 7: Run test, typecheck and lint once (this task only)**

Run: `npx vitest run src/version.test.ts && npx tsc --noEmit && npx eslint .`
Expected: PASS, no type errors, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project, tooling and CI"
```

---

## M1 — Core

### Task 2: Core types, commands, clock and naming

**Files:**
- Create: `src/core/types.ts`, `src/core/commands.ts`, `src/core/clock.ts`, `src/core/naming.ts`
- Test: `src/core/naming.test.ts`, `src/core/clock.test.ts`

**Interfaces:**
- Produces (exact names used by every later task):
  - `LOGICAL_STATES`, `type LogicalState`, `isLogicalState(v: string): v is LogicalState`
  - `type RunOutcome = 'success' | 'failure' | 'stopped' | 'limit'`
  - `type InputKind = 'feedback' | 'ci_failures' | 'thread' | 'verify_failures'`
  - `type QueueName = 'dev' | 'questions'`
  - `interface FeedbackItem`, `interface VerifyFailure`, `interface PrPayload`, `interface EventPayloads`, `type EventType`, `type RelaisEvent<T>`
  - `interface TicketState`, `newTicketState(...)`
  - `type Command` (union on `kind`)
  - `interface Clock { now(): number }`, `SystemClock`, `FakeClock` (`advance(ms)`, `set(ms)`)
  - `slugify(s: string, max?: number): string`, `branchName(identifier: string, title: string): string`

- [ ] **Step 1: Write the failing tests**

`src/core/naming.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { branchName, slugify } from './naming.js';

describe('slugify', () => {
  it('lowercases, strips accents and collapses separators', () => {
    expect(slugify('Corriger l’arrondi des Scores !')).toBe('corriger-l-arrondi-des-scores');
  });
  it('truncates without a trailing dash', () => {
    expect(slugify('a'.repeat(30) + ' ' + 'b'.repeat(30), 40)).toBe('a'.repeat(30) + '-' + 'b'.repeat(9));
  });
  it('returns "ticket" for an empty result', () => {
    expect(slugify('!!!')).toBe('ticket');
  });
});

describe('branchName', () => {
  it('prefixes with relais/ and the lowercased identifier', () => {
    expect(branchName('REL-12', 'Export CSV des audits')).toBe('relais/rel-12-export-csv-des-audits');
  });
});
```
`src/core/clock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';

describe('FakeClock', () => {
  it('starts at the given time and advances', () => {
    const c = new FakeClock(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
    c.set(42);
    expect(c.now()).toBe(42);
  });
});
```
Run: `npx vitest run src/core/naming.test.ts src/core/clock.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 2: Implement types**

`src/core/types.ts`:
```ts
export const LOGICAL_STATES = ['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done'] as const;
export type LogicalState = (typeof LOGICAL_STATES)[number];
export function isLogicalState(v: string): v is LogicalState {
  return (LOGICAL_STATES as readonly string[]).includes(v);
}

export type RunOutcome = 'success' | 'failure' | 'stopped' | 'limit';
export type InputKind = 'feedback' | 'ci_failures' | 'thread' | 'verify_failures';
export type QueueName = 'dev' | 'questions';

export interface FeedbackItem {
  author: string;
  body: string;
  at: number;
  source: 'session' | 'review' | 'label' | 'verify' | 'ci';
}

export interface VerifyFailure {
  command: string;
  exitCode: number | null;
  output: string;
}

export interface PrPayload {
  number: number;
  url: string;
  branch: string;
}

export interface EventPayloads {
  'ticket.delegated': { linearSessionId?: string; promptContext?: string };
  'session.mentioned': { linearSessionId: string; body: string; author: string };
  'session.prompted': { linearSessionId: string; body: string; author: string };
  'session.stopped': { linearSessionId?: string };
  'ticket.moved': { from: LogicalState | null; to: LogicalState | null };
  'label.added': { label: string };
  command: { name: string; body: string; linearSessionId: string; author: string };
  'pr.opened': PrPayload;
  'pr.checks_passed': PrPayload;
  'pr.checks_failed': PrPayload & { failures: string[] };
  'pr.merged': PrPayload;
  'pr.closed': PrPayload;
  'run.finished': { runId: string; job: string; outcome: RunOutcome; costUsd: number; turns: number; lastText: string };
  'verify.passed': { runId: string; job: string };
  'verify.failed': { runId: string; job: string; failures: VerifyFailure[] };
  'debounce.fired': { job: string };
  'control.pause': Record<string, never>;
  'control.resume': Record<string, never>;
  'control.stop': Record<string, never>;
}

export type EventType = keyof EventPayloads;

export type RelaisEvent<T extends EventType = EventType> = {
  [K in T]: {
    id: string;
    type: K;
    at: number;
    projectId: string;
    ticketId?: string;
    payload: EventPayloads[K];
  };
}[T];

export interface TicketState {
  projectId: string;
  ticketId: string;
  title: string;
  logical: LogicalState;
  blocked: boolean;
  blockReason?: string;
  claudeSessionId?: string;
  linearSessionId?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  prChecks?: 'pending' | 'pass' | 'fail' | 'none';
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  worktreePath?: string;
  port?: number;
  activeRunId?: string;
  pendingJob?: { job: string; input?: InputKind; inputText?: string; resume?: boolean };
  verifyAttempts: number;
  pendingFeedback: FeedbackItem[];
  priority: number;
  costUsd: number;
  updatedAt: number;
}

export function newTicketState(
  projectId: string,
  ticketId: string,
  title: string,
  logical: LogicalState,
  now: number,
  priority = 0,
): TicketState {
  return {
    projectId,
    ticketId,
    title,
    logical,
    blocked: false,
    verifyAttempts: 0,
    pendingFeedback: [],
    priority,
    costUsd: 0,
    updatedAt: now,
  };
}
```

- [ ] **Step 3: Implement commands, clock, naming**

`src/core/commands.ts`:
```ts
import type { FeedbackItem, InputKind, LogicalState, TicketState } from './types.js';

export type ActivityType = 'thought' | 'response' | 'elicitation' | 'error';

export type Command =
  | { kind: 'start_run'; job: string; input?: InputKind; inputText?: string; linearSessionId?: string; resume?: boolean }
  | { kind: 'stop_run' }
  | { kind: 'run_verify'; runId: string; job: string }
  | { kind: 'move'; to: LogicalState }
  | { kind: 'labels'; add: string[]; remove: string[] }
  | { kind: 'comment'; body: string }
  | { kind: 'activity'; type: ActivityType; body: string; linearSessionId?: string; runId?: string }
  | { kind: 'post_output'; style: 'summary' | 'reply' | 'synthesis'; runId: string }
  | { kind: 'link_pr'; url: string }
  | { kind: 'set_debounce'; job: string; ms: number }
  | { kind: 'append_feedback'; item: FeedbackItem }
  | { kind: 'cleanup' }
  | { kind: 'block'; reason: string }
  | { kind: 'unblock' }
  | {
      kind: 'patch_ticket';
      patch: Partial<Pick<TicketState, 'verifyAttempts' | 'prNumber' | 'prUrl' | 'prChecks' | 'prState' | 'linearSessionId'>>;
    }
  | { kind: 'set_paused'; paused: boolean };
```
`src/core/clock.ts`:
```ts
export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
```
`src/core/naming.ts`:
```ts
export function slugify(s: string, max = 40): string {
  const slug = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

export function branchName(identifier: string, title: string): string {
  return `relais/${identifier.toLowerCase()}-${slugify(title)}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/naming.test.ts src/core/clock.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core
git commit -m "feat(core): add domain types, commands, clock and branch naming"
```

### Task 3: Durations and the `when:` condition language

**Files:**
- Create: `src/core/duration.ts`, `src/core/conditions.ts`
- Test: `src/core/duration.test.ts`, `src/core/conditions.test.ts`

**Interfaces:**
- Consumes: `LogicalState`, `isLogicalState` (Task 2)
- Produces:
  - `parseDuration(s: string | number): number` (ms). Accepts `Ns`, `Nm`, `Nh`, `Nms`, plain number = ms. Throws `Error('invalid duration: <s>')`.
  - `type Condition`; `parseCondition(src: string): Condition` (throws `Error('invalid condition: ...')`); `evalCondition(c: Condition, ctx: ConditionContext): boolean`
  - `interface ConditionContext { state: LogicalState; blocked: boolean; job?: string }`

- [ ] **Step 1: Write the failing tests**

`src/core/duration.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseDuration } from './duration.js';

describe('parseDuration', () => {
  it.each([
    ['0s', 0],
    ['3m', 180_000],
    ['90m', 5_400_000],
    ['2h', 7_200_000],
    ['250ms', 250],
    [1500, 1500],
  ])('%s -> %d', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });
  it('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow('invalid duration: soon');
  });
});
```
`src/core/conditions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { evalCondition, parseCondition } from './conditions.js';

const ctx = { state: 'human_review' as const, blocked: false, job: 'dev' };

describe('conditions', () => {
  it.each([
    ['state == human_review', true],
    ['state != human_review', false],
    ['state in [dev, human_review]', true],
    ['state in [todo]', false],
    ['blocked', false],
    ['!blocked', true],
    ['job == dev', true],
    ['state in [dev, human_review] && !blocked', true],
    ['state == human_review && blocked', false],
  ])('%s -> %s', (src, expected) => {
    expect(evalCondition(parseCondition(src), ctx)).toBe(expected);
  });

  it('rejects unknown states', () => {
    expect(() => parseCondition('state == nowhere')).toThrow('invalid condition');
  });
  it('rejects unsupported syntax', () => {
    expect(() => parseCondition('state == dev || blocked')).toThrow('invalid condition');
  });
});
```
Run: `npx vitest run src/core/duration.test.ts src/core/conditions.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/core/duration.ts`:
```ts
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(s: string | number): number {
  if (typeof s === 'number') return s;
  const m = /^(\d+)(ms|s|m|h)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s}`);
  return Number(m[1]) * UNITS[m[2]!]!;
}
```
`src/core/conditions.ts`:
```ts
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
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/core/duration.test.ts src/core/conditions.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/duration.ts src/core/duration.test.ts src/core/conditions.ts src/core/conditions.test.ts
git commit -m "feat(core): add duration parsing and when-condition language"
```

### Task 4: Workflow schema, default pack workflow and loader

**Files:**
- Create: `src/config/workflow-schema.ts`, `src/config/load-workflow.ts`, `packs/standard/workflow.yml`
- Test: `src/config/load-workflow.test.ts`

**Interfaces:**
- Consumes: `parseDuration`, `parseCondition`, `LogicalState`, `InputKind`, `QueueName`
- Produces:
  - Types `Workflow`, `Rule`, `JobSpec`, `Limits`, `RunLimits` (resolved, durations in ms, conditions parsed)
  - `loadWorkflow(opts: { packDir: string; projectFile?: string }): Workflow` — throws `WorkflowError` whose message includes the YAML path (e.g. `on.session.prompted[1].when`)
  - `class WorkflowError extends Error`
  - Resolved shapes:
    ```ts
    interface RunLimits { turns: number; durationMs: number; usd: number }
    interface Limits { parallelSessions: number; questionSessions: number; perRun: RunLimits; verifyAttempts: number; reviewRounds: number }
    interface Rule { from?: LogicalState; to?: LogicalState; label?: string; say?: string; when?: Condition; whenSrc?: string;
                     run?: string; debounceMs?: number; move?: LogicalState; labels?: { add: string[]; remove: string[] };
                     comment?: string; do?: 'stop' | 'cleanup' | 'propose_delegate' }
    interface JobSpec { name: string; queue: QueueName; model: string; workspace: 'worktree' | 'trunk-readonly' | 'knowledge';
                        session: 'new' | 'resume'; skill: string; input?: InputKind; verify: string[]; pickup: boolean;
                        limits: RunLimits; onStart: { move?: LogicalState }; onSuccess: { move?: LogicalState; post?: 'summary' | 'reply' | 'synthesis' } }
    interface Workflow { version: 1; tracker: { kind: 'linear'; team?: string; pickup: { checks: PickupCheck[] } };
                         states: Record<LogicalState, string>; limits: Limits; workspace: { setup: string[]; portBase: number };
                         commands: string[]; on: Partial<Record<EventType, Rule[]>>; jobs: Record<string, JobSpec> }
    type PickupCheck = 'has_description' | 'not_started' | 'has_acceptance_criteria'
    ```
  - `workflow.commands` = the distinct `say` values of `on.command` rules (used by the webhook mapper).

- [ ] **Step 1: Write the default pack workflow**

`packs/standard/workflow.yml`:
```yaml
version: 1
tracker:
  kind: linear
  pickup:
    checks: [has_description, not_started]
states:
  todo: "Todo"
  dev: "In Progress"
  human_review: "Human Review"
  ai_review: "AI Review"
  ready: "Ready to Merge"
  done: "Done"
limits:
  parallel_sessions: 3
  question_sessions: 2
  per_run: { turns: 150, duration: 90m, usd: 5 }
  verify_attempts: 2
  review_rounds: 5
workspace:
  setup: []
  ports: { base: 4200 }
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: dev }
  ticket.moved:
    - { from: human_review, to: dev, run: dev-feedback }
    - { to: ai_review, run: review }
  session.prompted:
    - { when: "blocked", run: dev-feedback, debounce: 0s }
    - { when: "state in [dev, human_review]", run: dev-feedback, debounce: 3m }
  session.mentioned:
    - { run: ask }
  command:
    - { say: retiens, run: remember }
    - { say: "fais-le", do: propose_delegate }
  label.added:
    - { label: "agent:reprendre", run: dev-feedback }
    - { label: "agent:stop", do: stop }
  session.stopped:
    - { do: stop }
  pr.checks_failed:
    - { when: "state in [human_review, ai_review] && !blocked", run: fix-ci }
  pr.merged:
    - { move: done, do: cleanup, run: learn }
jobs:
  dev:
    queue: dev
    model: sonnet
    workspace: worktree
    session: new
    skill: "relais:dev"
    pickup: true
    verify: []
    on_start: { move: dev }
    on_success: { move: human_review, post: summary }
  dev-feedback:
    extends: dev
    session: resume
    skill: "relais:feedback"
    input: feedback
    pickup: false
    on_start: {}
    on_success: { post: reply }
  fix-ci:
    extends: dev-feedback
    input: ci_failures
  review:
    queue: dev
    model: opus
    workspace: worktree
    session: new
    skill: "relais:review"
    on_success: { move: ready, post: synthesis }
  ask:
    queue: questions
    model: sonnet
    workspace: trunk-readonly
    session: new
    skill: "relais:ask"
    input: thread
    limits: { turns: 30, duration: 5m, usd: 0.5 }
    on_success: { post: reply }
  learn:
    queue: questions
    model: haiku
    workspace: knowledge
    session: new
    skill: "relais:learn"
    limits: { turns: 40, duration: 10m, usd: 0.5 }
    on_success: {}
  remember:
    extends: learn
    input: thread
    on_success: { post: reply }
```

- [ ] **Step 2: Write the failing tests**

`src/config/load-workflow.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow, WorkflowError } from './load-workflow.js';

const packDir = join(import.meta.dirname, '../../packs/standard');

function projectFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relais-wf-'));
  const f = join(dir, 'workflow.yml');
  writeFileSync(f, yaml);
  return f;
}

describe('loadWorkflow', () => {
  it('loads the standard pack alone', () => {
    const wf = loadWorkflow({ packDir });
    expect(wf.states.human_review).toBe('Human Review');
    expect(wf.limits.parallelSessions).toBe(3);
    expect(wf.limits.perRun.durationMs).toBe(90 * 60_000);
    expect(wf.on['session.prompted']).toHaveLength(2);
    expect(wf.on['session.prompted']![1]!.debounceMs).toBe(180_000);
    expect(wf.commands).toEqual(['retiens', 'fais-le']);
  });

  it('resolves extends field by field', () => {
    const wf = loadWorkflow({ packDir });
    const fb = wf.jobs['dev-feedback']!;
    expect(fb.queue).toBe('dev');
    expect(fb.model).toBe('sonnet');
    expect(fb.session).toBe('resume');
    expect(fb.skill).toBe('relais:feedback');
    expect(fb.onStart).toEqual({});
    expect(wf.jobs['fix-ci']!.input).toBe('ci_failures');
    expect(wf.jobs['fix-ci']!.skill).toBe('relais:feedback');
    expect(wf.jobs['remember']!.workspace).toBe('knowledge');
    expect(wf.jobs['ask']!.limits.usd).toBe(0.5);
    expect(wf.jobs['dev']!.limits.turns).toBe(150);
  });

  it('merges a project file over the pack', () => {
    const wf = loadWorkflow({
      packDir,
      projectFile: projectFile(`
version: 1
tracker: { kind: linear, team: REL }
states: { dev: "En cours" }
limits: { parallel_sessions: 1 }
jobs:
  dev: { verify: ["npm test"] }
on:
  session.mentioned: []
`),
    });
    expect(wf.tracker.team).toBe('REL');
    expect(wf.states.dev).toBe('En cours');
    expect(wf.states.todo).toBe('Todo');
    expect(wf.limits.parallelSessions).toBe(1);
    expect(wf.jobs['dev']!.verify).toEqual(['npm test']);
    expect(wf.jobs['dev-feedback']!.verify).toEqual(['npm test']);
    expect(wf.on['session.mentioned']).toEqual([]);
  });

  it('reports the YAML path of an invalid condition', () => {
    expect(() =>
      loadWorkflow({
        packDir,
        projectFile: projectFile(`
version: 1
on:
  session.prompted:
    - { when: "state == nowhere", run: dev }
`),
      }),
    ).toThrow(/on\.session\.prompted\[0\]\.when/);
  });

  it('rejects a rule that runs an unknown job', () => {
    expect(() =>
      loadWorkflow({ packDir, projectFile: projectFile('version: 1\non:\n  ticket.delegated:\n    - { run: nope }\n') }),
    ).toThrow(WorkflowError);
  });
});
```
Run: `npx vitest run src/config/load-workflow.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the raw schema**

`src/config/workflow-schema.ts`:
```ts
import { z } from 'zod';
import type { Condition } from '../core/conditions.js';
import type { EventType, InputKind, LogicalState, QueueName } from '../core/types.js';

const logical = z.enum(['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done']);
const duration = z.union([z.string(), z.number()]);

export const rawRuleSchema = z
  .object({
    from: logical.optional(),
    to: logical.optional(),
    label: z.string().optional(),
    say: z.string().optional(),
    when: z.string().optional(),
    run: z.string().optional(),
    debounce: duration.optional(),
    move: logical.optional(),
    labels: z.object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }).optional(),
    comment: z.string().optional(),
    do: z.enum(['stop', 'cleanup', 'propose_delegate']).optional(),
  })
  .strict();

const rawLimits = z.object({ turns: z.number().int().positive(), duration, usd: z.number().positive() }).partial();

export const rawJobSchema = z
  .object({
    extends: z.string().optional(),
    queue: z.enum(['dev', 'questions']).optional(),
    model: z.string().optional(),
    workspace: z.enum(['worktree', 'trunk-readonly', 'knowledge']).optional(),
    session: z.enum(['new', 'resume']).optional(),
    skill: z.string().optional(),
    input: z.enum(['feedback', 'ci_failures', 'thread', 'verify_failures']).optional(),
    verify: z.array(z.string()).optional(),
    pickup: z.boolean().optional(),
    limits: rawLimits.optional(),
    on_start: z.object({ move: logical.optional() }).strict().optional(),
    on_success: z
      .object({ move: logical.optional(), post: z.enum(['summary', 'reply', 'synthesis']).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const rawWorkflowSchema = z
  .object({
    version: z.literal(1),
    extends: z.string().optional(),
    tracker: z
      .object({
        kind: z.literal('linear').default('linear'),
        team: z.string().optional(),
        pickup: z
          .object({ checks: z.array(z.enum(['has_description', 'not_started', 'has_acceptance_criteria'])).optional() })
          .optional(),
      })
      .optional(),
    states: z
      .object({
        todo: z.string(),
        dev: z.string(),
        human_review: z.string(),
        ai_review: z.string(),
        ready: z.string(),
        done: z.string(),
      })
      .partial()
      .strict()
      .optional(),
    limits: z
      .object({
        parallel_sessions: z.number().int().positive(),
        question_sessions: z.number().int().positive(),
        per_run: rawLimits,
        verify_attempts: z.number().int().nonnegative(),
        review_rounds: z.number().int().positive(),
      })
      .partial()
      .optional(),
    workspace: z
      .object({ setup: z.array(z.string()), ports: z.object({ base: z.number().int().positive() }) })
      .partial()
      .optional(),
    on: z.record(z.string(), z.array(rawRuleSchema)).optional(),
    jobs: z.record(z.string(), rawJobSchema).optional(),
  })
  .strict();

export type RawWorkflow = z.infer<typeof rawWorkflowSchema>;
export type RawJob = z.infer<typeof rawJobSchema>;

export type PickupCheck = 'has_description' | 'not_started' | 'has_acceptance_criteria';

export interface RunLimits {
  turns: number;
  durationMs: number;
  usd: number;
}

export interface Limits {
  parallelSessions: number;
  questionSessions: number;
  perRun: RunLimits;
  verifyAttempts: number;
  reviewRounds: number;
}

export interface Rule {
  from?: LogicalState;
  to?: LogicalState;
  label?: string;
  say?: string;
  when?: Condition;
  whenSrc?: string;
  run?: string;
  debounceMs?: number;
  move?: LogicalState;
  labels?: { add: string[]; remove: string[] };
  comment?: string;
  do?: 'stop' | 'cleanup' | 'propose_delegate';
}

export interface JobSpec {
  name: string;
  queue: QueueName;
  model: string;
  workspace: 'worktree' | 'trunk-readonly' | 'knowledge';
  session: 'new' | 'resume';
  skill: string;
  input?: InputKind;
  verify: string[];
  pickup: boolean;
  limits: RunLimits;
  onStart: { move?: LogicalState };
  onSuccess: { move?: LogicalState; post?: 'summary' | 'reply' | 'synthesis' };
}

export interface Workflow {
  version: 1;
  tracker: { kind: 'linear'; team?: string; pickup: { checks: PickupCheck[] } };
  states: Record<LogicalState, string>;
  limits: Limits;
  workspace: { setup: string[]; portBase: number };
  commands: string[];
  on: Partial<Record<EventType, Rule[]>>;
  jobs: Record<string, JobSpec>;
}
```

- [ ] **Step 4: Implement the loader**

`src/config/load-workflow.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseCondition } from '../core/conditions.js';
import { parseDuration } from '../core/duration.js';
import type { EventType, LogicalState } from '../core/types.js';
import {
  rawWorkflowSchema,
  type JobSpec,
  type RawJob,
  type RawWorkflow,
  type Rule,
  type RunLimits,
  type Workflow,
} from './workflow-schema.js';

export class WorkflowError extends Error {}

const EVENT_TYPES: readonly string[] = [
  'ticket.delegated', 'session.mentioned', 'session.prompted', 'session.stopped', 'ticket.moved', 'label.added',
  'command', 'pr.opened', 'pr.checks_passed', 'pr.checks_failed', 'pr.merged', 'pr.closed', 'run.finished',
  'verify.passed', 'verify.failed', 'debounce.fired', 'control.pause', 'control.resume', 'control.stop',
];

function readRaw(file: string): RawWorkflow {
  const doc = parse(readFileSync(file, 'utf8')) ?? {};
  const res = rawWorkflowSchema.safeParse(doc);
  if (!res.success) {
    const issue = res.error.issues[0]!;
    throw new WorkflowError(`${file}: ${issue.path.join('.')}: ${issue.message}`);
  }
  return res.data;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

function mergeRaw(pack: RawWorkflow, project: RawWorkflow | undefined): RawWorkflow {
  if (!project) return pack;
  const { on: pOn, jobs: pJobs, ...rest } = project;
  const merged = deepMerge({ ...pack, on: undefined, jobs: undefined }, rest) as RawWorkflow;
  merged.on = { ...(pack.on ?? {}), ...(pOn ?? {}) };
  const jobs: Record<string, RawJob> = { ...(pack.jobs ?? {}) };
  for (const [name, job] of Object.entries(pJobs ?? {})) jobs[name] = deepMerge(jobs[name] ?? {}, job);
  merged.jobs = jobs;
  return merged;
}

function resolveJob(name: string, jobs: Record<string, RawJob>, seen: string[] = []): RawJob {
  const job = jobs[name];
  if (!job) throw new WorkflowError(`jobs.${name}: unknown job`);
  if (!job.extends) return job;
  if (seen.includes(name)) throw new WorkflowError(`jobs.${name}.extends: cycle`);
  const parent = resolveJob(job.extends, jobs, [...seen, name]);
  const { extends: _e, ...own } = job;
  return deepMerge(parent, own);
}

function limits(raw: { turns?: number; duration?: string | number; usd?: number } | undefined, base: RunLimits): RunLimits {
  return {
    turns: raw?.turns ?? base.turns,
    durationMs: raw?.duration !== undefined ? parseDuration(raw.duration) : base.durationMs,
    usd: raw?.usd ?? base.usd,
  };
}

function buildJob(name: string, raw: RawJob, perRun: RunLimits): JobSpec {
  const need = <K extends keyof RawJob>(k: K): NonNullable<RawJob[K]> => {
    const v = raw[k];
    if (v === undefined) throw new WorkflowError(`jobs.${name}.${String(k)}: required`);
    return v as NonNullable<RawJob[K]>;
  };
  return {
    name,
    queue: need('queue'),
    model: need('model'),
    workspace: need('workspace'),
    session: raw.session ?? 'new',
    skill: need('skill'),
    input: raw.input,
    verify: raw.verify ?? [],
    pickup: raw.pickup ?? false,
    limits: limits(raw.limits, perRun),
    onStart: raw.on_start ?? {},
    onSuccess: raw.on_success ?? {},
  };
}

export function loadWorkflow(opts: { packDir: string; projectFile?: string }): Workflow {
  const pack = readRaw(join(opts.packDir, 'workflow.yml'));
  const project = opts.projectFile ? readRaw(opts.projectFile) : undefined;
  const raw = mergeRaw(pack, project);

  const perRun = limits(raw.limits?.per_run, { turns: 150, durationMs: 90 * 60_000, usd: 5 });
  const rawJobs = raw.jobs ?? {};
  const jobs: Record<string, JobSpec> = {};
  for (const name of Object.keys(rawJobs)) jobs[name] = buildJob(name, resolveJob(name, rawJobs), perRun);

  const on: Partial<Record<EventType, Rule[]>> = {};
  for (const [type, rules] of Object.entries(raw.on ?? {})) {
    if (!EVENT_TYPES.includes(type)) throw new WorkflowError(`on.${type}: unknown event type`);
    on[type as EventType] = rules.map((r, i) => {
      const path = `on.${type}[${i}]`;
      if (r.run && !jobs[r.run]) throw new WorkflowError(`${path}.run: unknown job "${r.run}"`);
      let when;
      if (r.when !== undefined) {
        try {
          when = parseCondition(r.when);
        } catch (e) {
          throw new WorkflowError(`${path}.when: ${(e as Error).message}`);
        }
      }
      const rule: Rule = {
        from: r.from,
        to: r.to,
        label: r.label,
        say: r.say,
        when,
        whenSrc: r.when,
        run: r.run,
        debounceMs: r.debounce !== undefined ? parseDuration(r.debounce) : undefined,
        move: r.move,
        labels: r.labels,
        comment: r.comment,
        do: r.do,
      };
      return rule;
    });
  }

  const states = raw.states as Record<LogicalState, string> | undefined;
  const required: LogicalState[] = ['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done'];
  for (const s of required) if (!states?.[s]) throw new WorkflowError(`states.${s}: required`);

  return {
    version: 1,
    tracker: {
      kind: 'linear',
      team: raw.tracker?.team,
      pickup: { checks: raw.tracker?.pickup?.checks ?? [] },
    },
    states: states!,
    limits: {
      parallelSessions: raw.limits?.parallel_sessions ?? 3,
      questionSessions: raw.limits?.question_sessions ?? 2,
      perRun,
      verifyAttempts: raw.limits?.verify_attempts ?? 2,
      reviewRounds: raw.limits?.review_rounds ?? 5,
    },
    workspace: { setup: raw.workspace?.setup ?? [], portBase: raw.workspace?.ports?.base ?? 4200 },
    commands: [...new Set((on.command ?? []).map((r) => r.say).filter((s): s is string => !!s))],
    on,
    jobs,
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/config/load-workflow.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packs/standard/workflow.yml src/config
git commit -m "feat(config): add workflow schema, standard pack workflow and loader"
```

### Task 5: The decision engine `decide()`

**Files:**
- Create: `src/core/engine.ts`
- Test: `src/core/engine.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `Rule`, `JobSpec` (Task 4), `evalCondition` (Task 3), `RelaisEvent`, `TicketState`, `Command` (Task 2)
- Produces:
  ```ts
  interface DecideContext { workflow: Workflow; activeJob?: string }
  function decide(event: RelaisEvent, ticket: TicketState | undefined, ctx: DecideContext): Command[]
  ```
  Built-in behaviour (independent of YAML), in this order:
  1. `control.pause` → `[set_paused true]`; `control.resume` → `[set_paused false]`.
  2. `control.stop` → `stopCommands()` = `[stop_run, block('Arrêté à la demande'), activity response 'Arrêté. Répondez dans ce fil ou posez le label agent:reprendre pour relancer.']`.
  3. `run.finished`: `stopped` → `[]`; a dev-queue `success` while the ticket is blocked (the agent asked a question through `relais-agent ask`) → `[]`; a `questions`-queue job that fails or hits a limit → `[activity error "Je n'ai pas pu terminer (échec ou plafond atteint)." with runId]` (never blocks the ticket); `success` → job has `verify` → `[run_verify]`, else `successCommands(job, runId)`; `failure`/`limit` → `[block(reason), activity elicitation]` where reason is `Le run <job> a échoué.` or `Le run <job> a atteint un plafond (tours, durée ou budget).`
  4. `verify.passed` → `[patch_ticket {verifyAttempts: 0}, ...successCommands]`.
  5. `verify.failed` → if `ticket.verifyAttempts + 1 < limits.verifyAttempts` (strictly: attempts used so far + this one stays under the cap) → `[patch_ticket {verifyAttempts: n+1}, start_run {job, input: 'verify_failures', inputText, resume: true}]`; else `[block('Vérifications toujours en échec après N tentatives.'), activity elicitation listing the failing commands]`.
  6. `debounce.fired` → `[unblock?, start_run {job, input: job.input}]` (`unblock` only if blocked).
  7. `pr.opened` → `[patch_ticket {prNumber, prUrl}, link_pr]`.
  8. `session.prompted` whose `linearSessionId` differs from `ticket.linearSessionId` (a follow-up in an ask thread) → `[start_run {job: 'ask', input: 'thread', inputText: body, linearSessionId}]` when job `ask` exists, else `[]`.
  9. Otherwise: first YAML rule of `workflow.on[type]` whose filters and `when` pass → `ruleCommands(rule)`.
  - `successCommands(job, runId)` = `move` (if `onSuccess.move`) then `post_output` (if `onSuccess.post`).
  - `ruleCommands` order: `append_feedback` (for `session.prompted` only: `{author, body, at: event.at, source: 'session'}`), `unblock` (if ticket blocked and rule has `run`), `move`, `labels`, `comment`, `do` (`stop` → stopCommands, `cleanup` → `cleanup`, `propose_delegate` → activity response), then the run part: `debounceMs > 0` → `set_debounce {job, ms}`, else `start_run {job, input: job.input, inputText, linearSessionId}` where `inputText` = body for `session.mentioned` / `command`, and `linearSessionId` = payload session for `session.mentioned` / `command`.
  - Condition context: `{ state: ticket?.logical ?? 'todo', blocked: ticket?.blocked ?? false, job: ctx.activeJob }`.

- [ ] **Step 1: Write the failing tests**

`src/core/engine.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { decide } from './engine.js';
import { newTicketState, type EventPayloads, type EventType, type RelaisEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const ctx = { workflow };

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): RelaisEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', payload } as RelaisEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), ...patch };
}

describe('decide — YAML rules of the standard pack', () => {
  it('starts dev on delegation of a todo ticket', () => {
    expect(decide(ev('ticket.delegated', {}), ticket(), ctx)).toEqual([{ kind: 'start_run', job: 'dev', input: undefined, inputText: undefined, linearSessionId: undefined }]);
  });

  it('ignores delegation of a blocked ticket', () => {
    expect(decide(ev('ticket.delegated', {}), ticket({ blocked: true }), ctx)).toEqual([]);
  });

  it('debounces a reply in human review and records the feedback', () => {
    const out = decide(ev('session.prompted', { linearSessionId: 's1', body: 'boutons mal alignés', author: 'Lilian' }), ticket({ logical: 'human_review', linearSessionId: 's1' }), ctx);
    expect(out).toEqual([
      { kind: 'append_feedback', item: { author: 'Lilian', body: 'boutons mal alignés', at: 1000, source: 'session' } },
      { kind: 'set_debounce', job: 'dev-feedback', ms: 180_000 },
    ]);
  });

  it('relaunches immediately when blocked', () => {
    const out = decide(ev('session.prompted', { linearSessionId: 's1', body: 'oui, vas-y', author: 'L' }), ticket({ logical: 'dev', blocked: true, linearSessionId: 's1' }), ctx);
    expect(out.map((c) => c.kind)).toEqual(['append_feedback', 'unblock', 'start_run']);
    expect(out[2]).toMatchObject({ job: 'dev-feedback', input: 'feedback' });
  });

  it('routes a reply in a foreign session to ask', () => {
    const out = decide(ev('session.prompted', { linearSessionId: 's9', body: 'et pour mobile ?', author: 'L' }), ticket({ linearSessionId: 's1' }), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'et pour mobile ?', linearSessionId: 's9' }]);
  });

  it('moves human_review -> dev runs dev-feedback', () => {
    const out = decide(ev('ticket.moved', { from: 'human_review', to: 'dev' }), ticket({ logical: 'dev' }), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'dev-feedback', input: 'feedback', inputText: undefined, linearSessionId: undefined }]);
  });

  it('moving to ai_review runs review', () => {
    const out = decide(ev('ticket.moved', { from: 'human_review', to: 'ai_review' }), ticket({ logical: 'ai_review' }), ctx);
    expect(out[0]).toMatchObject({ kind: 'start_run', job: 'review' });
  });

  it('a mention runs ask with the body in its own session', () => {
    const out = decide(ev('session.mentioned', { linearSessionId: 's2', body: 'tu penses quoi ?', author: 'L' }), ticket(), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'tu penses quoi ?', linearSessionId: 's2' }]);
  });

  it('the retiens command runs remember', () => {
    const out = decide(ev('command', { name: 'retiens', body: 'agrégats côté serveur', linearSessionId: 's3', author: 'L' }), ticket(), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'remember', input: 'thread', inputText: 'agrégats côté serveur', linearSessionId: 's3' }]);
  });

  it('the agent:stop label stops', () => {
    const out = decide(ev('label.added', { label: 'agent:stop' }), ticket({ logical: 'dev' }), ctx);
    expect(out.map((c) => c.kind)).toEqual(['stop_run', 'block', 'activity']);
  });

  it('merge moves to done, cleans up and learns', () => {
    const out = decide(ev('pr.merged', { number: 3, url: 'u', branch: 'b' }), ticket({ logical: 'ready' }), ctx);
    expect(out.map((c) => c.kind)).toEqual(['move', 'cleanup', 'start_run']);
    expect(out[2]).toMatchObject({ job: 'learn' });
  });
});

describe('decide — built-ins', () => {
  it('run success without verify applies on_success', () => {
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), ticket({ logical: 'dev' }), ctx);
    expect(out).toEqual([
      { kind: 'move', to: 'human_review' },
      { kind: 'post_output', style: 'summary', runId: 'r1' },
    ]);
  });

  it('run success on a ticket blocked by an agent question waits for the answer', () => {
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: '?' }), ticket({ blocked: true }), ctx);
    expect(out).toEqual([]);
  });

  it('run success with verify asks for verification', () => {
    const wf = { ...workflow, jobs: { ...workflow.jobs, dev: { ...workflow.jobs['dev']!, verify: ['npm test'] } } };
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), ticket(), { workflow: wf });
    expect(out).toEqual([{ kind: 'run_verify', runId: 'r1', job: 'dev' }]);
  });

  it('a failed question run reports an error without blocking', () => {
    const out = decide(ev('run.finished', { runId: 'r9', job: 'ask', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' }), ticket(), ctx);
    expect(out).toEqual([{ kind: 'activity', type: 'error', body: "Je n'ai pas pu terminer (échec ou plafond atteint).", runId: 'r9' }]);
  });

  it('run limit blocks and asks', () => {
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'limit', costUsd: 5, turns: 150, lastText: '' }), ticket(), ctx);
    expect(out.map((c) => c.kind)).toEqual(['block', 'activity']);
    expect(out[1]).toMatchObject({ type: 'elicitation' });
  });

  it('verify failure resumes until the cap, then blocks', () => {
    const failures = [{ command: 'npm test', exitCode: 1, output: 'boom' }];
    const first = decide(ev('verify.failed', { runId: 'r1', job: 'dev', failures }), ticket({ verifyAttempts: 0 }), ctx);
    expect(first[0]).toEqual({ kind: 'patch_ticket', patch: { verifyAttempts: 1 } });
    expect(first[1]).toMatchObject({ kind: 'start_run', job: 'dev', input: 'verify_failures', resume: true });
    const last = decide(ev('verify.failed', { runId: 'r2', job: 'dev', failures }), ticket({ verifyAttempts: 1 }), ctx);
    expect(last.map((c) => c.kind)).toEqual(['block', 'activity']);
  });

  it('debounce fired starts the job', () => {
    expect(decide(ev('debounce.fired', { job: 'dev-feedback' }), ticket({ logical: 'human_review' }), ctx)).toEqual([
      { kind: 'start_run', job: 'dev-feedback', input: 'feedback' },
    ]);
  });

  it('pr.opened records and links the PR', () => {
    expect(decide(ev('pr.opened', { number: 7, url: 'https://gh/pr/7', branch: 'b' }), ticket(), ctx)).toEqual([
      { kind: 'patch_ticket', patch: { prNumber: 7, prUrl: 'https://gh/pr/7' } },
      { kind: 'link_pr', url: 'https://gh/pr/7' },
    ]);
  });

  it('pause and resume', () => {
    expect(decide(ev('control.pause', {}), undefined, ctx)).toEqual([{ kind: 'set_paused', paused: true }]);
    expect(decide(ev('control.resume', {}), undefined, ctx)).toEqual([{ kind: 'set_paused', paused: false }]);
  });
});
```
Run: `npx vitest run src/core/engine.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/core/engine.ts`:
```ts
import type { JobSpec, Rule, Workflow } from '../config/workflow-schema.js';
import type { Command } from './commands.js';
import { evalCondition } from './conditions.js';
import type { RelaisEvent, TicketState, VerifyFailure } from './types.js';

export interface DecideContext {
  workflow: Workflow;
  activeJob?: string;
}

const STOP_MESSAGE = 'Arrêté. Répondez dans ce fil ou posez le label agent:reprendre pour relancer.';

function stopCommands(): Command[] {
  return [
    { kind: 'stop_run' },
    { kind: 'block', reason: 'Arrêté à la demande' },
    { kind: 'activity', type: 'response', body: STOP_MESSAGE },
  ];
}

function successCommands(job: JobSpec, runId: string): Command[] {
  const out: Command[] = [];
  if (job.onSuccess.move) out.push({ kind: 'move', to: job.onSuccess.move });
  if (job.onSuccess.post) out.push({ kind: 'post_output', style: job.onSuccess.post, runId });
  return out;
}

export function formatFailuresShort(failures: VerifyFailure[]): string {
  return failures.map((f) => `- \`${f.command}\` (code ${f.exitCode ?? 'timeout'})`).join('\n');
}

function ruleMatches(rule: Rule, event: RelaisEvent, ticket: TicketState | undefined, ctx: DecideContext): boolean {
  if (event.type === 'ticket.moved') {
    if (rule.from && rule.from !== event.payload.from) return false;
    if (rule.to && rule.to !== event.payload.to) return false;
  }
  if (rule.label !== undefined && (event.type !== 'label.added' || event.payload.label !== rule.label)) return false;
  if (rule.say !== undefined && (event.type !== 'command' || event.payload.name !== rule.say)) return false;
  if (rule.when) {
    return evalCondition(rule.when, {
      state: ticket?.logical ?? 'todo',
      blocked: ticket?.blocked ?? false,
      job: ctx.activeJob,
    });
  }
  return true;
}

function ruleCommands(rule: Rule, event: RelaisEvent, ticket: TicketState | undefined, ctx: DecideContext): Command[] {
  const out: Command[] = [];
  if (event.type === 'session.prompted') {
    out.push({
      kind: 'append_feedback',
      item: { author: event.payload.author, body: event.payload.body, at: event.at, source: 'session' },
    });
  }
  if (rule.run && ticket?.blocked) out.push({ kind: 'unblock' });
  if (rule.move) out.push({ kind: 'move', to: rule.move });
  if (rule.labels) out.push({ kind: 'labels', add: rule.labels.add, remove: rule.labels.remove });
  if (rule.comment) out.push({ kind: 'comment', body: rule.comment });
  if (rule.do === 'stop') out.push(...stopCommands());
  if (rule.do === 'cleanup') out.push({ kind: 'cleanup' });
  if (rule.do === 'propose_delegate') {
    out.push({
      kind: 'activity',
      type: 'response',
      body: 'Pour que je développe ce ticket, déléguez-le moi (champ « Agent » du ticket).',
    });
  }
  if (rule.run) {
    const job = ctx.workflow.jobs[rule.run]!;
    if (rule.debounceMs && rule.debounceMs > 0) {
      out.push({ kind: 'set_debounce', job: job.name, ms: rule.debounceMs });
    } else {
      const threaded = event.type === 'session.mentioned' || event.type === 'command';
      out.push({
        kind: 'start_run',
        job: job.name,
        input: job.input,
        inputText: threaded ? event.payload.body : undefined,
        linearSessionId: threaded ? event.payload.linearSessionId : undefined,
      });
    }
  }
  return out;
}

export function decide(event: RelaisEvent, ticket: TicketState | undefined, ctx: DecideContext): Command[] {
  const { workflow } = ctx;
  switch (event.type) {
    case 'control.pause':
      return [{ kind: 'set_paused', paused: true }];
    case 'control.resume':
      return [{ kind: 'set_paused', paused: false }];
    case 'control.stop':
      return stopCommands();
    case 'run.finished': {
      const { outcome, job: jobName, runId } = event.payload;
      const job = workflow.jobs[jobName];
      if (!job || outcome === 'stopped') return [];
      if (outcome === 'success' && ticket?.blocked && job.queue === 'dev') return [];
      if (outcome === 'success') return job.verify.length > 0 ? [{ kind: 'run_verify', runId, job: jobName }] : successCommands(job, runId);
      if (job.queue === 'questions') {
        return [{ kind: 'activity', type: 'error', body: "Je n'ai pas pu terminer (échec ou plafond atteint).", runId }];
      }
      const reason =
        outcome === 'limit'
          ? `Le run ${jobName} a atteint un plafond (tours, durée ou budget).`
          : `Le run ${jobName} a échoué.`;
      return [
        { kind: 'block', reason },
        { kind: 'activity', type: 'elicitation', body: `${reason} Répondez dans ce fil pour que je reprenne.` },
      ];
    }
    case 'verify.passed': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return [];
      return [{ kind: 'patch_ticket', patch: { verifyAttempts: 0 } }, ...successCommands(job, event.payload.runId)];
    }
    case 'verify.failed': {
      const used = ticket?.verifyAttempts ?? 0;
      const { failures, job } = event.payload;
      if (used + 1 < workflow.limits.verifyAttempts) {
        return [
          { kind: 'patch_ticket', patch: { verifyAttempts: used + 1 } },
          { kind: 'start_run', job, input: 'verify_failures', inputText: JSON.stringify(failures), resume: true },
        ];
      }
      const reason = `Vérifications toujours en échec après ${workflow.limits.verifyAttempts} tentatives.`;
      return [
        { kind: 'block', reason },
        { kind: 'activity', type: 'elicitation', body: `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.` },
      ];
    }
    case 'debounce.fired': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return [];
      const out: Command[] = ticket?.blocked ? [{ kind: 'unblock' }] : [];
      out.push({ kind: 'start_run', job: job.name, input: job.input });
      return out;
    }
    case 'pr.opened':
      return [
        { kind: 'patch_ticket', patch: { prNumber: event.payload.number, prUrl: event.payload.url } },
        { kind: 'link_pr', url: event.payload.url },
      ];
    case 'session.prompted':
      if (ticket?.linearSessionId && event.payload.linearSessionId !== ticket.linearSessionId) {
        if (!workflow.jobs['ask']) return [];
        return [
          { kind: 'start_run', job: 'ask', input: 'thread', inputText: event.payload.body, linearSessionId: event.payload.linearSessionId },
        ];
      }
      break;
    default:
      break;
  }
  const rules = workflow.on[event.type] ?? [];
  const rule = rules.find((r) => ruleMatches(r, event, ticket, ctx));
  return rule ? ruleCommands(rule, event, ticket, ctx) : [];
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/core/engine.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/engine.ts src/core/engine.test.ts
git commit -m "feat(core): add pure decide() engine with built-in lifecycle rules"
```

### Task 6: SQLite store

**Files:**
- Create: `src/store/types.ts`, `src/store/sqlite-store.ts`
- Test: `src/store/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `TicketState`, `RelaisEvent`, `QueueName`, `InputKind`, `RunOutcome`
- Produces (`src/store/types.ts`):
  ```ts
  interface RunRecord { id: string; projectId: string; ticketId: string; job: string; queue: QueueName;
    status: 'running' | RunOutcome; claudeSessionId: string; linearSessionId?: string; startedAt: number; endedAt?: number;
    costUsd: number; turns: number; lastText: string; token: string; cwd: string }
  interface TimerRecord { key: string; projectId: string; ticketId: string; job: string; fireAt: number }
  interface QueueItem { projectId: string; ticketId: string; job: string; queue: QueueName; input?: InputKind; inputText?: string;
    linearSessionId?: string; resume?: boolean; priority: number; enqueuedAt: number }
  interface Store { getTicket(projectId: string, ticketId: string): TicketState | undefined; putTicket(t: TicketState): void;
    listTickets(): TicketState[]; recordEvent(e: RelaisEvent): boolean; recentEvents(limit: number, ticketId?: string): RelaisEvent[];
    putRun(r: RunRecord): void; getRun(id: string): RunRecord | undefined; runsByStatus(s: RunRecord['status']): RunRecord[];
    findRunByToken(token: string): RunRecord | undefined;
    putTimer(t: TimerRecord): void; dueTimers(now: number): TimerRecord[]; deleteTimer(key: string): void;
    deleteTimersFor(projectId: string, ticketId: string): void;
    enqueue(q: QueueItem): void; dequeue(queue: QueueName): QueueItem | undefined; listQueue(): QueueItem[];
    removeFromQueue(projectId: string, ticketId: string): void;
    putEcho(key: string, until: number): void; isEcho(key: string, now: number): boolean;
    costSince(ts: number): number; getMeta(key: string): string | undefined; setMeta(key: string, value: string): void; close(): void }
  ```
- `class SqliteStore implements Store { constructor(path: string) }` — `':memory:'` allowed. `enqueue` replaces an existing item with the same `(projectId, ticketId, job)`. `dequeue` order: priority rank (1,2,3,4 then 0 = none last), then `enqueuedAt`. `recordEvent` returns `false` if the id exists. `costSince(ts)` sums `costUsd` of runs with `startedAt >= ts`.

- [ ] **Step 1: Write the failing tests**

`src/store/sqlite-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { newTicketState, type RelaisEvent } from '../core/types.js';
import { SqliteStore } from './sqlite-store.js';
import type { QueueItem, RunRecord } from './types.js';

const store = () => new SqliteStore(':memory:');

function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running',
    claudeSessionId: 'c1', startedAt: 100, costUsd: 0, turns: 0, lastText: '', token: 't1', cwd: '/tmp', ...patch,
  };
}
function q(patch: Partial<QueueItem>): QueueItem {
  return { projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', priority: 0, enqueuedAt: 0, ...patch };
}

describe('SqliteStore', () => {
  it('round-trips tickets', () => {
    const s = store();
    const t = { ...newTicketState('p', 'REL-1', 'T', 'todo', 1), pendingFeedback: [{ author: 'a', body: 'b', at: 2, source: 'session' as const }] };
    s.putTicket(t);
    expect(s.getTicket('p', 'REL-1')).toEqual(t);
    expect(s.listTickets()).toHaveLength(1);
  });

  it('dedupes events by id and lists recent ones', () => {
    const s = store();
    const e = { id: 'e1', type: 'control.pause', at: 5, projectId: 'p', payload: {} } as RelaisEvent;
    expect(s.recordEvent(e)).toBe(true);
    expect(s.recordEvent(e)).toBe(false);
    expect(s.recentEvents(10)).toEqual([e]);
  });

  it('stores runs and finds them by token and status', () => {
    const s = store();
    s.putRun(run());
    s.putRun(run({ id: 'r2', token: 't2', status: 'success', costUsd: 1.5, startedAt: 200 }));
    expect(s.findRunByToken('t2')!.id).toBe('r2');
    expect(s.runsByStatus('running').map((r) => r.id)).toEqual(['r1']);
    expect(s.costSince(150)).toBe(1.5);
  });

  it('fires due timers', () => {
    const s = store();
    s.putTimer({ key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 500 });
    expect(s.dueTimers(499)).toEqual([]);
    expect(s.dueTimers(500)).toHaveLength(1);
    s.deleteTimer('REL-1:dev-feedback');
    expect(s.dueTimers(1000)).toEqual([]);
    s.putTimer({ key: 'REL-2:x', projectId: 'p', ticketId: 'REL-2', job: 'x', fireAt: 9e12 });
    s.deleteTimersFor('p', 'REL-2');
    expect(s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('orders the queue by priority then age, dedupes by ticket+job', () => {
    const s = store();
    s.enqueue(q({ ticketId: 'A', priority: 0, enqueuedAt: 1 }));
    s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 2 }));
    s.enqueue(q({ ticketId: 'C', priority: 1, enqueuedAt: 3 }));
    s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 9 }));
    expect(s.listQueue()).toHaveLength(3);
    expect(s.dequeue('dev')!.ticketId).toBe('C');
    expect(s.dequeue('dev')!.ticketId).toBe('B');
    expect(s.dequeue('dev')!.ticketId).toBe('A');
    expect(s.dequeue('dev')).toBeUndefined();
  });

  it('expires echoes and keeps meta', () => {
    const s = store();
    s.putEcho('state:REL-1:Done', 100);
    expect(s.isEcho('state:REL-1:Done', 99)).toBe(true);
    expect(s.isEcho('state:REL-1:Done', 101)).toBe(false);
    s.setMeta('paused', '1');
    expect(s.getMeta('paused')).toBe('1');
  });
});
```
Run: `npx vitest run src/store/sqlite-store.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement types and store**

`src/store/types.ts`:
```ts
import type { InputKind, QueueName, RelaisEvent, RunOutcome, TicketState } from '../core/types.js';

export interface RunRecord {
  id: string;
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  status: 'running' | RunOutcome;
  claudeSessionId: string;
  linearSessionId?: string;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  turns: number;
  lastText: string;
  token: string;
  cwd: string;
}

export interface TimerRecord {
  key: string;
  projectId: string;
  ticketId: string;
  job: string;
  fireAt: number;
}

export interface QueueItem {
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
  priority: number;
  enqueuedAt: number;
}

export interface Store {
  getTicket(projectId: string, ticketId: string): TicketState | undefined;
  putTicket(t: TicketState): void;
  listTickets(): TicketState[];
  recordEvent(e: RelaisEvent): boolean;
  recentEvents(limit: number, ticketId?: string): RelaisEvent[];
  putRun(r: RunRecord): void;
  getRun(id: string): RunRecord | undefined;
  runsByStatus(status: RunRecord['status']): RunRecord[];
  findRunByToken(token: string): RunRecord | undefined;
  putTimer(t: TimerRecord): void;
  dueTimers(now: number): TimerRecord[];
  deleteTimer(key: string): void;
  deleteTimersFor(projectId: string, ticketId: string): void;
  enqueue(q: QueueItem): void;
  dequeue(queue: QueueName): QueueItem | undefined;
  listQueue(): QueueItem[];
  removeFromQueue(projectId: string, ticketId: string): void;
  putEcho(key: string, until: number): void;
  isEcho(key: string, now: number): boolean;
  costSince(ts: number): number;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  close(): void;
}
```
`src/store/sqlite-store.ts`:
```ts
import { DatabaseSync } from 'node:sqlite';
import type { QueueName, RelaisEvent, TicketState } from '../core/types.js';
import type { QueueItem, RunRecord, Store, TimerRecord } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (project_id TEXT, ticket_id TEXT, data TEXT NOT NULL, PRIMARY KEY (project_id, ticket_id));
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, ticket_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, token TEXT NOT NULL, started_at INTEGER NOT NULL, cost_usd REAL NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS timers (key TEXT PRIMARY KEY, fire_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (project_id TEXT, ticket_id TEXT, job TEXT, queue TEXT NOT NULL, rank INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (project_id, ticket_id, job));
CREATE TABLE IF NOT EXISTS echoes (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const rank = (priority: number) => (priority === 0 ? 5 : priority);

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  getTicket(projectId: string, ticketId: string): TicketState | undefined {
    const row = this.db.prepare('SELECT data FROM tickets WHERE project_id = ? AND ticket_id = ?').get(projectId, ticketId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as TicketState) : undefined;
  }

  putTicket(t: TicketState): void {
    this.db
      .prepare('INSERT INTO tickets (project_id, ticket_id, data) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET data = excluded.data')
      .run(t.projectId, t.ticketId, JSON.stringify(t));
  }

  listTickets(): TicketState[] {
    return (this.db.prepare('SELECT data FROM tickets').all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  recordEvent(e: RelaisEvent): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO events (id, at, ticket_id, data) VALUES (?, ?, ?, ?)')
      .run(e.id, e.at, e.ticketId ?? null, JSON.stringify(e));
    return Number(res.changes) === 1;
  }

  recentEvents(limit: number, ticketId?: string): RelaisEvent[] {
    const rows = (
      ticketId
        ? this.db.prepare('SELECT data FROM events WHERE ticket_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(ticketId, limit)
        : this.db.prepare('SELECT data FROM events ORDER BY at DESC, rowid DESC LIMIT ?').all(limit)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  putRun(r: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, status, token, started_at, cost_usd, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET status = excluded.status, cost_usd = excluded.cost_usd, data = excluded.data`,
      )
      .run(r.id, r.status, r.token, r.startedAt, r.costUsd, JSON.stringify(r));
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  runsByStatus(status: RunRecord['status']): RunRecord[] {
    return (this.db.prepare('SELECT data FROM runs WHERE status = ? ORDER BY started_at').all(status) as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }

  findRunByToken(token: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT data FROM runs WHERE token = ?').get(token) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  putTimer(t: TimerRecord): void {
    this.db
      .prepare('INSERT INTO timers (key, fire_at, data) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET fire_at = excluded.fire_at, data = excluded.data')
      .run(t.key, t.fireAt, JSON.stringify(t));
  }

  dueTimers(now: number): TimerRecord[] {
    return (this.db.prepare('SELECT data FROM timers WHERE fire_at <= ? ORDER BY fire_at').all(now) as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }

  deleteTimer(key: string): void {
    this.db.prepare('DELETE FROM timers WHERE key = ?').run(key);
  }

  deleteTimersFor(projectId: string, ticketId: string): void {
    for (const t of this.dueTimers(Number.MAX_SAFE_INTEGER)) {
      if (t.projectId === projectId && t.ticketId === ticketId) this.deleteTimer(t.key);
    }
  }

  enqueue(item: QueueItem): void {
    this.db
      .prepare(
        `INSERT INTO queue (project_id, ticket_id, job, queue, rank, enqueued_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET data = excluded.data, rank = excluded.rank`,
      )
      .run(item.projectId, item.ticketId, item.job, item.queue, rank(item.priority), item.enqueuedAt, JSON.stringify(item));
  }

  dequeue(queue: QueueName): QueueItem | undefined {
    const row = this.db
      .prepare('SELECT project_id, ticket_id, job, data FROM queue WHERE queue = ? ORDER BY rank, enqueued_at LIMIT 1')
      .get(queue) as { project_id: string; ticket_id: string; job: string; data: string } | undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM queue WHERE project_id = ? AND ticket_id = ? AND job = ?').run(row.project_id, row.ticket_id, row.job);
    return JSON.parse(row.data);
  }

  listQueue(): QueueItem[] {
    return (this.db.prepare('SELECT data FROM queue ORDER BY rank, enqueued_at').all() as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }

  removeFromQueue(projectId: string, ticketId: string): void {
    this.db.prepare('DELETE FROM queue WHERE project_id = ? AND ticket_id = ?').run(projectId, ticketId);
  }

  putEcho(key: string, until: number): void {
    this.db.prepare('INSERT INTO echoes (key, until) VALUES (?, ?) ON CONFLICT DO UPDATE SET until = excluded.until').run(key, until);
  }

  isEcho(key: string, now: number): boolean {
    const row = this.db.prepare('SELECT until FROM echoes WHERE key = ?').get(key) as { until: number } | undefined;
    return !!row && row.until >= now;
  }

  costSince(ts: number): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE started_at >= ?').get(ts) as { total: number };
    return row.total;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/store/sqlite-store.test.ts` — Expected: PASS (an `ExperimentalWarning` about SQLite on stderr is acceptable).

- [ ] **Step 4: Commit**

```bash
git add src/store
git commit -m "feat(store): add node:sqlite store for tickets, events, runs, timers and queue"
```

### Task 7: Scheduler (slots) and debounce timers

**Files:**
- Create: `src/core/scheduler.ts`, `src/core/timers.ts`
- Test: `src/core/scheduler.test.ts`, `src/core/timers.test.ts`

**Interfaces:**
- Consumes: `Store`, `QueueItem`, `TimerRecord` (Task 6), `Clock` (Task 2), `RelaisEvent`
- Produces:
  ```ts
  class Scheduler {
    constructor(store: Store, capacity: Record<QueueName, number>)
    setCapacity(capacity: Record<QueueName, number>): void
    tryAcquire(queue: QueueName, key: string): number | null   // slot index 0..n-1; the same key never holds two slots
    release(key: string): QueueName | undefined
    inUse(queue: QueueName): number
    hasFree(queue: QueueName): boolean
    // The orchestrator uses the key `<ticketId>:<queue>`, so a question run never blocks the ticket's dev run.
    enqueue(item: QueueItem): void        // delegates to store.enqueue
    next(queue: QueueName): QueueItem | undefined   // delegates to store.dequeue
  }
  class TimerService {
    constructor(store: Store, clock: Clock, emit: (e: RelaisEvent) => void)
    tick(): void                           // emits debounce.fired for every due timer, then deletes it
    start(intervalMs?: number): void       // setInterval(tick, intervalMs ?? 1000)
    stop(): void
  }
  ```
  `debounce.fired` event: `{ id: 'timer:<key>:<fireAt>', type: 'debounce.fired', at: clock.now(), projectId, ticketId, payload: { job } }`.

- [ ] **Step 1: Write the failing tests**

`src/core/scheduler.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../store/sqlite-store.js';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  it('hands out slots up to capacity per queue', () => {
    const s = new Scheduler(new SqliteStore(':memory:'), { dev: 2, questions: 1 });
    expect(s.tryAcquire('dev', 'A')).toBe(0);
    expect(s.tryAcquire('dev', 'B')).toBe(1);
    expect(s.tryAcquire('dev', 'C')).toBeNull();
    expect(s.tryAcquire('questions', 'C')).toBe(0);
    expect(s.inUse('dev')).toBe(2);
    expect(s.hasFree('dev')).toBe(false);
    expect(s.hasFree('questions')).toBe(false);
  });

  it('reuses freed slot indexes', () => {
    const s = new Scheduler(new SqliteStore(':memory:'), { dev: 2, questions: 1 });
    s.tryAcquire('dev', 'A');
    s.tryAcquire('dev', 'B');
    expect(s.release('A')).toBe('dev');
    expect(s.tryAcquire('dev', 'C')).toBe(0);
  });

  it('refuses a second slot for the same ticket', () => {
    const s = new Scheduler(new SqliteStore(':memory:'), { dev: 3, questions: 1 });
    s.tryAcquire('dev', 'A');
    expect(s.tryAcquire('dev', 'A')).toBeNull();
  });
});
```
`src/core/timers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../store/sqlite-store.js';
import { FakeClock } from './clock.js';
import { TimerService } from './timers.js';
import type { RelaisEvent } from './types.js';

describe('TimerService', () => {
  it('emits debounce.fired once when due', () => {
    const store = new SqliteStore(':memory:');
    const clock = new FakeClock(0);
    const events: RelaisEvent[] = [];
    const svc = new TimerService(store, clock, (e) => events.push(e));
    store.putTimer({ key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 180_000 });
    svc.tick();
    expect(events).toEqual([]);
    clock.set(180_000);
    svc.tick();
    svc.tick();
    expect(events).toEqual([
      { id: 'timer:REL-1:dev-feedback:180000', type: 'debounce.fired', at: 180_000, projectId: 'p', ticketId: 'REL-1', payload: { job: 'dev-feedback' } },
    ]);
  });
});
```
Run: `npx vitest run src/core/scheduler.test.ts src/core/timers.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/core/scheduler.ts`:
```ts
import type { QueueItem, Store } from '../store/types.js';
import type { QueueName } from './types.js';

export class Scheduler {
  private held = new Map<string, { queue: QueueName; slot: number }>();

  constructor(
    private store: Store,
    private capacity: Record<QueueName, number>,
  ) {}

  setCapacity(capacity: Record<QueueName, number>): void {
    this.capacity = capacity;
  }

  tryAcquire(queue: QueueName, ticketId: string): number | null {
    if (this.held.has(ticketId)) return null;
    const used = new Set([...this.held.values()].filter((h) => h.queue === queue).map((h) => h.slot));
    for (let i = 0; i < this.capacity[queue]; i++) {
      if (!used.has(i)) {
        this.held.set(ticketId, { queue, slot: i });
        return i;
      }
    }
    return null;
  }

  release(ticketId: string): QueueName | undefined {
    const h = this.held.get(ticketId);
    this.held.delete(ticketId);
    return h?.queue;
  }

  inUse(queue: QueueName): number {
    return [...this.held.values()].filter((h) => h.queue === queue).length;
  }

  hasFree(queue: QueueName): boolean {
    return this.inUse(queue) < this.capacity[queue];
  }

  enqueue(item: QueueItem): void {
    this.store.enqueue(item);
  }

  next(queue: QueueName): QueueItem | undefined {
    return this.store.dequeue(queue);
  }
}
```
`src/core/timers.ts`:
```ts
import type { Store } from '../store/types.js';
import type { Clock } from './clock.js';
import type { RelaisEvent } from './types.js';

export class TimerService {
  private handle: NodeJS.Timeout | undefined;

  constructor(
    private store: Store,
    private clock: Clock,
    private emit: (e: RelaisEvent) => void,
  ) {}

  tick(): void {
    const now = this.clock.now();
    for (const t of this.store.dueTimers(now)) {
      this.store.deleteTimer(t.key);
      this.emit({
        id: `timer:${t.key}:${t.fireAt}`,
        type: 'debounce.fired',
        at: now,
        projectId: t.projectId,
        ticketId: t.ticketId,
        payload: { job: t.job },
      });
    }
  }

  start(intervalMs = 1000): void {
    this.stop();
    this.handle = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/core/scheduler.test.ts src/core/timers.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/scheduler.ts src/core/scheduler.test.ts src/core/timers.ts src/core/timers.test.ts
git commit -m "feat(core): add slot scheduler and persisted debounce timers"
```

### Task 8: Prompt builder

**Files:**
- Create: `src/core/prompt.ts`
- Test: `src/core/prompt.test.ts`

**Interfaces:**
- Consumes: `FeedbackItem`, `VerifyFailure`, `InputKind`
- Produces:
  ```ts
  interface PromptIssue { identifier: string; title: string; description: string; url: string }
  interface PromptInput { skill: string; issue: PromptIssue; branch?: string; prUrl?: string; promptContext?: string;
                          input?: { kind: InputKind; text: string }; reviewRounds: number }
  function buildPrompt(p: PromptInput): string
  function formatFeedback(items: FeedbackItem[]): string        // "- **Lilian** (2026-10-10 14:03 UTC) : texte"
  function formatVerifyFailures(failures: VerifyFailure[]): string  // per failure: "### `cmd` (code N)\n```\n<last 8000 chars>\n```"
  ```
  Output of `buildPrompt` (sections omitted when empty; exact headings):
  ```
  /<skill>

  ## Ticket <identifier> — <title>
  URL : <url>
  Branche : <branch>            (only if branch)
  PR : <prUrl>                  (only if prUrl)
  Rounds de review max : <n>    (only if skill ends with ':review')

  <description or "(pas de description)">

  ## Contexte Linear            (only if promptContext)
  <promptContext>

  ## <input heading>            (only if input)
  <input text>
  ```
  Input headings: `feedback` → `Retours à traiter`, `ci_failures` → `CI en échec`, `verify_failures` → `Vérifications en échec`, `thread` → `Message`.

- [ ] **Step 1: Write the failing test**

`src/core/prompt.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildPrompt, formatFeedback, formatVerifyFailures } from './prompt.js';

const issue = { identifier: 'REL-12', title: 'Export CSV', description: 'Exporter les audits.', url: 'https://linear.app/x/REL-12' };

describe('buildPrompt', () => {
  it('builds a dev prompt with branch', () => {
    expect(buildPrompt({ skill: 'relais:dev', issue, branch: 'relais/rel-12-export-csv', reviewRounds: 5 })).toBe(
      '/relais:dev\n\n## Ticket REL-12 — Export CSV\nURL : https://linear.app/x/REL-12\nBranche : relais/rel-12-export-csv\n\nExporter les audits.\n',
    );
  });

  it('adds review rounds, context and input sections', () => {
    const out = buildPrompt({
      skill: 'relais:review',
      issue: { ...issue, description: '' },
      promptContext: '<issue>…</issue>',
      input: { kind: 'feedback', text: '- **L** : x' },
      reviewRounds: 4,
    });
    expect(out).toContain('Rounds de review max : 4');
    expect(out).toContain('(pas de description)');
    expect(out).toContain('## Contexte Linear\n<issue>…</issue>');
    expect(out).toContain('## Retours à traiter\n- **L** : x');
  });
});

describe('formatters', () => {
  it('formats feedback with UTC time', () => {
    expect(formatFeedback([{ author: 'Lilian', body: 'boutons', at: Date.UTC(2026, 9, 10, 14, 3), source: 'session' }])).toBe(
      '- **Lilian** (2026-10-10 14:03 UTC) : boutons',
    );
  });
  it('keeps the tail of long outputs', () => {
    const out = formatVerifyFailures([{ command: 'npm test', exitCode: 1, output: 'x'.repeat(9000) + 'END' }]);
    expect(out.startsWith('### `npm test` (code 1)\n```\n')).toBe(true);
    expect(out).toContain('END');
    expect(out.length).toBeLessThan(8100);
  });
});
```
Run: `npx vitest run src/core/prompt.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/core/prompt.ts`:
```ts
import type { FeedbackItem, InputKind, VerifyFailure } from './types.js';

export interface PromptIssue {
  identifier: string;
  title: string;
  description: string;
  url: string;
}

export interface PromptInput {
  skill: string;
  issue: PromptIssue;
  branch?: string;
  prUrl?: string;
  promptContext?: string;
  input?: { kind: InputKind; text: string };
  reviewRounds: number;
}

const HEADINGS: Record<InputKind, string> = {
  feedback: 'Retours à traiter',
  ci_failures: 'CI en échec',
  verify_failures: 'Vérifications en échec',
  thread: 'Message',
};

export function buildPrompt(p: PromptInput): string {
  const lines = [`/${p.skill}`, '', `## Ticket ${p.issue.identifier} — ${p.issue.title}`, `URL : ${p.issue.url}`];
  if (p.branch) lines.push(`Branche : ${p.branch}`);
  if (p.prUrl) lines.push(`PR : ${p.prUrl}`);
  if (p.skill.endsWith(':review')) lines.push(`Rounds de review max : ${p.reviewRounds}`);
  lines.push('', p.issue.description.trim() || '(pas de description)', '');
  if (p.promptContext) lines.push('## Contexte Linear', p.promptContext, '');
  if (p.input) lines.push(`## ${HEADINGS[p.input.kind]}`, p.input.text, '');
  return lines.join('\n');
}

function utc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function formatFeedback(items: FeedbackItem[]): string {
  return items.map((i) => `- **${i.author}** (${utc(i.at)}) : ${i.body}`).join('\n');
}

const TAIL = 8000;

export function formatVerifyFailures(failures: VerifyFailure[]): string {
  return failures
    .map((f) => `### \`${f.command}\` (code ${f.exitCode ?? 'timeout'})\n\`\`\`\n${f.output.slice(-TAIL)}\n\`\`\``)
    .join('\n\n');
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/core/prompt.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/prompt.ts src/core/prompt.test.ts
git commit -m "feat(core): add prompt builder and feedback/verify formatters"
```

---

## M2 — Orchestrator

### Task 9: Adapter interfaces and in-memory fakes

**Files:**
- Create: `src/adapters/tracker/types.ts`, `src/adapters/tracker/fake.ts`, `src/adapters/forge/types.ts`, `src/adapters/forge/fake.ts`, `src/adapters/runner/types.ts`, `src/adapters/runner/channel.ts`, `src/adapters/runner/fake.ts`, `src/adapters/workspace/types.ts`, `src/adapters/workspace/fake.ts`
- Test: `src/adapters/runner/fake.test.ts`, `src/adapters/tracker/fake.test.ts`

**Interfaces:**
- Consumes: `RunLimits` (Task 4), `RunOutcome`, `FeedbackItem`, `branchName` (Task 2)
- Produces (exact):
  ```ts
  // tracker/types.ts
  interface TrackerIssue { identifier: string; title: string; description: string; url: string; stateName: string; stateType: string;
    labels: string[]; delegateId?: string; teamKey: string; priority: number; createdAt: number }
  type ActivityInput =
    | { type: 'thought' | 'response' | 'elicitation' | 'error'; body: string; ephemeral?: boolean }
    | { type: 'action'; action: string; parameter: string; result?: string; ephemeral?: boolean };
  interface SearchHit { identifier: string; title: string; url: string; stateName: string }
  interface Tracker { getIssue(identifier: string): Promise<TrackerIssue>; listDelegated(teamKey: string): Promise<TrackerIssue[]>;
    search(term: string): Promise<SearchHit[]>; moveTo(identifier: string, stateName: string): Promise<void>;
    setLabels(identifier: string, add: string[], remove: string[]): Promise<void>; comment(identifier: string, body: string): Promise<void>;
    activity(sessionId: string, a: ActivityInput): Promise<void>; addExternalUrl(sessionId: string, label: string, url: string): Promise<void>;
    ensureSession(identifier: string): Promise<string> }
  // forge/types.ts
  interface PrInfo { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; branch: string; checks: 'pending' | 'pass' | 'fail' | 'none'; failedChecks: string[] }
  interface Forge { findPr(repoPath: string, branch: string): Promise<PrInfo | undefined>;
    unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]> }
  // runner/types.ts
  type RunStreamEvent = { kind: 'init'; sessionId: string } | { kind: 'text'; text: string } | { kind: 'tool'; name: string; input: string }
    | { kind: 'tool_result'; isError: boolean } | { kind: 'result'; isError: boolean; costUsd: number; turns: number; text: string };
  interface RunRequest { runId: string; cwd: string; prompt: string; claudeSessionId: string; resume: boolean; model: string;
    pluginDir: string; settingsPath: string; readOnly: boolean; limits: RunLimits; env: Record<string, string> }
  interface RunResult { outcome: RunOutcome; costUsd: number; turns: number; lastText: string }
  interface RunHandle { readonly events: AsyncIterable<RunStreamEvent>; readonly done: Promise<RunResult>; stop(): void }
  interface Runner { start(req: RunRequest): RunHandle }
  // runner/channel.ts
  class Channel<T> implements AsyncIterable<T> { push(v: T): void; close(): void }
  // workspace/types.ts
  type WorkspaceKind = 'worktree' | 'trunk-readonly' | 'knowledge';
  interface WorkspaceRequest { projectId: string; repoPath: string; ticketId: string; title: string; kind: WorkspaceKind; slot: number;
    portBase: number; setup: string[]; runId: string }
  interface Workspace { path: string; port?: number; branch?: string }
  interface WorkspaceManager { prepare(req: WorkspaceRequest): Promise<Workspace>; cleanup(projectId: string, repoPath: string, ticketId: string): Promise<void>;
    remoteBranchExists(repoPath: string, prefix: string): Promise<boolean> }
  ```
  Fakes: `FakeTracker` (`issues: Map`, `calls: {method, args}[]`, `addIssue(p)`, `activities(sessionId?)`), `FakeForge` (`setPr(branch, pr)`, `setReviewComments(n, items)`), `FakeRunner` (`requests`, `enqueue(...scripts)`, `release(runId)`), `FakeWorkspaces` (`prepared`, `cleaned`, `remoteBranches`).
  Fake workspace paths: worktree `/tmp/relais-fake/<projectId>/<ticketId>` (branch `branchName(ticketId, title)`, port `portBase + slot`); trunk-readonly `/tmp/relais-fake/<projectId>/_trunk`; knowledge `/tmp/relais-fake/_kb/<runId>`.

- [ ] **Step 1: Write the failing tests**

`src/adapters/runner/fake.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeRunner } from './fake.js';
import type { RunRequest, RunStreamEvent } from './types.js';

const req = (runId: string): RunRequest => ({
  runId, cwd: '/w', prompt: 'p', claudeSessionId: 's', resume: false, model: 'sonnet',
  pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false, limits: { turns: 10, durationMs: 1000, usd: 1 }, env: {},
});

async function collect(it: AsyncIterable<RunStreamEvent>): Promise<RunStreamEvent[]> {
  const out: RunStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('FakeRunner', () => {
  it('replays a script and resolves with its outcome', async () => {
    const r = new FakeRunner();
    r.enqueue({ events: [{ kind: 'text', text: 'hello' }], outcome: 'success', costUsd: 0.2, turns: 2 });
    const h = r.start(req('r1'));
    expect(await collect(h.events)).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(await h.done).toEqual({ outcome: 'success', costUsd: 0.2, turns: 2, lastText: 'hello' });
    expect(r.requests).toHaveLength(1);
  });

  it('holds until released, and stop yields stopped', async () => {
    const r = new FakeRunner();
    r.enqueue({ hold: true }, { hold: true });
    const a = r.start(req('a'));
    const b = r.start(req('b'));
    r.release('a');
    expect((await a.done).outcome).toBe('success');
    b.stop();
    expect((await b.done).outcome).toBe('stopped');
  });
});
```
`src/adapters/tracker/fake.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeTracker } from './fake.js';

describe('FakeTracker', () => {
  it('moves issues and records activities', async () => {
    const t = new FakeTracker();
    t.addIssue({ identifier: 'REL-1', title: 'T' });
    await t.moveTo('REL-1', 'In Progress');
    expect((await t.getIssue('REL-1')).stateName).toBe('In Progress');
    const s = await t.ensureSession('REL-1');
    await t.activity(s, { type: 'thought', body: 'x' });
    expect(t.activities(s)).toEqual([{ type: 'thought', body: 'x' }]);
    await expect(t.getIssue('NOPE-1')).rejects.toThrow('unknown issue NOPE-1');
  });
});
```
Run: `npx vitest run src/adapters/runner/fake.test.ts src/adapters/tracker/fake.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement the interface files**

`src/adapters/tracker/types.ts`:
```ts
export interface TrackerIssue {
  identifier: string;
  title: string;
  description: string;
  url: string;
  stateName: string;
  stateType: string;
  labels: string[];
  delegateId?: string;
  teamKey: string;
  priority: number;
  createdAt: number;
}

export type ActivityInput =
  | { type: 'thought' | 'response' | 'elicitation' | 'error'; body: string; ephemeral?: boolean }
  | { type: 'action'; action: string; parameter: string; result?: string; ephemeral?: boolean };

export interface SearchHit {
  identifier: string;
  title: string;
  url: string;
  stateName: string;
}

export interface Tracker {
  getIssue(identifier: string): Promise<TrackerIssue>;
  listDelegated(teamKey: string): Promise<TrackerIssue[]>;
  search(term: string): Promise<SearchHit[]>;
  moveTo(identifier: string, stateName: string): Promise<void>;
  setLabels(identifier: string, add: string[], remove: string[]): Promise<void>;
  comment(identifier: string, body: string): Promise<void>;
  activity(sessionId: string, a: ActivityInput): Promise<void>;
  addExternalUrl(sessionId: string, label: string, url: string): Promise<void>;
  ensureSession(identifier: string): Promise<string>;
}
```
`src/adapters/forge/types.ts`:
```ts
import type { FeedbackItem } from '../../core/types.js';

export interface PrInfo {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  branch: string;
  checks: 'pending' | 'pass' | 'fail' | 'none';
  failedChecks: string[];
}

export interface Forge {
  findPr(repoPath: string, branch: string): Promise<PrInfo | undefined>;
  unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]>;
}
```
`src/adapters/runner/types.ts`:
```ts
import type { RunLimits } from '../../config/workflow-schema.js';
import type { RunOutcome } from '../../core/types.js';

export type RunStreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'tool_result'; isError: boolean }
  | { kind: 'result'; isError: boolean; costUsd: number; turns: number; text: string };

export interface RunRequest {
  runId: string;
  cwd: string;
  prompt: string;
  claudeSessionId: string;
  resume: boolean;
  model: string;
  pluginDir: string;
  settingsPath: string;
  readOnly: boolean;
  limits: RunLimits;
  env: Record<string, string>;
}

export interface RunResult {
  outcome: RunOutcome;
  costUsd: number;
  turns: number;
  lastText: string;
}

export interface RunHandle {
  readonly events: AsyncIterable<RunStreamEvent>;
  readonly done: Promise<RunResult>;
  stop(): void;
}

export interface Runner {
  start(req: RunRequest): RunHandle;
}
```
`src/adapters/workspace/types.ts`:
```ts
export type WorkspaceKind = 'worktree' | 'trunk-readonly' | 'knowledge';

export interface WorkspaceRequest {
  projectId: string;
  repoPath: string;
  ticketId: string;
  title: string;
  kind: WorkspaceKind;
  slot: number;
  portBase: number;
  setup: string[];
  runId: string;
}

export interface Workspace {
  path: string;
  port?: number;
  branch?: string;
}

export interface WorkspaceManager {
  prepare(req: WorkspaceRequest): Promise<Workspace>;
  cleanup(projectId: string, repoPath: string, ticketId: string): Promise<void>;
  remoteBranchExists(repoPath: string, prefix: string): Promise<boolean>;
}
```

- [ ] **Step 3: Implement channel and fakes**

`src/adapters/runner/channel.ts`:
```ts
export class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
```
`src/adapters/runner/fake.ts`:
```ts
import type { RunOutcome } from '../../core/types.js';
import { Channel } from './channel.js';
import type { RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from './types.js';

export interface FakeScript {
  events?: RunStreamEvent[];
  outcome?: RunOutcome;
  costUsd?: number;
  turns?: number;
  hold?: boolean;
}

export class FakeRunner implements Runner {
  requests: RunRequest[] = [];
  private scripts: FakeScript[] = [];
  private holds = new Map<string, () => void>();

  enqueue(...scripts: FakeScript[]): void {
    this.scripts.push(...scripts);
  }

  release(runId: string): void {
    this.holds.get(runId)?.();
  }

  start(req: RunRequest): RunHandle {
    this.requests.push(req);
    const s = this.scripts.shift() ?? {};
    const events = s.events ?? [{ kind: 'text', text: 'Terminé.' }];
    const ch = new Channel<RunStreamEvent>();
    for (const e of events) ch.push(e);
    let stopped = false;
    let releaseHold: () => void = () => {};
    const held = s.hold
      ? new Promise<void>((resolve) => {
          releaseHold = resolve;
          this.holds.set(req.runId, resolve);
        })
      : Promise.resolve();
    const lastText = [...events].reverse().find((e): e is Extract<RunStreamEvent, { kind: 'text' }> => e.kind === 'text')?.text ?? '';
    const done: Promise<RunResult> = held.then(() => {
      ch.close();
      this.holds.delete(req.runId);
      return { outcome: stopped ? 'stopped' : (s.outcome ?? 'success'), costUsd: s.costUsd ?? 0.1, turns: s.turns ?? 1, lastText };
    });
    return {
      events: ch,
      done,
      stop: () => {
        stopped = true;
        releaseHold();
      },
    };
  }
}
```
`src/adapters/tracker/fake.ts`:
```ts
import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from './types.js';

export class FakeTracker implements Tracker {
  issues = new Map<string, TrackerIssue>();
  calls: { method: string; args: unknown[] }[] = [];
  private sessions = 0;

  addIssue(p: Partial<TrackerIssue> & { identifier: string }): TrackerIssue {
    const issue: TrackerIssue = {
      title: 'Ticket',
      description: 'Description assez longue pour passer le contrôle de prise en charge.',
      url: `https://linear.app/test/issue/${p.identifier}`,
      stateName: 'Todo',
      stateType: 'unstarted',
      labels: [],
      teamKey: p.identifier.split('-')[0]!,
      priority: 0,
      createdAt: 0,
      ...p,
    };
    this.issues.set(issue.identifier, issue);
    return issue;
  }

  activities(sessionId?: string): ActivityInput[] {
    return this.calls
      .filter((c) => c.method === 'activity' && (!sessionId || c.args[0] === sessionId))
      .map((c) => c.args[1] as ActivityInput);
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private must(identifier: string): TrackerIssue {
    const i = this.issues.get(identifier);
    if (!i) throw new Error(`unknown issue ${identifier}`);
    return i;
  }

  async getIssue(identifier: string): Promise<TrackerIssue> {
    return { ...this.must(identifier) };
  }

  async listDelegated(teamKey: string): Promise<TrackerIssue[]> {
    return [...this.issues.values()].filter((i) => i.teamKey === teamKey && i.delegateId);
  }

  async search(term: string): Promise<SearchHit[]> {
    return [...this.issues.values()]
      .filter((i) => i.title.toLowerCase().includes(term.toLowerCase()))
      .map((i) => ({ identifier: i.identifier, title: i.title, url: i.url, stateName: i.stateName }));
  }

  async moveTo(identifier: string, stateName: string): Promise<void> {
    this.record('moveTo', identifier, stateName);
    this.must(identifier).stateName = stateName;
  }

  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    this.record('setLabels', identifier, add, remove);
    const i = this.must(identifier);
    i.labels = [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add])];
  }

  async comment(identifier: string, body: string): Promise<void> {
    this.record('comment', identifier, body);
  }

  async activity(sessionId: string, a: ActivityInput): Promise<void> {
    this.record('activity', sessionId, a);
  }

  async addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    this.record('addExternalUrl', sessionId, label, url);
  }

  async ensureSession(identifier: string): Promise<string> {
    this.record('ensureSession', identifier);
    return `fake-session-${++this.sessions}`;
  }
}
```
`src/adapters/forge/fake.ts`:
```ts
import type { FeedbackItem } from '../../core/types.js';
import type { Forge, PrInfo } from './types.js';

export class FakeForge implements Forge {
  private prs = new Map<string, PrInfo>();
  private comments = new Map<number, FeedbackItem[]>();

  setPr(branch: string, pr: Omit<PrInfo, 'branch'>): void {
    this.prs.set(branch, { ...pr, branch });
  }

  setReviewComments(prNumber: number, items: FeedbackItem[]): void {
    this.comments.set(prNumber, items);
  }

  async findPr(_repoPath: string, branch: string): Promise<PrInfo | undefined> {
    return this.prs.get(branch);
  }

  async unresolvedReviewComments(_repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    return this.comments.get(prNumber) ?? [];
  }
}
```
`src/adapters/workspace/fake.ts`:
```ts
import { branchName } from '../../core/naming.js';
import type { Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

export class FakeWorkspaces implements WorkspaceManager {
  prepared: WorkspaceRequest[] = [];
  cleaned: string[] = [];
  remoteBranches = new Set<string>();

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    this.prepared.push(req);
    if (req.kind === 'trunk-readonly') return { path: `/tmp/relais-fake/${req.projectId}/_trunk` };
    if (req.kind === 'knowledge') return { path: `/tmp/relais-fake/_kb/${req.runId}` };
    return {
      path: `/tmp/relais-fake/${req.projectId}/${req.ticketId}`,
      port: req.portBase + req.slot,
      branch: branchName(req.ticketId, req.title),
    };
  }

  async cleanup(_projectId: string, _repoPath: string, ticketId: string): Promise<void> {
    this.cleaned.push(ticketId);
  }

  async remoteBranchExists(_repoPath: string, prefix: string): Promise<boolean> {
    return [...this.remoteBranches].some((b) => b.startsWith(prefix));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/adapters/runner/fake.test.ts src/adapters/tracker/fake.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters
git commit -m "feat(adapters): add tracker, forge, runner and workspace interfaces with fakes"
```

### Task 10: Event bus, verifier, pickup checks and activity relay

**Files:**
- Create: `src/core/bus.ts`, `src/core/verify.ts`, `src/core/pickup.ts`, `src/adapters/tracker/activity-relay.ts`
- Test: `src/core/verify.test.ts`, `src/core/pickup.test.ts`, `src/adapters/tracker/activity-relay.test.ts`, `src/core/bus.test.ts`

**Interfaces:**
- Consumes: `RelaisEvent`, `Command`, `TicketState`, `VerifyFailure`, `RunStreamEvent`, `ActivityInput`, `TrackerIssue`, `WorkspaceManager`, `PickupCheck`
- Produces:
  ```ts
  type BusMessage =
    | { kind: 'event'; event: RelaisEvent }
    | { kind: 'command'; projectId: string; ticketId?: string; command: Command }
    | { kind: 'run'; runId: string; ticketId: string; ev: RunStreamEvent }
    | { kind: 'ticket'; ticket: TicketState }
    | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };
  class EventBus { subscribe(fn: (m: BusMessage) => void): () => void; publish(m: BusMessage): void }
  interface VerifyResult { ok: boolean; failures: VerifyFailure[] }
  type Verifier = (cwd: string, commands: string[], timeoutMs?: number) => Promise<VerifyResult>
  const runVerify: Verifier            // runs each command with `bash -lc`, sequentially, default timeout 15 min, output = stdout+stderr
  function pickupFailures(checks: PickupCheck[], issue: TrackerIssue, repoPath: string, workspaces: WorkspaceManager): Promise<string[]>
  class ActivityRelay { constructor(send: (a: ActivityInput) => Promise<void>, intervalMs?: number, now?: () => number);
                        push(ev: RunStreamEvent): void; flush(): Promise<void> }
  ```
  Pickup messages (French, exact): `has_description` → `La description fait moins de 30 caractères.`; `has_acceptance_criteria` → `La description ne contient pas de critères d'acceptation.`; `not_started` → `Une branche relais/<id-lowercase>-… existe déjà sur origin.`
  Activity mapping: `tool` → `{ type: 'action', action: name, parameter: first 120 chars of input, ephemeral: true }`; `text` → `{ type: 'thought', body: first 500 chars, ephemeral: true }`; other kinds ignored. At most one send per `intervalMs` (default 2000); the latest pending activity wins; `flush()` drops the pending one and waits for in-flight sends.

- [ ] **Step 1: Write the failing tests**

`src/core/bus.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EventBus, type BusMessage } from './bus.js';

describe('EventBus', () => {
  it('fans out and unsubscribes', () => {
    const bus = new EventBus();
    const got: BusMessage[] = [];
    const off = bus.subscribe((m) => got.push(m));
    const m: BusMessage = { kind: 'log', level: 'info', message: 'x', at: 1 };
    bus.publish(m);
    off();
    bus.publish(m);
    expect(got).toEqual([m]);
  });
});
```
`src/core/verify.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runVerify } from './verify.js';

describe('runVerify', () => {
  it('passes when every command exits 0', async () => {
    expect(await runVerify(process.cwd(), ['true', 'echo ok'])).toEqual({ ok: true, failures: [] });
  });

  it('collects failures with output and keeps going', async () => {
    const res = await runVerify(process.cwd(), ['echo boom >&2; exit 3', 'true', 'exit 1']);
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([
      { command: 'echo boom >&2; exit 3', exitCode: 3, output: 'boom\n' },
      { command: 'exit 1', exitCode: 1, output: '' },
    ]);
  });

  it('times out', async () => {
    const res = await runVerify(process.cwd(), ['sleep 5'], 200);
    expect(res.failures[0]).toMatchObject({ command: 'sleep 5', exitCode: null });
  });
});
```
`src/core/pickup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import type { TrackerIssue } from '../adapters/tracker/types.js';
import { pickupFailures } from './pickup.js';

const issue = (description: string): TrackerIssue => ({
  identifier: 'REL-3', title: 'T', description, url: 'u', stateName: 'Todo', stateType: 'unstarted', labels: [], teamKey: 'REL', priority: 0, createdAt: 0,
});

describe('pickupFailures', () => {
  it('returns no failure for a good ticket', async () => {
    const ws = new FakeWorkspaces();
    const d = 'Une description complète.\nCritères d’acceptation : export CSV.';
    expect(await pickupFailures(['has_description', 'not_started', 'has_acceptance_criteria'], issue(d), '/r', ws)).toEqual([]);
  });

  it('reports each failing check', async () => {
    const ws = new FakeWorkspaces();
    ws.remoteBranches.add('relais/rel-3-old');
    expect(await pickupFailures(['has_description', 'not_started', 'has_acceptance_criteria'], issue('court'), '/r', ws)).toEqual([
      'La description fait moins de 30 caractères.',
      'Une branche relais/rel-3-… existe déjà sur origin.',
      "La description ne contient pas de critères d'acceptation.",
    ]);
  });
});
```
`src/adapters/tracker/activity-relay.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityRelay } from './activity-relay.js';
import type { ActivityInput } from './types.js';

describe('ActivityRelay', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('throttles to one activity per interval, latest wins', async () => {
    const sent: ActivityInput[] = [];
    const relay = new ActivityRelay(async (a) => void sent.push(a), 2000, () => Date.now());
    relay.push({ kind: 'tool', name: 'Bash', input: 'npm test' });
    relay.push({ kind: 'text', text: 'first' });
    relay.push({ kind: 'text', text: 'second' });
    relay.push({ kind: 'result', isError: false, costUsd: 0, turns: 1, text: '' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([
      { type: 'action', action: 'Bash', parameter: 'npm test', ephemeral: true },
      { type: 'thought', body: 'second', ephemeral: true },
    ]);
  });

  it('flush drops the pending activity', async () => {
    const sent: ActivityInput[] = [];
    const relay = new ActivityRelay(async (a) => void sent.push(a), 2000, () => Date.now());
    relay.push({ kind: 'text', text: 'a' });
    relay.push({ kind: 'text', text: 'b' });
    await relay.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([{ type: 'thought', body: 'a', ephemeral: true }]);
  });
});
```
Run: `npx vitest run src/core/bus.test.ts src/core/verify.test.ts src/core/pickup.test.ts src/adapters/tracker/activity-relay.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/core/bus.ts`:
```ts
import type { RunStreamEvent } from '../adapters/runner/types.js';
import type { Command } from './commands.js';
import type { RelaisEvent, TicketState } from './types.js';

export type BusMessage =
  | { kind: 'event'; event: RelaisEvent }
  | { kind: 'command'; projectId: string; ticketId?: string; command: Command }
  | { kind: 'run'; runId: string; ticketId: string; ev: RunStreamEvent }
  | { kind: 'ticket'; ticket: TicketState }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };

export class EventBus {
  private subs = new Set<(m: BusMessage) => void>();

  subscribe(fn: (m: BusMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(m: BusMessage): void {
    for (const fn of this.subs) {
      try {
        fn(m);
      } catch {
        // a broken subscriber must never break the orchestrator
      }
    }
  }
}
```
`src/core/verify.ts`:
```ts
import { spawn } from 'node:child_process';
import type { VerifyFailure } from './types.js';

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
}

export type Verifier = (cwd: string, commands: string[], timeoutMs?: number) => Promise<VerifyResult>;

function runOne(cwd: string, command: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, output });
    });
  });
}

export const runVerify: Verifier = async (cwd, commands, timeoutMs = 15 * 60_000) => {
  const failures: VerifyFailure[] = [];
  for (const command of commands) {
    const { exitCode, output } = await runOne(cwd, command, timeoutMs);
    if (exitCode !== 0) failures.push({ command, exitCode, output });
  }
  return { ok: failures.length === 0, failures };
};
```
`src/core/pickup.ts`:
```ts
import type { TrackerIssue } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { PickupCheck } from '../config/workflow-schema.js';

export async function pickupFailures(
  checks: PickupCheck[],
  issue: TrackerIssue,
  repoPath: string,
  workspaces: WorkspaceManager,
): Promise<string[]> {
  const out: string[] = [];
  const prefix = `relais/${issue.identifier.toLowerCase()}-`;
  for (const check of checks) {
    if (check === 'has_description' && issue.description.trim().length < 30) {
      out.push('La description fait moins de 30 caractères.');
    }
    if (check === 'not_started' && (await workspaces.remoteBranchExists(repoPath, prefix))) {
      out.push(`Une branche ${prefix}… existe déjà sur origin.`);
    }
    if (check === 'has_acceptance_criteria' && !/(crit[eè]res? d['’]acceptation|acceptance criteria)/i.test(issue.description)) {
      out.push("La description ne contient pas de critères d'acceptation.");
    }
  }
  return out;
}
```
`src/adapters/tracker/activity-relay.ts`:
```ts
import type { RunStreamEvent } from '../runner/types.js';
import type { ActivityInput } from './types.js';

function toActivity(ev: RunStreamEvent): ActivityInput | undefined {
  if (ev.kind === 'tool') return { type: 'action', action: ev.name, parameter: ev.input.slice(0, 120), ephemeral: true };
  if (ev.kind === 'text' && ev.text.trim()) return { type: 'thought', body: ev.text.slice(0, 500), ephemeral: true };
  return undefined;
}

export class ActivityRelay {
  private last = Number.NEGATIVE_INFINITY;
  private pending: ActivityInput | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private send: (a: ActivityInput) => Promise<void>,
    private intervalMs = 2000,
    private now: () => number = Date.now,
  ) {}

  push(ev: RunStreamEvent): void {
    const a = toActivity(ev);
    if (!a) return;
    this.pending = a;
    const wait = this.last + this.intervalMs - this.now();
    if (wait <= 0) this.fire();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.fire();
      }, wait);
    }
  }

  private fire(): void {
    const a = this.pending;
    if (!a) return;
    this.pending = undefined;
    this.last = this.now();
    this.sending = this.sending.then(() => this.send(a)).catch(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    await this.sending;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/core/bus.test.ts src/core/verify.test.ts src/core/pickup.test.ts src/adapters/tracker/activity-relay.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/bus.ts src/core/bus.test.ts src/core/verify.ts src/core/verify.test.ts src/core/pickup.ts src/core/pickup.test.ts src/adapters/tracker/activity-relay.ts src/adapters/tracker/activity-relay.test.ts
git commit -m "feat(core): add event bus, verifier, pickup checks and activity relay"
```

### Task 11: Orchestrator

**Files:**
- Create: `src/core/orchestrator.ts`
- Test: `src/core/orchestrator.test.ts` (focused unit checks; full flows are Task 12)

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces:
  ```ts
  interface ProjectRuntime { id: string; repoPath: string; teamKey: string; workflow: Workflow }
  interface OrchestratorDeps {
    store: Store; clock: Clock; bus: EventBus; scheduler: Scheduler;
    tracker: Tracker; forge: Forge; runner: Runner; workspaces: WorkspaceManager; verify: Verifier;
    projects: ProjectRuntime[]; packDir: string;
    agentEnv: (run: RunRecord) => Record<string, string>;
    dailyBudgetUsd?: number; newId?: () => string; activityIntervalMs?: number;
    beforeRun?: (run: RunRecord) => Promise<void>;   // e.g. pull the knowledge repo; called right before runner.start
  }
  class Orchestrator {
    constructor(d: OrchestratorDeps)
    submit(event: RelaisEvent): Promise<void>   // serialised; never throws (errors go to the bus as log)
    idle(): Promise<void>                       // resolves when no event and no background run/verify is pending (tests, shutdown)
    recover(): void                             // at boot: every 'running' run -> 'failure', ticket unblocked->blocked with French reason
    project(id: string): ProjectRuntime
    isPaused(): boolean
    stopAll(): void                             // stop every live run handle (shutdown)
  }
  ```
  Rules the implementation must follow (from spec §7):
  - `submit` chains events on one promise; `handle` returns early when `store.recordEvent` returns false (idempotence).
  - Events with `projectId === '*'` are global controls (`control.pause` / `control.resume`), decided with the first project's workflow.
  - Ticket creation on unknown ticket only for `ticket.delegated`, `session.mentioned`, `command`, `session.prompted`; other events on unknown tickets are ignored (logged).
  - Bookkeeping before `decide`: `ticket.delegated` sets `linearSessionId` (if absent); `ticket.moved` with non-null `to` sets `logical`; `run.finished` releases the slot `<ticketId>:<queue>`, clears `activeRunId` for dev-queue runs, adds `costUsd`.
  - Dev-queue runs set `ticket.activeRunId`; question-queue runs never do.
  - `start_run` on a ticket with an active dev run or a verification in progress stores `pendingJob` (latest wins) instead of starting.
  - Paused, over daily budget, or no free slot → `scheduler.enqueue(...)`.
  - After `run.finished`, `verify.passed`, `verify.failed`: start `pendingJob` if the ticket is idle, then drain both queues.
  - `run_verify` and run pumping happen in the background (tracked for `idle()`); their resulting events are submitted, never awaited inside `handle` (no self-deadlock).
  - `stop_run` clears `pendingJob`, the ticket's queue entries and timers, then calls `handle.stop()`.
  - `move` writes an echo key `state:<ticketId>:<stateName>` valid 60 s before calling the tracker.
  - `labels` writes echo keys `label:<ticketId>:<name>` for added labels.
  - `post_output` posts `run.lastText.trim() || 'Terminé.'` as a `response` activity in the run's Linear session.
  - Linear session for a run: `opts.linearSessionId ?? ticket.linearSessionId ?? await tracker.ensureSession(ticketId)`; a dev-queue run stores it on the ticket if absent.
  - Claude session: resume only if the job resumes and `ticket.claudeSessionId` exists; the first dev-queue run stores its Claude session id on the ticket, later `session: new` jobs (review) never overwrite it, so feedback always resumes the dev session.
  - Feedback input = `pendingFeedback` + `forge.unresolvedReviewComments` (if `prNumber`), formatted by `formatFeedback`; empty → `(aucun retour écrit : relisez la PR et le fil Linear)`; `pendingFeedback` is emptied when the run starts.
  - Pickup checks run only for jobs with `pickup: true` and a ticket without `claudeSessionId`; failures → blocked + elicitation `Je ne peux pas commencer ce ticket :\n- …\nCorrigez puis répondez dans ce fil.`.
  - Any exception while launching → slot released, ticket blocked with `Erreur au lancement : <message>`, activity `error`.

- [ ] **Step 1: Write the failing tests**

`src/core/orchestrator.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeForge } from '../adapters/forge/fake.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { EventBus } from './bus.js';
import { FakeClock } from './clock.js';
import { Orchestrator } from './orchestrator.js';
import { Scheduler } from './scheduler.js';
import type { RelaisEvent } from './types.js';

function setup() {
  const packDir = join(import.meta.dirname, '../../packs/standard');
  const workflow = loadWorkflow({ packDir });
  const store = new SqliteStore(':memory:');
  const tracker = new FakeTracker();
  const runner = new FakeRunner();
  let n = 0;
  const orch = new Orchestrator({
    store, clock: new FakeClock(1_000), bus: new EventBus(), scheduler: new Scheduler(store, { dev: 3, questions: 2 }),
    tracker, forge: new FakeForge(), runner, workspaces: new FakeWorkspaces(), verify: async () => ({ ok: true, failures: [] }),
    projects: [{ id: 'p', repoPath: '/repo', teamKey: 'REL', workflow }], packDir,
    agentEnv: (r) => ({ RELAIS_RUN_TOKEN: r.token }), newId: () => `id-${++n}`, activityIntervalMs: 0,
  });
  return { store, tracker, runner, orch };
}

const delegated = (id = 'e1'): RelaisEvent => ({ id, type: 'ticket.delegated', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });

describe('Orchestrator', () => {
  it('ignores a duplicate event id', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.submit(delegated());
    await orch.idle();
    expect(runner.requests).toHaveLength(1);
  });

  it('ignores moves of tickets it does not manage', async () => {
    const { store, orch } = setup();
    await orch.submit({ id: 'm', type: 'ticket.moved', at: 1, projectId: 'p', ticketId: 'REL-9', payload: { from: 'todo', to: 'dev' } });
    await orch.idle();
    expect(store.getTicket('p', 'REL-9')).toBeUndefined();
  });

  it('passes the pack, settings and agent env to the runner', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.idle();
    const r = runner.requests[0]!;
    expect(r.pluginDir.endsWith('packs/standard')).toBe(true);
    expect(r.settingsPath.endsWith('packs/standard/settings.json')).toBe(true);
    expect(r.env['RELAIS_RUN_TOKEN']).toBeDefined();
    expect(r.env['PORT']).toBe('4200');
  });

  it('recover() blocks tickets whose run was interrupted', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    runner.enqueue({ hold: true });
    await orch.submit(delegated());
    orch.recover();
    const t = store.getTicket('p', 'REL-1')!;
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
    expect(store.runsByStatus('running')).toEqual([]);
  });
});
```
Run: `npx vitest run src/core/orchestrator.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/core/orchestrator.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Forge } from '../adapters/forge/types.js';
import type { RunHandle, Runner } from '../adapters/runner/types.js';
import { ActivityRelay } from '../adapters/tracker/activity-relay.js';
import type { Tracker } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { JobSpec, Workflow } from '../config/workflow-schema.js';
import type { RunRecord, Store } from '../store/types.js';
import type { EventBus } from './bus.js';
import type { Clock } from './clock.js';
import type { Command } from './commands.js';
import { decide } from './engine.js';
import { pickupFailures } from './pickup.js';
import { buildPrompt, formatFeedback, formatVerifyFailures } from './prompt.js';
import type { Scheduler } from './scheduler.js';
import {
  newTicketState,
  type EventType,
  type InputKind,
  type LogicalState,
  type QueueName,
  type RelaisEvent,
  type TicketState,
  type VerifyFailure,
} from './types.js';
import type { Verifier } from './verify.js';

export interface ProjectRuntime {
  id: string;
  repoPath: string;
  teamKey: string;
  workflow: Workflow;
}

export interface OrchestratorDeps {
  store: Store;
  clock: Clock;
  bus: EventBus;
  scheduler: Scheduler;
  tracker: Tracker;
  forge: Forge;
  runner: Runner;
  workspaces: WorkspaceManager;
  verify: Verifier;
  projects: ProjectRuntime[];
  packDir: string;
  agentEnv: (run: RunRecord) => Record<string, string>;
  dailyBudgetUsd?: number;
  newId?: () => string;
  activityIntervalMs?: number;
  beforeRun?: (run: RunRecord) => Promise<void>;
}

interface StartOpts {
  job: string;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
}

const CREATES_TICKET = new Set<EventType>(['ticket.delegated', 'session.mentioned', 'command', 'session.prompted']);
const SETTLES_RUN = new Set<EventType>(['run.finished', 'verify.passed', 'verify.failed']);
const ECHO_MS = 60_000;

export function logicalFromName(states: Record<LogicalState, string>, name: string): LogicalState | undefined {
  return (Object.entries(states) as [LogicalState, string][]).find(([, n]) => n === name)?.[0];
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export class Orchestrator {
  private chain: Promise<void> = Promise.resolve();
  private background = new Set<Promise<void>>();
  private handles = new Map<string, RunHandle>();
  private verifying = new Set<string>();
  private newId: () => string;

  constructor(private d: OrchestratorDeps) {
    this.newId = d.newId ?? randomUUID;
  }

  submit(event: RelaisEvent): Promise<void> {
    const next = this.chain
      .then(() => this.handle(event))
      .catch((err: unknown) => this.log('error', `event ${event.id} (${event.type}): ${(err as Error).message}`));
    this.chain = next;
    return next;
  }

  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      await chain;
      await Promise.all([...this.background]);
      if (chain === this.chain && this.background.size === 0) return;
    }
  }

  recover(): void {
    const { store } = this.d;
    for (const run of store.runsByStatus('running')) {
      store.putRun({ ...run, status: 'failure', endedAt: this.d.clock.now() });
      const t = store.getTicket(run.projectId, run.ticketId);
      if (t && t.activeRunId === run.id) {
        t.activeRunId = undefined;
        t.blocked = true;
        t.blockReason = 'Relais a redémarré pendant le run. Répondez dans le fil pour relancer.';
        store.putTicket(t);
      }
    }
  }

  stopAll(): void {
    for (const h of this.handles.values()) h.stop();
  }

  project(id: string): ProjectRuntime {
    const p = this.d.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    return p;
  }

  isPaused(): boolean {
    return this.d.store.getMeta('paused') === '1';
  }

  private overBudget(): boolean {
    const budget = this.d.dailyBudgetUsd;
    return budget !== undefined && this.d.store.costSince(startOfUtcDay(this.d.clock.now())) >= budget;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.d.bus.publish({ kind: 'log', level, message, at: this.d.clock.now() });
  }

  private track(p: Promise<void>): void {
    const wrapped = p.catch((err: unknown) => this.log('error', (err as Error).message)).finally(() => this.background.delete(wrapped));
    this.background.add(wrapped);
  }

  private putTicket(t: TicketState): void {
    t.updatedAt = this.d.clock.now();
    this.d.store.putTicket(t);
    this.d.bus.publish({ kind: 'ticket', ticket: t });
  }

  private ticket(projectId: string, ticketId: string): TicketState {
    const t = this.d.store.getTicket(projectId, ticketId);
    if (!t) throw new Error(`unknown ticket ${ticketId}`);
    return t;
  }

  private async createTicket(project: ProjectRuntime, ticketId: string): Promise<TicketState> {
    const issue = await this.d.tracker.getIssue(ticketId);
    const logical = logicalFromName(project.workflow.states, issue.stateName) ?? 'todo';
    const t = newTicketState(project.id, ticketId, issue.title, logical, this.d.clock.now(), issue.priority);
    this.putTicket(t);
    return t;
  }

  private async handle(event: RelaisEvent): Promise<void> {
    const { store, bus } = this.d;
    if (!store.recordEvent(event)) return;
    bus.publish({ kind: 'event', event });

    if (event.projectId === '*') {
      const workflow = this.d.projects[0]?.workflow;
      if (!workflow) return;
      for (const c of decide(event, undefined, { workflow })) await this.exec(this.d.projects[0]!, undefined, c);
      return;
    }

    const project = this.project(event.projectId);
    let ticket = event.ticketId ? store.getTicket(project.id, event.ticketId) : undefined;
    if (!ticket && event.ticketId) {
      if (!CREATES_TICKET.has(event.type)) {
        this.log('info', `ignored ${event.type} for unmanaged ticket ${event.ticketId}`);
        return;
      }
      ticket = await this.createTicket(project, event.ticketId);
    }

    let activeJob = ticket?.activeRunId ? store.getRun(ticket.activeRunId)?.job : undefined;
    if (ticket) {
      if (event.type === 'ticket.delegated' && event.payload.linearSessionId && !ticket.linearSessionId) {
        ticket.linearSessionId = event.payload.linearSessionId;
      }
      if (event.type === 'ticket.moved' && event.payload.to) ticket.logical = event.payload.to;
      if (event.type === 'run.finished') {
        const run = store.getRun(event.payload.runId);
        if (run) {
          this.d.scheduler.release(`${run.ticketId}:${run.queue}`);
          if (run.queue === 'dev' && ticket.activeRunId === run.id) ticket.activeRunId = undefined;
        }
        ticket.costUsd += event.payload.costUsd;
        activeJob = event.payload.job;
      }
      if (event.type === 'verify.passed' || event.type === 'verify.failed') this.verifying.delete(ticket.ticketId);
      this.putTicket(ticket);
    }

    const commands = decide(event, ticket, { workflow: project.workflow, activeJob });
    for (const c of commands) {
      bus.publish({ kind: 'command', projectId: project.id, ticketId: ticket?.ticketId, command: c });
      await this.exec(project, ticket?.ticketId, c);
    }

    if (ticket && SETTLES_RUN.has(event.type)) await this.settle(project, ticket.ticketId);
  }

  private async settle(project: ProjectRuntime, ticketId: string): Promise<void> {
    const t = this.ticket(project.id, ticketId);
    if (!t.activeRunId && !this.verifying.has(ticketId) && t.pendingJob) {
      const pending = t.pendingJob;
      t.pendingJob = undefined;
      this.putTicket(t);
      await this.startRun(project, ticketId, pending);
    }
    await this.drain('dev');
    await this.drain('questions');
  }

  private async drain(queue: QueueName): Promise<void> {
    const n = this.d.store.listQueue().filter((q) => q.queue === queue).length;
    for (let i = 0; i < n; i++) {
      if (this.isPaused() || this.overBudget() || !this.d.scheduler.hasFree(queue)) return;
      const item = this.d.scheduler.next(queue);
      if (!item) return;
      await this.startRun(this.project(item.projectId), item.ticketId, item);
    }
  }

  private async exec(project: ProjectRuntime, ticketId: string | undefined, c: Command): Promise<void> {
    const { store, tracker, clock } = this.d;
    if (c.kind === 'set_paused') {
      store.setMeta('paused', c.paused ? '1' : '0');
      if (!c.paused) {
        await this.drain('dev');
        await this.drain('questions');
      }
      return;
    }
    if (!ticketId) return;
    const t = this.ticket(project.id, ticketId);
    switch (c.kind) {
      case 'start_run':
        return this.startRun(project, ticketId, c);
      case 'stop_run': {
        t.pendingJob = undefined;
        this.putTicket(t);
        store.removeFromQueue(project.id, ticketId);
        store.deleteTimersFor(project.id, ticketId);
        if (t.activeRunId) this.handles.get(t.activeRunId)?.stop();
        return;
      }
      case 'run_verify': {
        const run = store.getRun(c.runId);
        const job = project.workflow.jobs[c.job];
        if (!run || !job) return;
        this.verifying.add(ticketId);
        this.track(
          (async () => {
            const res = await this.d.verify(run.cwd, job.verify);
            const base = { at: clock.now(), projectId: project.id, ticketId };
            const event: RelaisEvent = res.ok
              ? { ...base, id: `verify:${run.id}`, type: 'verify.passed', payload: { runId: run.id, job: job.name } }
              : { ...base, id: `verify:${run.id}`, type: 'verify.failed', payload: { runId: run.id, job: job.name, failures: res.failures } };
            void this.submit(event);
          })(),
        );
        return;
      }
      case 'move':
        return this.move(project, t, c.to);
      case 'labels': {
        for (const l of c.add) store.putEcho(`label:${ticketId}:${l}`, clock.now() + ECHO_MS);
        await tracker.setLabels(ticketId, c.add, c.remove);
        return;
      }
      case 'comment':
        return tracker.comment(ticketId, c.body);
      case 'activity': {
        const fromRun = c.runId ? store.getRun(c.runId)?.linearSessionId : undefined;
        const session = c.linearSessionId ?? fromRun ?? (await this.sessionFor(t));
        return tracker.activity(session, { type: c.type, body: c.body });
      }
      case 'post_output': {
        const run = store.getRun(c.runId);
        if (!run) return;
        const session = run.linearSessionId ?? (await this.sessionFor(t));
        return tracker.activity(session, { type: 'response', body: run.lastText.trim() || 'Terminé.' });
      }
      case 'link_pr':
        if (t.linearSessionId) await tracker.addExternalUrl(t.linearSessionId, 'Pull request', c.url);
        return;
      case 'set_debounce':
        store.putTimer({ key: `${ticketId}:${c.job}`, projectId: project.id, ticketId, job: c.job, fireAt: clock.now() + c.ms });
        return;
      case 'append_feedback':
        t.pendingFeedback.push(c.item);
        return this.putTicket(t);
      case 'cleanup':
        await this.d.workspaces.cleanup(project.id, project.repoPath, ticketId);
        t.worktreePath = undefined;
        t.port = undefined;
        return this.putTicket(t);
      case 'block':
        t.blocked = true;
        t.blockReason = c.reason;
        return this.putTicket(t);
      case 'unblock':
        t.blocked = false;
        t.blockReason = undefined;
        return this.putTicket(t);
      case 'patch_ticket':
        Object.assign(t, c.patch);
        return this.putTicket(t);
    }
  }

  private async sessionFor(t: TicketState): Promise<string> {
    if (t.linearSessionId) return t.linearSessionId;
    const s = await this.d.tracker.ensureSession(t.ticketId);
    t.linearSessionId = s;
    this.putTicket(t);
    return s;
  }

  private async move(project: ProjectRuntime, t: TicketState, to: LogicalState): Promise<void> {
    const stateName = project.workflow.states[to];
    this.d.store.putEcho(`state:${t.ticketId}:${stateName}`, this.d.clock.now() + ECHO_MS);
    await this.d.tracker.moveTo(t.ticketId, stateName);
    const fresh = this.ticket(project.id, t.ticketId);
    fresh.logical = to;
    this.putTicket(fresh);
  }

  private async startRun(project: ProjectRuntime, ticketId: string, opts: StartOpts): Promise<void> {
    const job = project.workflow.jobs[opts.job];
    if (!job) return this.log('error', `unknown job ${opts.job}`);
    const t = this.ticket(project.id, ticketId);
    const item = {
      projectId: project.id,
      ticketId,
      job: job.name,
      queue: job.queue,
      input: opts.input,
      inputText: opts.inputText,
      linearSessionId: opts.linearSessionId,
      resume: opts.resume,
      priority: t.priority,
      enqueuedAt: this.d.clock.now(),
    };
    if (job.queue === 'dev' && (t.activeRunId || this.verifying.has(ticketId))) {
      t.pendingJob = { job: job.name, input: opts.input, inputText: opts.inputText, resume: opts.resume };
      return this.putTicket(t);
    }
    if (this.isPaused() || this.overBudget()) return this.d.scheduler.enqueue(item);
    const key = `${ticketId}:${job.queue}`;
    const slot = this.d.scheduler.tryAcquire(job.queue, key);
    if (slot === null) return this.d.scheduler.enqueue(item);
    try {
      await this.launch(project, ticketId, job, opts, slot, key);
    } catch (err) {
      this.d.scheduler.release(key);
      const fresh = this.ticket(project.id, ticketId);
      fresh.blocked = true;
      fresh.blockReason = `Erreur au lancement : ${(err as Error).message}`;
      this.putTicket(fresh);
      const session = opts.linearSessionId ?? (await this.sessionFor(fresh));
      await this.d.tracker.activity(session, { type: 'error', body: fresh.blockReason });
    }
  }

  private async launch(project: ProjectRuntime, ticketId: string, job: JobSpec, opts: StartOpts, slot: number, key: string): Promise<void> {
    const { tracker, store, clock, workspaces, forge } = this.d;
    const wf = project.workflow;
    const issue = await tracker.getIssue(ticketId);
    let t = this.ticket(project.id, ticketId);

    if (job.pickup && !t.claudeSessionId) {
      const failures = await pickupFailures(wf.tracker.pickup.checks, issue, project.repoPath, workspaces);
      if (failures.length) {
        this.d.scheduler.release(key);
        t.blocked = true;
        t.blockReason = failures.join(' ');
        this.putTicket(t);
        const session = await this.sessionFor(t);
        await tracker.activity(session, {
          type: 'elicitation',
          body: `Je ne peux pas commencer ce ticket :\n${failures.map((f) => `- ${f}`).join('\n')}\nCorrigez puis répondez dans ce fil.`,
        });
        return;
      }
    }

    const runId = this.newId();
    const ws = await workspaces.prepare({
      projectId: project.id,
      repoPath: project.repoPath,
      ticketId,
      title: issue.title,
      kind: job.workspace,
      slot,
      portBase: wf.workspace.portBase,
      setup: wf.workspace.setup,
      runId,
    });
    t = this.ticket(project.id, ticketId);
    if (job.queue === 'dev') {
      t.worktreePath = ws.path;
      t.port = ws.port;
      if (ws.branch) t.branch = ws.branch;
      this.putTicket(t);
    }
    if (job.onStart.move && t.logical !== job.onStart.move) await this.move(project, t, job.onStart.move);
    t = this.ticket(project.id, ticketId);

    const linearSessionId = opts.linearSessionId ?? (await this.sessionFor(t));
    t = this.ticket(project.id, ticketId);

    const wantsResume = opts.resume ?? job.session === 'resume';
    const resume = wantsResume && !!t.claudeSessionId;
    const claudeSessionId = resume ? t.claudeSessionId! : this.newId();
    if (job.queue === 'dev' && !t.claudeSessionId) t.claudeSessionId = claudeSessionId;

    const kind = opts.input ?? job.input;
    let input: { kind: InputKind; text: string } | undefined;
    if (kind === 'feedback') {
      const items = [...t.pendingFeedback];
      if (t.prNumber) items.push(...(await forge.unresolvedReviewComments(project.repoPath, t.prNumber)));
      t.pendingFeedback = [];
      input = { kind, text: items.length ? formatFeedback(items) : '(aucun retour écrit : relisez la PR et le fil Linear)' };
    } else if (kind === 'verify_failures') {
      input = { kind, text: formatVerifyFailures(JSON.parse(opts.inputText ?? '[]') as VerifyFailure[]) };
    } else if (kind === 'ci_failures') {
      input = { kind, text: opts.inputText ?? 'La CI de la PR est en échec. Lancez `gh pr checks` pour le détail.' };
    } else if (kind === 'thread') {
      input = { kind, text: opts.inputText ?? '' };
    }

    const prompt = buildPrompt({
      skill: job.skill,
      issue: { identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.url },
      branch: job.queue === 'dev' ? t.branch : undefined,
      prUrl: t.prUrl,
      input,
      reviewRounds: wf.limits.reviewRounds,
    });

    const run: RunRecord = {
      id: runId,
      projectId: project.id,
      ticketId,
      job: job.name,
      queue: job.queue,
      status: 'running',
      claudeSessionId,
      linearSessionId,
      startedAt: clock.now(),
      costUsd: 0,
      turns: 0,
      lastText: '',
      token: this.newId(),
      cwd: ws.path,
    };
    store.putRun(run);
    if (job.queue === 'dev') t.activeRunId = runId;
    this.putTicket(t);
    if (this.d.beforeRun) await this.d.beforeRun(run).catch((err: Error) => this.log('warn', `beforeRun: ${err.message}`));

    const handle = this.d.runner.start({
      runId,
      cwd: ws.path,
      prompt,
      claudeSessionId,
      resume,
      model: job.model,
      pluginDir: this.d.packDir,
      settingsPath: join(this.d.packDir, 'settings.json'),
      readOnly: job.workspace === 'trunk-readonly',
      limits: job.limits,
      env: { ...this.d.agentEnv(run), ...(ws.port !== undefined ? { PORT: String(ws.port) } : {}) },
    });
    this.handles.set(runId, handle);
    this.track(this.pump(project, run, handle));
  }

  private async pump(project: ProjectRuntime, run: RunRecord, handle: RunHandle): Promise<void> {
    const { tracker, bus, store, clock } = this.d;
    const relay = new ActivityRelay(
      (a) => (run.linearSessionId ? tracker.activity(run.linearSessionId, a) : Promise.resolve()),
      this.d.activityIntervalMs ?? 2000,
      () => clock.now(),
    );
    for await (const ev of handle.events) {
      bus.publish({ kind: 'run', runId: run.id, ticketId: run.ticketId, ev });
      relay.push(ev);
    }
    const result = await handle.done;
    await relay.flush();
    this.handles.delete(run.id);
    const rec = store.getRun(run.id) ?? run;
    store.putRun({
      ...rec,
      status: result.outcome,
      endedAt: clock.now(),
      costUsd: result.costUsd,
      turns: result.turns,
      lastText: result.lastText,
    });
    await this.submit({
      id: `run:${run.id}:finished`,
      type: 'run.finished',
      at: clock.now(),
      projectId: project.id,
      ticketId: run.ticketId,
      payload: {
        runId: run.id,
        job: run.job,
        outcome: result.outcome,
        costUsd: result.costUsd,
        turns: result.turns,
        lastText: result.lastText,
      },
    });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/core/orchestrator.test.ts` — Expected: PASS. If `recover()` test sees the run already finished, check that the held FakeRunner run is not released (it must stay `running` until `recover()`).

- [ ] **Step 4: Commit**

```bash
git add src/core/orchestrator.ts src/core/orchestrator.test.ts
git commit -m "feat(core): add orchestrator executing engine commands through adapters"
```

### Task 12: End-to-end scenarios with fakes

**Files:**
- Create: `test/helpers/harness.ts`, `test/scenarios/workflow.test.ts`

**Interfaces:**
- Consumes: Orchestrator and all fakes.
- Produces: `createHarness(opts?: { projectYaml?: string; verify?: Verifier })` returning `{ clock, store, tracker, forge, runner, workspaces, orch, send, advance, ticket, project }` where `send(type, payload, ticketId = 'REL-1')` submits an event and waits for `idle()`, and `advance(ms)` moves the clock, ticks timers and waits for `idle()`.

- [ ] **Step 1: Write the harness**

`test/helpers/harness.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import { FakeRunner } from '../../src/adapters/runner/fake.js';
import { FakeTracker } from '../../src/adapters/tracker/fake.js';
import { FakeWorkspaces } from '../../src/adapters/workspace/fake.js';
import { loadWorkflow } from '../../src/config/load-workflow.js';
import { EventBus } from '../../src/core/bus.js';
import { FakeClock } from '../../src/core/clock.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { TimerService } from '../../src/core/timers.js';
import type { EventPayloads, EventType, RelaisEvent } from '../../src/core/types.js';
import type { Verifier } from '../../src/core/verify.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';

export const packDir = join(import.meta.dirname, '../../packs/standard');

export function createHarness(opts: { projectYaml?: string; verify?: Verifier } = {}) {
  let projectFile: string | undefined;
  if (opts.projectYaml) {
    projectFile = join(mkdtempSync(join(tmpdir(), 'relais-h-')), 'workflow.yml');
    writeFileSync(projectFile, opts.projectYaml);
  }
  const workflow = loadWorkflow({ packDir, projectFile });
  const clock = new FakeClock(Date.UTC(2026, 9, 10, 9, 0));
  const store = new SqliteStore(':memory:');
  const tracker = new FakeTracker();
  const forge = new FakeForge();
  const runner = new FakeRunner();
  const workspaces = new FakeWorkspaces();
  const project = { id: 'p', repoPath: '/repo', teamKey: 'REL', workflow };
  let n = 0;
  const orch = new Orchestrator({
    store,
    clock,
    bus: new EventBus(),
    scheduler: new Scheduler(store, { dev: workflow.limits.parallelSessions, questions: workflow.limits.questionSessions }),
    tracker,
    forge,
    runner,
    workspaces,
    verify: opts.verify ?? (async () => ({ ok: true, failures: [] })),
    projects: [project],
    packDir,
    agentEnv: (r) => ({ RELAIS_RUN_TOKEN: r.token }),
    newId: () => `id-${++n}`,
    activityIntervalMs: 0,
  });
  const timers = new TimerService(store, clock, (e) => void orch.submit(e));
  let seq = 0;

  async function send<T extends EventType>(type: T, payload: EventPayloads[T], ticketId = 'REL-1'): Promise<void> {
    await orch.submit({ id: `t-${++seq}`, type, at: clock.now(), projectId: 'p', ticketId, payload } as RelaisEvent);
    await orch.idle();
  }

  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    timers.tick();
    await orch.idle();
  }

  return { clock, store, tracker, forge, runner, workspaces, orch, send, advance, project, ticket: (id = 'REL-1') => store.getTicket('p', id)! };
}
```

- [ ] **Step 2: Write the scenarios (they should pass if Tasks 2–11 are correct; any failure is a bug to fix in the orchestrator, not in the test)**

`test/scenarios/workflow.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { createHarness } from '../helpers/harness.js';

async function delegatedAndInReview(h: ReturnType<typeof createHarness>) {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue({
    events: [
      { kind: 'init', sessionId: 'x' },
      { kind: 'tool', name: 'Bash', input: 'npm test' },
      { kind: 'text', text: 'PR ouverte, tests verts.' },
    ],
  });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

describe('standard workflow', () => {
  it('criterion 3: delegation -> dev run -> human review with summary', async () => {
    const h = createHarness();
    await delegatedAndInReview(h);
    const req = h.runner.requests[0]!;
    expect(req).toMatchObject({ resume: false, model: 'sonnet', cwd: '/tmp/relais-fake/p/REL-1', readOnly: false });
    expect(req.prompt.startsWith('/relais:dev\n')).toBe(true);
    expect(req.prompt).toContain('Branche : relais/rel-1-export-csv');
    const t = h.ticket();
    expect(t).toMatchObject({ logical: 'human_review', blocked: false, branch: 'relais/rel-1-export-csv', linearSessionId: 'ls-1' });
    expect(t.activeRunId).toBeUndefined();
    const moves = h.tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);
    expect(moves).toEqual(['In Progress', 'Human Review']);
    const acts = h.tracker.activities('ls-1');
    expect(acts).toContainEqual({ type: 'action', action: 'Bash', parameter: 'npm test', ephemeral: true });
    expect(acts.at(-1)).toEqual({ type: 'response', body: 'PR ouverte, tests verts.' });
  });

  it('criterion 4: two replies within the debounce window resume the same session once', async () => {
    const h = createHarness();
    await delegatedAndInReview(h);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé dans abc123.' }] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'Lilian' });
    await h.advance(60_000);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'bug quand la liste est vide', author: 'Lilian' });
    await h.advance(179_000);
    expect(h.runner.requests).toHaveLength(1);
    await h.advance(1_000);
    expect(h.runner.requests).toHaveLength(2);
    const r = h.runner.requests[1]!;
    expect(r.resume).toBe(true);
    expect(r.claudeSessionId).toBe(h.runner.requests[0]!.claudeSessionId);
    expect(r.prompt.startsWith('/relais:feedback\n')).toBe(true);
    expect(r.prompt).toContain('boutons mal alignés');
    expect(r.prompt).toContain('bug quand la liste est vide');
    expect(h.ticket()).toMatchObject({ logical: 'human_review', pendingFeedback: [] });
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: 'Corrigé dans abc123.' });
  });

  it('criterion 4b: a reply during a running feedback run is queued and runs after it', async () => {
    const h = createHarness();
    await delegatedAndInReview(h);
    h.runner.enqueue({ hold: true }, { events: [{ kind: 'text', text: 'Second passage.' }] });
    await h.send('ticket.moved', { from: 'human_review', to: 'dev' });
    const runningId = h.ticket().activeRunId!;
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'aussi le titre', author: 'L' });
    await h.advance(180_000);
    expect(h.runner.requests).toHaveLength(2);
    h.runner.release(runningId);
    await h.orch.idle();
    expect(h.runner.requests).toHaveLength(3);
    expect(h.runner.requests[2]!.prompt).toContain('aussi le titre');
  });

  it('criterion 5: AI review -> ready -> merge -> done, cleanup, learn', async () => {
    const h = createHarness();
    await delegatedAndInReview(h);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Synthèse : 2 rounds, CI verte.' }] });
    await h.send('ticket.moved', { from: 'human_review', to: 'ai_review' });
    expect(h.runner.requests[1]).toMatchObject({ model: 'opus', resume: false });
    expect(h.runner.requests[1]!.prompt).toContain('Rounds de review max : 5');
    expect(h.ticket().logical).toBe('ready');
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: 'Synthèse : 2 rounds, CI verte.' });
    await h.send('pr.merged', { number: 3, url: 'https://gh/pr/3', branch: 'relais/rel-1-export-csv' });
    expect(h.ticket().logical).toBe('done');
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(h.runner.requests.at(-1)!.prompt.startsWith('/relais:learn\n')).toBe(true);
    expect(h.runner.requests.at(-1)!.cwd).toMatch(/^\/tmp\/relais-fake\/_kb\//);
  });

  it('verification failures resume the session, then pass', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, failures: [{ command: 'npm test', exitCode: 1, output: '1 failed' }] })
      .mockResolvedValue({ ok: true, failures: [] });
    const h = createHarness({ projectYaml: 'version: 1\njobs:\n  dev: { verify: ["npm test"] }\n', verify });
    await delegatedAndInReview(h);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]).toMatchObject({ resume: true });
    expect(h.runner.requests[1]!.prompt).toContain('## Vérifications en échec');
    expect(h.runner.requests[1]!.prompt).toContain('1 failed');
    expect(h.ticket()).toMatchObject({ logical: 'human_review', verifyAttempts: 0 });
  });

  it('criterion 7: a stop request stops the running session and blocks', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = h.ticket().activeRunId!;
    await h.send('session.stopped', { linearSessionId: 'ls-1' });
    expect(h.store.getRun(runId)!.status).toBe('stopped');
    expect(h.ticket()).toMatchObject({ blocked: true });
    expect(h.ticket().activeRunId).toBeUndefined();
    expect(h.tracker.activities('ls-1').at(-1)!.type).toBe('response');
  });

  it('criterion 6: a mention runs ask read-only in its own thread', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Dans src/scores/history.ts.' }] });
    await h.send('session.mentioned', { linearSessionId: 'ls-9', body: 'où est calculé le score ?', author: 'L' });
    const r = h.runner.requests[0]!;
    expect(r).toMatchObject({ readOnly: true, cwd: '/tmp/relais-fake/p/_trunk' });
    expect(r.prompt).toContain('## Message\noù est calculé le score ?');
    expect(h.tracker.activities('ls-9').at(-1)).toEqual({ type: 'response', body: 'Dans src/scores/history.ts.' });
    expect(h.ticket()).toMatchObject({ logical: 'todo', blocked: false });
    expect(h.ticket().activeRunId).toBeUndefined();
  });

  it('criterion 6b: "retiens" runs remember in a knowledge workspace', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('command', { name: 'retiens', body: 'les agrégats se calculent côté serveur', linearSessionId: 'ls-10', author: 'L' });
    const r = h.runner.requests[0]!;
    expect(r.prompt.startsWith('/relais:learn\n')).toBe(true);
    expect(r.prompt).toContain('les agrégats se calculent côté serveur');
    expect(r.cwd).toMatch(/^\/tmp\/relais-fake\/_kb\//);
  });

  it('respects the parallel cap and drains the queue', async () => {
    const h = createHarness({ projectYaml: 'version: 1\nlimits: { parallel_sessions: 1 }\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Un' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Deux' });
    h.runner.enqueue({ hold: true }, {});
    await h.send('ticket.delegated', { linearSessionId: 'a' }, 'REL-1');
    await h.send('ticket.delegated', { linearSessionId: 'b' }, 'REL-2');
    expect(h.runner.requests).toHaveLength(1);
    expect(h.store.listQueue()).toHaveLength(1);
    h.runner.release(h.ticket('REL-1').activeRunId!);
    await h.orch.idle();
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]!.cwd).toBe('/tmp/relais-fake/p/REL-2');
  });

  it('a ticket failing pickup checks is blocked with an explanation', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Flou', description: 'trop court' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(0);
    expect(h.ticket().blocked).toBe(true);
    const last = h.tracker.activities('ls-1').at(-1)!;
    expect(last.type).toBe('elicitation');
  });
});
```

- [ ] **Step 3: Run the scenarios**

Run: `npx vitest run test/scenarios/workflow.test.ts` — Expected: PASS. A failing scenario means a bug in Tasks 5/9/10/11: fix the source, keep the scenario unchanged, and mention the fix in the commit message.

- [ ] **Step 4: Commit**

```bash
git add test
git commit -m "test: add end-to-end workflow scenarios with fake adapters"
```

---

## M3 — Linear

### Task 13: Linear GraphQL client, OAuth token handling and `LinearTracker`

**Files:**
- Create: `src/adapters/tracker/linear/api.ts`, `src/adapters/tracker/linear/queries.ts`, `src/adapters/tracker/linear/tracker.ts`, `src/adapters/tracker/linear/oauth.ts`
- Test: `src/adapters/tracker/linear/tracker.test.ts`, `src/adapters/tracker/linear/oauth.test.ts`, `src/adapters/tracker/linear/queries.live.test.ts`

**Interfaces:**
- Consumes: `Tracker`, `TrackerIssue`, `ActivityInput`, `SearchHit` (Task 9)
- Produces:
  ```ts
  // api.ts
  type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  class LinearApiError extends Error {}
  class LinearApi { constructor(getToken: () => Promise<string>, fetchImpl?: FetchLike, endpoint?: string);
                    gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> }
  // queries.ts
  const Q: Record<'issue' | 'delegated' | 'teamStates' | 'teamLabels' | 'team' | 'viewer' | 'search' | 'issueUpdate' | 'commentCreate' |
                  'activityCreate' | 'sessionUpdate' | 'sessionOnIssue' | 'stateCreate' | 'labelCreate', string>
  // tracker.ts
  class LinearTracker implements Tracker {
    constructor(api: LinearApi, appUserId: string)
    warm(teamKey: string): Promise<void>                       // loads states + labels into caches
    stateNameById(teamKey: string, id: string): string | undefined   // sync, from cache
    labelNameById(teamKey: string, id: string): string | undefined   // sync, from cache
    ensureSetup(teamKey: string, states: Record<LogicalState, string>, labels: string[]): Promise<string[]>  // returns created names
  }
  // oauth.ts
  const LINEAR_SCOPES = 'read,write,app:assignable,app:mentionable';
  function buildAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string }): string
  interface TokenSet { accessToken: string; refreshToken?: string; expiresAt?: number }
  function exchangeCode(o: { clientId: string; clientSecret: string; code: string; redirectUri: string; fetchImpl?: typeof fetch; now?: number }): Promise<TokenSet>
  function refreshToken(o: { clientId: string; clientSecret: string; refreshToken: string; fetchImpl?: typeof fetch; now?: number }): Promise<TokenSet>
  class TokenManager { constructor(o: { load: () => TokenSet | undefined; save: (t: TokenSet) => void; clientId: string; clientSecret: string; fetchImpl?: typeof fetch; now?: () => number });
                       get(): Promise<string> }   // refreshes when expiresAt - now < 5 min and a refresh token exists; throws 'Linear non connecté' if no token
  ```
  Linear details: OAuth authorize `https://linear.app/oauth/authorize` with `actor=app`; token endpoint `https://api.linear.app/oauth/token` (form-encoded, `grant_type=authorization_code` or `refresh_token`); GraphQL `https://api.linear.app/graphql` with header `Authorization: Bearer <token>`.
  New workflow states are created with type `unstarted` (todo), `started` (dev, human_review, ai_review, ready), `completed` (done) and color `#5e6ad2`; labels with color `#26b5ce`.

- [ ] **Step 1: Write the GraphQL documents**

`src/adapters/tracker/linear/queries.ts`:
```ts
const ISSUE_FIELDS = `id identifier title description url priority createdAt
  state { id name type } labels { nodes { id name } } delegate { id } team { id key }`;

export const Q = {
  issue: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
  delegated: `query Delegated($teamKey: String!, $appUserId: ID!) {
    issues(first: 100, filter: { team: { key: { eq: $teamKey } }, delegate: { id: { eq: $appUserId } },
      state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } }`,
  teamStates: `query TeamStates($teamKey: String!) { workflowStates(first: 100, filter: { team: { key: { eq: $teamKey } } }) { nodes { id name type position } } }`,
  teamLabels: `query TeamLabels($teamKey: String!) { issueLabels(first: 250, filter: { team: { key: { eq: $teamKey } } }) { nodes { id name } } }`,
  team: `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }`,
  viewer: `query Viewer { viewer { id name } organization { id name } }`,
  search: `query Search($term: String!) { searchIssues(term: $term, first: 10) { nodes { identifier title url state { name } } } }`,
  issueUpdate: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
  commentCreate: `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
  activityCreate: `mutation ActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
  sessionUpdate: `mutation SessionUpdate($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
  sessionOnIssue: `mutation SessionOnIssue($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { success agentSession { id } } }`,
  stateCreate: `mutation StateCreate($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success workflowState { id name } } }`,
  labelCreate: `mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`,
} as const;
```

- [ ] **Step 2: Write the live schema check (skipped without a key)**

`src/adapters/tracker/linear/queries.live.test.ts`:
```ts
import { buildClientSchema, getIntrospectionQuery, parse, validate, type IntrospectionQuery } from 'graphql';
import { describe, expect, it } from 'vitest';
import { Q } from './queries.js';

const key = process.env['LINEAR_API_KEY'];

describe.skipIf(!key)('Linear documents against the live schema', () => {
  it('every document validates', async () => {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key! },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    const { data } = (await res.json()) as { data: IntrospectionQuery };
    const schema = buildClientSchema(data);
    for (const [name, doc] of Object.entries(Q)) {
      const errors = validate(schema, parse(doc)).map((e) => e.message);
      expect({ name, errors }).toEqual({ name, errors: [] });
    }
  });
});
```
If this test is run later with a real key and reports a wrong type or field name (for example the input type of `agentSessionCreateOnIssue`, or `ephemeral` placement), fix `queries.ts` / `tracker.ts` to the names it reports.

- [ ] **Step 3: Write the failing tracker and OAuth tests**

`src/adapters/tracker/linear/tracker.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { LinearApi, type FetchLike } from './api.js';
import { LinearTracker } from './tracker.js';

type Handler = (vars: Record<string, any>) => unknown;

function fakeLinear(handlers: Record<string, Handler>) {
  const calls: { op: string; vars: Record<string, any> }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, any> };
    const op = /^(?:query|mutation)\s+(\w+)/.exec(query.trim())![1]!;
    calls.push({ op, vars: variables });
    const h = handlers[op];
    if (!h) return { ok: true, status: 200, json: async () => ({ errors: [{ message: `no handler for ${op}` }] }) };
    return { ok: true, status: 200, json: async () => ({ data: h(variables) }) };
  };
  return { api: new LinearApi(async () => 'tok', fetchImpl), calls };
}

const node = {
  id: 'uuid-1', identifier: 'REL-1', title: 'Export', description: 'Desc', url: 'https://linear.app/x/REL-1', priority: 2,
  createdAt: '2026-10-10T08:00:00.000Z', state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
  labels: { nodes: [{ id: 'l1', name: 'bug' }] }, delegate: { id: 'app-1' }, team: { id: 't-1', key: 'REL' },
};
const states = { workflowStates: { nodes: [
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 's-dev', name: 'In Progress', type: 'started', position: 1 },
] } };

describe('LinearTracker', () => {
  it('maps an issue', async () => {
    const { api } = fakeLinear({ Issue: () => ({ issue: node }) });
    expect(await new LinearTracker(api, 'app-1').getIssue('REL-1')).toEqual({
      identifier: 'REL-1', title: 'Export', description: 'Desc', url: 'https://linear.app/x/REL-1', stateName: 'Todo', stateType: 'unstarted',
      labels: ['bug'], delegateId: 'app-1', teamKey: 'REL', priority: 2, createdAt: Date.parse('2026-10-10T08:00:00.000Z'),
    });
  });

  it('moves by state name', async () => {
    const { api, calls } = fakeLinear({ Issue: () => ({ issue: node }), TeamStates: () => states, IssueUpdate: () => ({ issueUpdate: { success: true } }) });
    await new LinearTracker(api, 'app-1').moveTo('REL-1', 'In Progress');
    expect(calls.at(-1)).toEqual({ op: 'IssueUpdate', vars: { id: 'uuid-1', input: { stateId: 's-dev' } } });
  });

  it('fails clearly on an unknown state', async () => {
    const { api } = fakeLinear({ Issue: () => ({ issue: node }), TeamStates: () => states });
    await expect(new LinearTracker(api, 'app-1').moveTo('REL-1', 'Nope')).rejects.toThrow('Statut Linear introuvable : "Nope" (équipe REL)');
  });

  it('posts activities with ephemeral flag and action content', async () => {
    const { api, calls } = fakeLinear({ ActivityCreate: () => ({ agentActivityCreate: { success: true } }) });
    const t = new LinearTracker(api, 'app-1');
    await t.activity('as-1', { type: 'action', action: 'Bash', parameter: 'npm test', ephemeral: true });
    await t.activity('as-1', { type: 'response', body: 'Fini' });
    expect(calls.map((c) => c.vars)).toEqual([
      { input: { agentSessionId: 'as-1', content: { type: 'action', action: 'Bash', parameter: 'npm test' }, ephemeral: true } },
      { input: { agentSessionId: 'as-1', content: { type: 'response', body: 'Fini' } } },
    ]);
  });

  it('creates missing labels when adding them', async () => {
    const { api, calls } = fakeLinear({
      Issue: () => ({ issue: node }),
      TeamLabels: () => ({ issueLabels: { nodes: [{ id: 'l1', name: 'bug' }] } }),
      Team: () => ({ teams: { nodes: [{ id: 't-1', key: 'REL', name: 'Relais' }] } }),
      LabelCreate: (v) => ({ issueLabelCreate: { success: true, issueLabel: { id: 'l2', name: v.input.name } } }),
      IssueUpdate: () => ({ issueUpdate: { success: true } }),
    });
    await new LinearTracker(api, 'app-1').setLabels('REL-1', ['agent:stop'], ['bug']);
    expect(calls.find((c) => c.op === 'LabelCreate')!.vars).toEqual({ input: { name: 'agent:stop', teamId: 't-1', color: '#26b5ce' } });
    expect(calls.at(-1)!.vars).toEqual({ id: 'uuid-1', input: { addedLabelIds: ['l2'], removedLabelIds: ['l1'] } });
  });

  it('ensureSetup creates only the missing states', async () => {
    const { api, calls } = fakeLinear({
      TeamStates: () => states,
      TeamLabels: () => ({ issueLabels: { nodes: [] } }),
      Team: () => ({ teams: { nodes: [{ id: 't-1', key: 'REL', name: 'Relais' }] } }),
      StateCreate: (v) => ({ workflowStateCreate: { success: true, workflowState: { id: 'x', name: v.input.name } } }),
      LabelCreate: (v) => ({ issueLabelCreate: { success: true, issueLabel: { id: 'y', name: v.input.name } } }),
    });
    const created = await new LinearTracker(api, 'app-1').ensureSetup(
      'REL',
      { todo: 'Todo', dev: 'In Progress', human_review: 'Human Review', ai_review: 'AI Review', ready: 'Ready to Merge', done: 'Done' },
      ['agent:reprendre'],
    );
    expect(created).toEqual(['Human Review', 'AI Review', 'Ready to Merge', 'Done', 'agent:reprendre']);
    expect(calls.find((c) => c.op === 'StateCreate')!.vars).toEqual({ input: { name: 'Human Review', teamId: 't-1', type: 'started', color: '#5e6ad2' } });
  });

  it('creates a session on an issue', async () => {
    const { api } = fakeLinear({
      Issue: () => ({ issue: node }),
      SessionOnIssue: () => ({ agentSessionCreateOnIssue: { success: true, agentSession: { id: 'as-9' } } }),
    });
    expect(await new LinearTracker(api, 'app-1').ensureSession('REL-1')).toBe('as-9');
  });

  it('surfaces GraphQL errors', async () => {
    const { api } = fakeLinear({});
    await expect(api.gql('query Missing { x }')).rejects.toThrow('no handler for Missing');
  });
});
```
`src/adapters/tracker/linear/oauth.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, exchangeCode, TokenManager, type TokenSet } from './oauth.js';

describe('oauth', () => {
  it('builds an app-actor authorize URL', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:4100/oauth/callback', state: 'xyz' }));
    expect(u.origin + u.pathname).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'cid', redirect_uri: 'http://localhost:4100/oauth/callback', response_type: 'code',
      scope: 'read,write,app:assignable,app:mentionable', actor: 'app', state: 'xyz',
    });
  });

  it('exchanges a code', async () => {
    let body = '';
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', redirectUri: 'r', fetchImpl, now: 1000 });
    expect(t).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3_600_000 });
    expect(new URLSearchParams(body).get('grant_type')).toBe('authorization_code');
  });

  it('refreshes a token about to expire', async () => {
    let saved: TokenSet | undefined;
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }))) as unknown as typeof fetch;
    const m = new TokenManager({
      load: () => ({ accessToken: 'old', refreshToken: 'rt', expiresAt: 1000 + 60_000 }),
      save: (t) => (saved = t),
      clientId: 'c', clientSecret: 's', fetchImpl, now: () => 1000,
    });
    expect(await m.get()).toBe('new');
    expect(saved).toEqual({ accessToken: 'new', refreshToken: 'rt2', expiresAt: 1000 + 3_600_000 });
  });

  it('throws when not connected', async () => {
    const m = new TokenManager({ load: () => undefined, save: () => {}, clientId: 'c', clientSecret: 's' });
    await expect(m.get()).rejects.toThrow('Linear non connecté');
  });
});
```
Run: `npx vitest run src/adapters/tracker/linear` — Expected: FAIL (live test skipped).

- [ ] **Step 4: Implement api.ts and oauth.ts**

`src/adapters/tracker/linear/api.ts`:
```ts
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class LinearApiError extends Error {}

export class LinearApi {
  constructor(
    private getToken: () => Promise<string>,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private endpoint = 'https://api.linear.app/graphql',
  ) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.getToken()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new LinearApiError(json.errors.map((e) => e.message).join('; '));
    if (!res.ok) throw new LinearApiError(`HTTP ${res.status}`);
    return json.data as T;
  }
}
```
`src/adapters/tracker/linear/oauth.ts`:
```ts
export const LINEAR_SCOPES = 'read,write,app:assignable,app:mentionable';
const TOKEN_URL = 'https://api.linear.app/oauth/token';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export function buildAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL('https://linear.app/oauth/authorize');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', LINEAR_SCOPES);
  u.searchParams.set('actor', 'app');
  u.searchParams.set('state', o.state);
  return u.toString();
}

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch, now: number): Promise<TokenSet> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`OAuth Linear refusé : ${json.error ?? res.status}`);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? now + json.expires_in * 1000 : undefined,
  };
}

export function exchangeCode(o: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: 'authorization_code', code: o.code, redirect_uri: o.redirectUri, client_id: o.clientId, client_secret: o.clientSecret },
    o.fetchImpl ?? fetch,
    o.now ?? Date.now(),
  );
}

export function refreshToken(o: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, client_secret: o.clientSecret },
    o.fetchImpl ?? fetch,
    o.now ?? Date.now(),
  );
}

export class TokenManager {
  private inflight: Promise<string> | undefined;

  constructor(
    private o: {
      load: () => TokenSet | undefined;
      save: (t: TokenSet) => void;
      clientId: string;
      clientSecret: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  async get(): Promise<string> {
    const t = this.o.load();
    if (!t) throw new Error('Linear non connecté');
    const now = (this.o.now ?? Date.now)();
    if (!t.expiresAt || !t.refreshToken || t.expiresAt - now > 5 * 60_000) return t.accessToken;
    this.inflight ??= refreshToken({
      clientId: this.o.clientId,
      clientSecret: this.o.clientSecret,
      refreshToken: t.refreshToken,
      fetchImpl: this.o.fetchImpl,
      now,
    })
      .then((fresh) => {
        const merged = { ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken };
        this.o.save(merged);
        return merged.accessToken;
      })
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }
}
```

- [ ] **Step 5: Implement tracker.ts**

`src/adapters/tracker/linear/tracker.ts`:
```ts
import type { LogicalState } from '../../../core/types.js';
import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from '../types.js';
import type { LinearApi } from './api.js';
import { Q } from './queries.js';

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  createdAt: string;
  state: { id: string; name: string; type: string };
  labels: { nodes: { id: string; name: string }[] };
  delegate: { id: string } | null;
  team: { id: string; key: string };
}
interface StateNode {
  id: string;
  name: string;
  type: string;
  position: number;
}

const STATE_TYPES: Record<LogicalState, string> = {
  todo: 'unstarted',
  dev: 'started',
  human_review: 'started',
  ai_review: 'started',
  ready: 'started',
  done: 'completed',
};

const teamOf = (identifier: string) => identifier.split('-')[0]!;

function toIssue(n: IssueNode): TrackerIssue {
  return {
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    url: n.url,
    stateName: n.state.name,
    stateType: n.state.type,
    labels: n.labels.nodes.map((l) => l.name),
    delegateId: n.delegate?.id,
    teamKey: n.team.key,
    priority: n.priority,
    createdAt: Date.parse(n.createdAt),
  };
}

export class LinearTracker implements Tracker {
  private states = new Map<string, StateNode[]>();
  private labels = new Map<string, Map<string, string>>();
  private teamIds = new Map<string, string>();
  private issueIds = new Map<string, string>();

  constructor(
    private api: LinearApi,
    private appUserId: string,
  ) {}

  private async node(identifier: string): Promise<IssueNode> {
    const { issue } = await this.api.gql<{ issue: IssueNode | null }>(Q.issue, { id: identifier });
    if (!issue) throw new Error(`Ticket Linear introuvable : ${identifier}`);
    this.issueIds.set(identifier, issue.id);
    return issue;
  }

  private async issueId(identifier: string): Promise<string> {
    return this.issueIds.get(identifier) ?? (await this.node(identifier)).id;
  }

  private async teamId(teamKey: string): Promise<string> {
    const cached = this.teamIds.get(teamKey);
    if (cached) return cached;
    const { teams } = await this.api.gql<{ teams: { nodes: { id: string }[] } }>(Q.team, { key: teamKey });
    const id = teams.nodes[0]?.id;
    if (!id) throw new Error(`Équipe Linear introuvable : ${teamKey}`);
    this.teamIds.set(teamKey, id);
    return id;
  }

  private async teamStates(teamKey: string, refresh = false): Promise<StateNode[]> {
    if (!refresh && this.states.has(teamKey)) return this.states.get(teamKey)!;
    const { workflowStates } = await this.api.gql<{ workflowStates: { nodes: StateNode[] } }>(Q.teamStates, { teamKey });
    this.states.set(teamKey, workflowStates.nodes);
    return workflowStates.nodes;
  }

  private async teamLabels(teamKey: string, refresh = false): Promise<Map<string, string>> {
    if (!refresh && this.labels.has(teamKey)) return this.labels.get(teamKey)!;
    const { issueLabels } = await this.api.gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(Q.teamLabels, { teamKey });
    const map = new Map(issueLabels.nodes.map((l) => [l.name, l.id]));
    this.labels.set(teamKey, map);
    return map;
  }

  async warm(teamKey: string): Promise<void> {
    await this.teamStates(teamKey, true);
    await this.teamLabels(teamKey, true);
  }

  stateNameById(teamKey: string, id: string): string | undefined {
    return this.states.get(teamKey)?.find((s) => s.id === id)?.name;
  }

  labelNameById(teamKey: string, id: string): string | undefined {
    for (const [name, lid] of this.labels.get(teamKey) ?? []) if (lid === id) return name;
    return undefined;
  }

  async getIssue(identifier: string): Promise<TrackerIssue> {
    return toIssue(await this.node(identifier));
  }

  async listDelegated(teamKey: string): Promise<TrackerIssue[]> {
    const { issues } = await this.api.gql<{ issues: { nodes: IssueNode[] } }>(Q.delegated, { teamKey, appUserId: this.appUserId });
    for (const n of issues.nodes) this.issueIds.set(n.identifier, n.id);
    return issues.nodes.map(toIssue);
  }

  async search(term: string): Promise<SearchHit[]> {
    const { searchIssues } = await this.api.gql<{
      searchIssues: { nodes: { identifier: string; title: string; url: string; state: { name: string } }[] };
    }>(Q.search, { term });
    return searchIssues.nodes.map((n) => ({ identifier: n.identifier, title: n.title, url: n.url, stateName: n.state.name }));
  }

  async moveTo(identifier: string, stateName: string): Promise<void> {
    const team = teamOf(identifier);
    let state = (await this.teamStates(team)).find((s) => s.name === stateName);
    state ??= (await this.teamStates(team, true)).find((s) => s.name === stateName);
    if (!state) throw new Error(`Statut Linear introuvable : "${stateName}" (équipe ${team})`);
    await this.api.gql(Q.issueUpdate, { id: await this.issueId(identifier), input: { stateId: state.id } });
  }

  private async labelId(teamKey: string, name: string): Promise<string> {
    const labels = await this.teamLabels(teamKey);
    const existing = labels.get(name);
    if (existing) return existing;
    const { issueLabelCreate } = await this.api.gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(Q.labelCreate, {
      input: { name, teamId: await this.teamId(teamKey), color: '#26b5ce' },
    });
    labels.set(name, issueLabelCreate.issueLabel.id);
    return issueLabelCreate.issueLabel.id;
  }

  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    const team = teamOf(identifier);
    const id = await this.issueId(identifier);
    const addedLabelIds: string[] = [];
    for (const name of add) addedLabelIds.push(await this.labelId(team, name));
    const labels = await this.teamLabels(team);
    const removedLabelIds = remove.map((n) => labels.get(n)).filter((x): x is string => !!x);
    await this.api.gql(Q.issueUpdate, { id, input: { addedLabelIds, removedLabelIds } });
  }

  async comment(identifier: string, body: string): Promise<void> {
    await this.api.gql(Q.commentCreate, { input: { issueId: await this.issueId(identifier), body } });
  }

  async activity(sessionId: string, a: ActivityInput): Promise<void> {
    const content =
      a.type === 'action'
        ? { type: 'action', action: a.action, parameter: a.parameter, ...(a.result ? { result: a.result } : {}) }
        : { type: a.type, body: a.body };
    const input: Record<string, unknown> = { agentSessionId: sessionId, content };
    if (a.ephemeral) input['ephemeral'] = true;
    await this.api.gql(Q.activityCreate, { input });
  }

  async addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    await this.api.gql(Q.sessionUpdate, { id: sessionId, input: { addedExternalUrls: [{ label, url }] } });
  }

  async ensureSession(identifier: string): Promise<string> {
    const { agentSessionCreateOnIssue } = await this.api.gql<{ agentSessionCreateOnIssue: { agentSession: { id: string } } }>(
      Q.sessionOnIssue,
      { input: { issueId: await this.issueId(identifier) } },
    );
    return agentSessionCreateOnIssue.agentSession.id;
  }

  async ensureSetup(teamKey: string, states: Record<LogicalState, string>, labels: string[]): Promise<string[]> {
    const created: string[] = [];
    const existing = new Set((await this.teamStates(teamKey, true)).map((s) => s.name));
    const teamId = await this.teamId(teamKey);
    for (const [logical, name] of Object.entries(states) as [LogicalState, string][]) {
      if (existing.has(name)) continue;
      await this.api.gql(Q.stateCreate, { input: { name, teamId, type: STATE_TYPES[logical], color: '#5e6ad2' } });
      created.push(name);
    }
    const existingLabels = await this.teamLabels(teamKey, true);
    for (const name of labels) {
      if (existingLabels.has(name)) continue;
      await this.labelId(teamKey, name);
      created.push(name);
    }
    await this.warm(teamKey);
    return created;
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/adapters/tracker/linear` — Expected: PASS (1 skipped).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/tracker/linear
git commit -m "feat(linear): add GraphQL client, OAuth token manager and LinearTracker"
```

### Task 14: Linear webhook verification, mapping and ingest

**Files:**
- Create: `src/adapters/tracker/linear/webhook.ts`, `src/adapters/tracker/linear/ingest.ts`, `src/adapters/tracker/linear/fixtures/*.json`
- Test: `src/adapters/tracker/linear/webhook.test.ts`

**Interfaces:**
- Consumes: `RelaisEvent`, `LogicalState`
- Produces:
  ```ts
  function verifyLinearSignature(raw: string, signature: string | undefined, secret: string): boolean  // hex HMAC-SHA256, constant time
  function isFresh(body: { webhookTimestamp?: number }, now: number, maxSkewMs?: number): boolean      // default 60 s; missing timestamp = not fresh
  interface MapContext {
    projectIdForTeam(teamKey: string): string | undefined;
    logicalFor(projectId: string, stateName: string): LogicalState | null;
    stateNameById(teamKey: string, stateId: string): string | undefined;
    labelNameById(teamKey: string, labelId: string): string | undefined;
    isEcho(key: string): boolean;
    commands(projectId: string): string[];
    now(): number;
  }
  function mapLinearWebhook(body: any, deliveryId: string, ctx: MapContext): RelaisEvent[]
  function stripMention(body: string): string
  interface IngestDeps { secret: () => string; ctx: MapContext; submit: (e: RelaisEvent) => void; ack: (sessionId: string) => Promise<void>; log: (m: string) => void }
  function createLinearIngest(d: IngestDeps): (raw: string, headers: Record<string, string | undefined>) => { status: number }
  ```
  Mapping rules (spec §6, §9):
  - `type: 'AgentSessionEvent'`, `action: 'created'`: no `agentSession.comment` → `ticket.delegated { linearSessionId, promptContext }`; with a comment → strip the leading mention; first word (lowercased) in `ctx.commands(projectId)` → `command { name, body: rest, linearSessionId, author }`, otherwise `session.mentioned { linearSessionId, body, author }`.
  - `action: 'prompted'`: `agentActivity.signal === 'stop'` → `session.stopped { linearSessionId }`; else `session.prompted { linearSessionId, body: agentActivity.content.body, author }`.
  - `type: 'Issue'`, `action: 'update'`: state change when `updatedFrom.stateId` is present → unless `isEcho('state:<id>:<toName>')`, `ticket.moved { from, to }` (logical states or null); each newly added label id (in `data.labelIds`, not in `updatedFrom.labelIds`) → unless `isEcho('label:<id>:<name>')`, `label.added { label }`.
  - Unknown team (no project) → `[]`. Event ids: `linear:<deliveryId>` for the first, `linear:<deliveryId>:<n>` for the next ones.
  - Author: `agentActivity.user.name` ?? `agentSession.comment.user.name` ?? `agentSession.creator.name` ?? `Humain`.
  - Identifier: `agentSession.issue.identifier`, or for Issue events `data.identifier` ?? `<data.team.key>-<data.number>`.
  - Ingest: 401 on bad signature or stale timestamp, 400 on invalid JSON, else 200; for `ticket.delegated`, `session.mentioned`, `command` it calls `ack(sessionId)` (fire and forget) **before** `submit`.

- [ ] **Step 1: Write fixtures**

`src/adapters/tracker/linear/fixtures/session-created-delegation.json`:
```json
{ "type": "AgentSessionEvent", "action": "created", "webhookTimestamp": 1000,
  "agentSession": { "id": "as-1", "issue": { "id": "u1", "identifier": "REL-1", "title": "Export" }, "comment": null, "creator": { "name": "Lilian" } },
  "promptContext": "<issue identifier=\"REL-1\">Export</issue>" }
```
`src/adapters/tracker/linear/fixtures/session-created-mention.json`:
```json
{ "type": "AgentSessionEvent", "action": "created", "webhookTimestamp": 1000,
  "agentSession": { "id": "as-2", "issue": { "id": "u1", "identifier": "REL-1", "title": "Export" },
    "comment": { "id": "c1", "body": "@relais tu penses quoi de cette approche ?", "user": { "name": "Lilian" } } } }
```
`src/adapters/tracker/linear/fixtures/session-created-command.json`:
```json
{ "type": "AgentSessionEvent", "action": "created", "webhookTimestamp": 1000,
  "agentSession": { "id": "as-3", "issue": { "id": "u1", "identifier": "REL-1", "title": "Export" },
    "comment": { "id": "c2", "body": "[@relais](https://linear.app/x/profiles/relais) Retiens les agrégats côté serveur", "user": { "name": "Lilian" } } } }
```
`src/adapters/tracker/linear/fixtures/session-prompted.json`:
```json
{ "type": "AgentSessionEvent", "action": "prompted", "webhookTimestamp": 1000,
  "agentSession": { "id": "as-1", "issue": { "id": "u1", "identifier": "REL-1" } },
  "agentActivity": { "id": "aa-1", "content": { "type": "prompt", "body": "les boutons sont mal alignés" }, "user": { "name": "Lilian" } } }
```
`src/adapters/tracker/linear/fixtures/session-stop.json`:
```json
{ "type": "AgentSessionEvent", "action": "prompted", "webhookTimestamp": 1000,
  "agentSession": { "id": "as-1", "issue": { "id": "u1", "identifier": "REL-1" } },
  "agentActivity": { "id": "aa-2", "signal": "stop", "content": { "type": "prompt", "body": "" } } }
```
`src/adapters/tracker/linear/fixtures/issue-moved-labeled.json`:
```json
{ "type": "Issue", "action": "update", "webhookTimestamp": 1000,
  "data": { "id": "u1", "identifier": "REL-1", "number": 1, "team": { "key": "REL" }, "stateId": "s-ai", "state": { "id": "s-ai", "name": "AI Review" },
    "labelIds": ["l-bug", "l-resume"] },
  "updatedFrom": { "stateId": "s-hr", "labelIds": ["l-bug"] } }
```

- [ ] **Step 2: Write the failing tests**

`src/adapters/tracker/linear/webhook.test.ts`:
```ts
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RelaisEvent } from '../../../core/types.js';
import { createLinearIngest } from './ingest.js';
import { isFresh, mapLinearWebhook, stripMention, verifyLinearSignature, type MapContext } from './webhook.js';

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));
const NAMES: Record<string, string> = { 's-hr': 'Human Review', 's-ai': 'AI Review' };
const LOGICAL: Record<string, any> = { 'Human Review': 'human_review', 'AI Review': 'ai_review' };

function ctx(echoes: string[] = []): MapContext {
  return {
    projectIdForTeam: (k) => (k === 'REL' ? 'p' : undefined),
    logicalFor: (_p, name) => LOGICAL[name] ?? null,
    stateNameById: (_t, id) => NAMES[id],
    labelNameById: (_t, id) => ({ 'l-bug': 'bug', 'l-resume': 'agent:reprendre' })[id],
    isEcho: (k) => echoes.includes(k),
    commands: () => ['retiens', 'fais-le'],
    now: () => 5000,
  };
}

describe('signature', () => {
  it('accepts a valid HMAC and rejects others', () => {
    const raw = '{"a":1}';
    const sig = createHmac('sha256', 'sec').update(raw).digest('hex');
    expect(verifyLinearSignature(raw, sig, 'sec')).toBe(true);
    expect(verifyLinearSignature(raw, sig, 'other')).toBe(false);
    expect(verifyLinearSignature(raw, undefined, 'sec')).toBe(false);
    expect(verifyLinearSignature(raw, 'zz', 'sec')).toBe(false);
  });
  it('checks freshness', () => {
    expect(isFresh({ webhookTimestamp: 1000 }, 50_000)).toBe(true);
    expect(isFresh({ webhookTimestamp: 1000 }, 70_000)).toBe(false);
    expect(isFresh({}, 1000)).toBe(false);
  });
});

describe('stripMention', () => {
  it('removes plain and markdown mentions', () => {
    expect(stripMention('@relais  tu penses quoi ?')).toBe('tu penses quoi ?');
    expect(stripMention('[@relais](https://x) Retiens ça')).toBe('Retiens ça');
    expect(stripMention('sans mention')).toBe('sans mention');
  });
});

describe('mapLinearWebhook', () => {
  it('maps a delegation', () => {
    expect(mapLinearWebhook(fx('session-created-delegation'), 'd1', ctx())).toEqual([
      { id: 'linear:d1', type: 'ticket.delegated', at: 5000, projectId: 'p', ticketId: 'REL-1',
        payload: { linearSessionId: 'as-1', promptContext: '<issue identifier="REL-1">Export</issue>' } },
    ]);
  });
  it('maps a mention', () => {
    expect(mapLinearWebhook(fx('session-created-mention'), 'd2', ctx())[0]).toMatchObject({
      type: 'session.mentioned', payload: { linearSessionId: 'as-2', body: 'tu penses quoi de cette approche ?', author: 'Lilian' },
    });
  });
  it('maps a command', () => {
    expect(mapLinearWebhook(fx('session-created-command'), 'd3', ctx())[0]).toMatchObject({
      type: 'command', payload: { name: 'retiens', body: 'les agrégats côté serveur', linearSessionId: 'as-3' },
    });
  });
  it('maps a prompt and a stop', () => {
    expect(mapLinearWebhook(fx('session-prompted'), 'd4', ctx())[0]).toMatchObject({
      type: 'session.prompted', payload: { linearSessionId: 'as-1', body: 'les boutons sont mal alignés', author: 'Lilian' },
    });
    expect(mapLinearWebhook(fx('session-stop'), 'd5', ctx())[0]).toMatchObject({ type: 'session.stopped', payload: { linearSessionId: 'as-1' } });
  });
  it('maps a move and an added label', () => {
    const out = mapLinearWebhook(fx('issue-moved-labeled'), 'd6', ctx());
    expect(out).toEqual([
      { id: 'linear:d6', type: 'ticket.moved', at: 5000, projectId: 'p', ticketId: 'REL-1', payload: { from: 'human_review', to: 'ai_review' } },
      { id: 'linear:d6:1', type: 'label.added', at: 5000, projectId: 'p', ticketId: 'REL-1', payload: { label: 'agent:reprendre' } },
    ]);
  });
  it('drops echoes of our own writes', () => {
    expect(mapLinearWebhook(fx('issue-moved-labeled'), 'd7', ctx(['state:REL-1:AI Review', 'label:REL-1:agent:reprendre']))).toEqual([]);
  });
  it('ignores unknown teams', () => {
    const body = fx('session-prompted');
    body.agentSession.issue.identifier = 'OTHER-1';
    expect(mapLinearWebhook(body, 'd8', ctx())).toEqual([]);
  });
});

describe('ingest', () => {
  function signed(body: unknown) {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac('sha256', 'sec').update(raw).digest('hex') };
  }

  it('acks then submits a delegation', () => {
    const order: string[] = [];
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 2000 },
      submit: (e: RelaisEvent) => void order.push(`submit:${e.type}`),
      ack: async (s) => void order.push(`ack:${s}`),
      log: () => {},
    });
    const { raw, sig } = signed(fx('session-created-delegation'));
    expect(ingest(raw, { 'linear-signature': sig, 'linear-delivery': 'd9' })).toEqual({ status: 200 });
    expect(order).toEqual(['ack:as-1', 'submit:ticket.delegated']);
  });

  it('rejects a bad signature and a stale body', () => {
    const submit = vi.fn();
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: { ...ctx(), now: () => 999_999 }, submit, ack: async () => {}, log: () => {} });
    const { raw, sig } = signed(fx('session-prompted'));
    expect(ingest(raw, { 'linear-signature': 'bad' })).toEqual({ status: 401 });
    expect(ingest(raw, { 'linear-signature': sig })).toEqual({ status: 401 });
    expect(submit).not.toHaveBeenCalled();
  });
});
```
Run: `npx vitest run src/adapters/tracker/linear/webhook.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement webhook.ts**

`src/adapters/tracker/linear/webhook.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LogicalState, RelaisEvent } from '../../../core/types.js';

export function verifyLinearSignature(raw: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function isFresh(body: { webhookTimestamp?: number }, now: number, maxSkewMs = 60_000): boolean {
  return typeof body.webhookTimestamp === 'number' && Math.abs(now - body.webhookTimestamp) <= maxSkewMs;
}

export interface MapContext {
  projectIdForTeam(teamKey: string): string | undefined;
  logicalFor(projectId: string, stateName: string): LogicalState | null;
  stateNameById(teamKey: string, stateId: string): string | undefined;
  labelNameById(teamKey: string, labelId: string): string | undefined;
  isEcho(key: string): boolean;
  commands(projectId: string): string[];
  now(): number;
}

export function stripMention(body: string): string {
  return body.replace(/^\s*(\[@[^\]]*\]\([^)]*\)|@\S+)\s*/, '').trim();
}

type PartialEvent = { type: RelaisEvent['type']; payload: unknown };

function author(body: any): string {
  return body.agentActivity?.user?.name ?? body.agentSession?.comment?.user?.name ?? body.agentSession?.creator?.name ?? 'Humain';
}

function sessionEvents(body: any, projectId: string, ctx: MapContext): PartialEvent[] {
  const sessionId: string = body.agentSession.id;
  if (body.action === 'created') {
    const comment = body.agentSession.comment;
    if (!comment) return [{ type: 'ticket.delegated', payload: { linearSessionId: sessionId, promptContext: body.promptContext } }];
    const text = stripMention(comment.body ?? '');
    const [first = '', ...rest] = text.split(/\s+/);
    if (ctx.commands(projectId).includes(first.toLowerCase())) {
      return [{ type: 'command', payload: { name: first.toLowerCase(), body: rest.join(' '), linearSessionId: sessionId, author: author(body) } }];
    }
    return [{ type: 'session.mentioned', payload: { linearSessionId: sessionId, body: text, author: author(body) } }];
  }
  if (body.action === 'prompted') {
    if (body.agentActivity?.signal === 'stop') return [{ type: 'session.stopped', payload: { linearSessionId: sessionId } }];
    return [{ type: 'session.prompted', payload: { linearSessionId: sessionId, body: body.agentActivity?.content?.body ?? '', author: author(body) } }];
  }
  return [];
}

function issueEvents(body: any, identifier: string, teamKey: string, projectId: string, ctx: MapContext): PartialEvent[] {
  if (body.action !== 'update') return [];
  const out: PartialEvent[] = [];
  const data = body.data ?? {};
  const from = body.updatedFrom ?? {};
  if (from.stateId !== undefined) {
    const toName: string | undefined = data.state?.name ?? ctx.stateNameById(teamKey, data.stateId);
    const fromName = ctx.stateNameById(teamKey, from.stateId);
    if (toName && !ctx.isEcho(`state:${identifier}:${toName}`)) {
      out.push({
        type: 'ticket.moved',
        payload: { from: fromName ? ctx.logicalFor(projectId, fromName) : null, to: ctx.logicalFor(projectId, toName) },
      });
    }
  }
  if (Array.isArray(from.labelIds) && Array.isArray(data.labelIds)) {
    for (const id of data.labelIds as string[]) {
      if ((from.labelIds as string[]).includes(id)) continue;
      const name = ctx.labelNameById(teamKey, id);
      if (name && !ctx.isEcho(`label:${identifier}:${name}`)) out.push({ type: 'label.added', payload: { label: name } });
    }
  }
  return out;
}

export function mapLinearWebhook(body: any, deliveryId: string, ctx: MapContext): RelaisEvent[] {
  let identifier: string | undefined;
  if (body?.type === 'AgentSessionEvent') identifier = body.agentSession?.issue?.identifier;
  else if (body?.type === 'Issue') identifier = body.data?.identifier ?? (body.data?.team?.key ? `${body.data.team.key}-${body.data.number}` : undefined);
  if (!identifier) return [];
  const teamKey = identifier.split('-')[0]!;
  const projectId = ctx.projectIdForTeam(teamKey);
  if (!projectId) return [];
  const partials = body.type === 'AgentSessionEvent' ? sessionEvents(body, projectId, ctx) : issueEvents(body, identifier, teamKey, projectId, ctx);
  const at = ctx.now();
  return partials.map(
    (p, i) => ({ id: i === 0 ? `linear:${deliveryId}` : `linear:${deliveryId}:${i}`, type: p.type, at, projectId, ticketId: identifier, payload: p.payload }) as RelaisEvent,
  );
}
```

- [ ] **Step 4: Implement ingest.ts**

`src/adapters/tracker/linear/ingest.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { RelaisEvent } from '../../../core/types.js';
import { isFresh, mapLinearWebhook, verifyLinearSignature, type MapContext } from './webhook.js';

export interface IngestDeps {
  secret: () => string;
  ctx: MapContext;
  submit: (e: RelaisEvent) => void;
  ack: (sessionId: string) => Promise<void>;
  log: (m: string) => void;
}

const ACKED = new Set(['ticket.delegated', 'session.mentioned', 'command']);

export function createLinearIngest(d: IngestDeps) {
  return (raw: string, headers: Record<string, string | undefined>): { status: number } => {
    if (!verifyLinearSignature(raw, headers['linear-signature'], d.secret())) return { status: 401 };
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400 };
    }
    if (!isFresh(body, d.ctx.now())) return { status: 401 };
    const events = mapLinearWebhook(body, headers['linear-delivery'] ?? randomUUID(), d.ctx);
    for (const e of events) {
      const sessionId = (e.payload as { linearSessionId?: string }).linearSessionId;
      if (ACKED.has(e.type) && sessionId) d.ack(sessionId).catch((err: Error) => d.log(`ack failed: ${err.message}`));
      d.submit(e);
    }
    return { status: 200 };
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/adapters/tracker/linear/webhook.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/tracker/linear/webhook.ts src/adapters/tracker/linear/ingest.ts src/adapters/tracker/linear/fixtures src/adapters/tracker/linear/webhook.test.ts
git commit -m "feat(linear): verify, map and ingest Linear webhooks"
```

### Task 15: Reconciliation loop

**Files:**
- Create: `src/adapters/tracker/linear/reconcile.ts`
- Test: `src/adapters/tracker/linear/reconcile.test.ts`

**Interfaces:**
- Consumes: `Tracker`, `Store`, `ProjectRuntime`, `RelaisEvent`, `Clock`
- Produces:
  ```ts
  interface ReconcileDeps { tracker: Pick<Tracker, 'listDelegated'>; store: Store; projects: ProjectRuntime[]; submit: (e: RelaisEvent) => void; clock: Clock; log: (m: string) => void }
  function reconcileOnce(d: ReconcileDeps): Promise<void>
  class Reconciler { constructor(d: ReconcileDeps); start(intervalMs?: number /* 30_000 */): void; stop(): void }
  ```
  Behaviour per project:
  - Delegated issue unknown to the store → `ticket.delegated` with id `reconcile:delegated:<identifier>` and empty payload.
  - Known ticket whose Linear state maps to a different logical state, not an echo → `ticket.moved { from: ticket.logical, to }` with id `reconcile:moved:<identifier>:<stateName>:<ticket.updatedAt>`.
  - Known ticket with an `activeRunId` that is no longer delegated (absent from the list) → `session.stopped {}` with id `reconcile:undelegated:<identifier>:<activeRunId>`.
  - A failure for one project is logged and does not stop the others.

- [ ] **Step 1: Write the failing test**

`src/adapters/tracker/linear/reconcile.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../../config/load-workflow.js';
import { FakeClock } from '../../../core/clock.js';
import { newTicketState, type RelaisEvent } from '../../../core/types.js';
import { SqliteStore } from '../../../store/sqlite-store.js';
import { FakeTracker } from '../fake.js';
import { reconcileOnce } from './reconcile.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../../packs/standard') });

describe('reconcileOnce', () => {
  it('emits delegation, moves and undelegation', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app' });
    tracker.addIssue({ identifier: 'REL-2', delegateId: 'app', stateName: 'AI Review' });
    store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'human_review', 7) });
    store.putTicket({ ...newTicketState('p', 'REL-3', 'T', 'dev', 8), activeRunId: 'r3' });
    const events: RelaisEvent[] = [];
    await reconcileOnce({
      tracker, store, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }],
      submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {},
    });
    expect(events.map((e) => [e.id, e.type, e.payload])).toEqual([
      ['reconcile:delegated:REL-1', 'ticket.delegated', {}],
      ['reconcile:moved:REL-2:AI Review:7', 'ticket.moved', { from: 'human_review', to: 'ai_review' }],
      ['reconcile:undelegated:REL-3:r3', 'session.stopped', {}],
    ]);
  });
});
```
Run: `npx vitest run src/adapters/tracker/linear/reconcile.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/adapters/tracker/linear/reconcile.ts`:
```ts
import type { Clock } from '../../../core/clock.js';
import type { ProjectRuntime } from '../../../core/orchestrator.js';
import type { LogicalState, RelaisEvent } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import type { Tracker } from '../types.js';

export interface ReconcileDeps {
  tracker: Pick<Tracker, 'listDelegated'>;
  store: Store;
  projects: ProjectRuntime[];
  submit: (e: RelaisEvent) => void;
  clock: Clock;
  log: (m: string) => void;
}

export async function reconcileOnce(d: ReconcileDeps): Promise<void> {
  for (const p of d.projects) {
    try {
      const issues = await d.tracker.listDelegated(p.teamKey);
      const at = d.clock.now();
      const delegated = new Set(issues.map((i) => i.identifier));
      for (const issue of issues) {
        const t = d.store.getTicket(p.id, issue.identifier);
        if (!t) {
          d.submit({ id: `reconcile:delegated:${issue.identifier}`, type: 'ticket.delegated', at, projectId: p.id, ticketId: issue.identifier, payload: {} });
          continue;
        }
        const to = (Object.entries(p.workflow.states) as [LogicalState, string][]).find(([, n]) => n === issue.stateName)?.[0];
        if (to && to !== t.logical && !d.store.isEcho(`state:${issue.identifier}:${issue.stateName}`, at)) {
          d.submit({
            id: `reconcile:moved:${issue.identifier}:${issue.stateName}:${t.updatedAt}`,
            type: 'ticket.moved',
            at,
            projectId: p.id,
            ticketId: issue.identifier,
            payload: { from: t.logical, to },
          });
        }
      }
      for (const t of d.store.listTickets()) {
        if (t.projectId !== p.id || !t.activeRunId || delegated.has(t.ticketId)) continue;
        d.submit({ id: `reconcile:undelegated:${t.ticketId}:${t.activeRunId}`, type: 'session.stopped', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
      }
    } catch (err) {
      d.log(`reconcile ${p.id}: ${(err as Error).message}`);
    }
  }
}

export class Reconciler {
  private handle: NodeJS.Timeout | undefined;
  constructor(private d: ReconcileDeps) {}
  start(intervalMs = 30_000): void {
    this.stop();
    void reconcileOnce(this.d);
    this.handle = setInterval(() => void reconcileOnce(this.d), intervalMs);
  }
  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
```
Note: `ProjectRuntime` is imported as a type from the orchestrator module.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/adapters/tracker/linear/reconcile.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/tracker/linear/reconcile.ts src/adapters/tracker/linear/reconcile.test.ts
git commit -m "feat(linear): add reconciliation of delegated tickets and missed moves"
```

---

## M4 — Server and relay

### Task 16: Instance configuration and secrets

**Files:**
- Create: `src/config/instance.ts`
- Test: `src/config/instance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ProjectConfig { id: string; repoPath: string; linearTeamKey: string }
  interface InstanceConfig { port: number; host: string; publicUrl?: string;
    relay: { kind: 'smee'; url: string } | { kind: 'none' }; projects: ProjectConfig[];
    limits: { perDayUsd?: number }; knowledge?: { repoPath: string } }
  interface LinearSecrets { clientId: string; clientSecret: string; webhookSecret: string; accessToken?: string; refreshToken?: string;
    expiresAt?: number; appUserId?: string; organizationId?: string }
  interface Secrets { linear?: LinearSecrets }
  function relaisHome(env?: NodeJS.ProcessEnv): string            // RELAIS_HOME ?? ~/.relais
  function homePaths(home: string): { config: string; secrets: string; db: string; transcripts: string; workspaces: string; logs: string }
  function loadInstance(home: string): InstanceConfig              // defaults when config.yaml is missing: port 4100, host 127.0.0.1, relay none, projects []
  function saveInstance(home: string, cfg: InstanceConfig): void   // creates the directory tree
  function loadSecrets(home: string): Secrets                      // {} when missing
  function saveSecrets(home: string, s: Secrets): void             // file mode 0o600
  ```
  `config.yaml` uses the same camelCase keys as `InstanceConfig`.

- [ ] **Step 1: Write the failing test**

`src/config/instance.test.ts`:
```ts
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homePaths, loadInstance, loadSecrets, relaisHome, saveInstance, saveSecrets } from './instance.js';

describe('instance config', () => {
  it('resolves home', () => {
    expect(relaisHome({ RELAIS_HOME: '/x' } as NodeJS.ProcessEnv)).toBe('/x');
    expect(relaisHome({ HOME: '/home/u' } as NodeJS.ProcessEnv)).toBe('/home/u/.relais');
  });

  it('returns defaults, then round-trips', () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-home-'));
    expect(loadInstance(home)).toEqual({ port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const cfg = {
      port: 4100, host: '127.0.0.1', relay: { kind: 'smee' as const, url: 'https://smee.io/abc' },
      projects: [{ id: 'perso', repoPath: '/code/perso', linearTeamKey: 'REL' }], limits: { perDayUsd: 20 },
      knowledge: { repoPath: join(home, 'knowledge') },
    };
    saveInstance(home, cfg);
    expect(loadInstance(home)).toEqual(cfg);
  });

  it('writes secrets with mode 600', () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-home-'));
    expect(loadSecrets(home)).toEqual({});
    saveSecrets(home, { linear: { clientId: 'c', clientSecret: 's', webhookSecret: 'w' } });
    expect(loadSecrets(home).linear!.clientId).toBe('c');
    expect(statSync(homePaths(home).secrets).mode & 0o777).toBe(0o600);
  });

  it('rejects an invalid config with the key path', () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-home-'));
    saveInstance(home, { port: 4100, host: 'h', relay: { kind: 'none' }, projects: [], limits: {} });
    expect(() => saveInstance(home, { port: -1 } as never)).toThrow(/port/);
  });
});
```
Run: `npx vitest run src/config/instance.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/config/instance.ts`:
```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const projectSchema = z.object({ id: z.string().min(1), repoPath: z.string().min(1), linearTeamKey: z.string().min(1) });

const instanceSchema = z.object({
  port: z.number().int().positive().default(4100),
  host: z.string().default('127.0.0.1'),
  publicUrl: z.string().url().optional(),
  relay: z.discriminatedUnion('kind', [z.object({ kind: z.literal('smee'), url: z.string().url() }), z.object({ kind: z.literal('none') })]).default({ kind: 'none' }),
  projects: z.array(projectSchema).default([]),
  limits: z.object({ perDayUsd: z.number().positive().optional() }).default({}),
  knowledge: z.object({ repoPath: z.string() }).optional(),
});

export type ProjectConfig = z.infer<typeof projectSchema>;
export type InstanceConfig = z.infer<typeof instanceSchema>;

export interface LinearSecrets {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  appUserId?: string;
  organizationId?: string;
}

export interface Secrets {
  linear?: LinearSecrets;
}

export function relaisHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['RELAIS_HOME'] ?? join(env['HOME'] ?? homedir(), '.relais');
}

export function homePaths(home: string) {
  return {
    config: join(home, 'config.yaml'),
    secrets: join(home, 'secrets.json'),
    db: join(home, 'relais.db'),
    transcripts: join(home, 'transcripts'),
    workspaces: join(home, 'workspaces'),
    logs: join(home, 'logs'),
  };
}

function ensureTree(home: string): void {
  const p = homePaths(home);
  for (const dir of [home, p.transcripts, p.workspaces, p.logs]) mkdirSync(dir, { recursive: true });
}

function validate(raw: unknown): InstanceConfig {
  const res = instanceSchema.safeParse(raw ?? {});
  if (!res.success) {
    const i = res.error.issues[0]!;
    throw new Error(`config.yaml invalide : ${i.path.join('.')}: ${i.message}`);
  }
  return res.data;
}

export function loadInstance(home: string): InstanceConfig {
  const file = homePaths(home).config;
  return validate(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {});
}

export function saveInstance(home: string, cfg: InstanceConfig): void {
  const valid = validate(cfg);
  ensureTree(home);
  writeFileSync(homePaths(home).config, stringify(valid));
}

export function loadSecrets(home: string): Secrets {
  const file = homePaths(home).secrets;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Secrets) : {};
}

export function saveSecrets(home: string, s: Secrets): void {
  ensureTree(home);
  const file = homePaths(home).secrets;
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/config/instance.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/config/instance.ts src/config/instance.test.ts
git commit -m "feat(config): add instance config and 0600 secrets storage"
```

### Task 17: HTTP server (webhooks, OAuth, UI API, SSE, agent API)

**Files:**
- Create: `src/server/app.ts`, `src/server/static.ts`
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: `Store`, `EventBus`, `BusMessage`, `Tracker`, `RelaisEvent`, `Clock`
- Produces:
  ```ts
  interface ServerDeps {
    store: Store; bus: EventBus; clock: Clock;
    submit: (e: RelaisEvent) => void;
    isPaused: () => boolean;
    linearWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number };
    oauth?: { authorizeUrl: () => string; callback: (code: string, state: string) => Promise<void> };
    linearConnected: () => boolean;
    tracker: Pick<Tracker, 'getIssue' | 'search' | 'activity'>;
    knowledgeSearch?: (q: string) => Promise<{ file: string; line: number; text: string }[]>;
    capacity: () => { dev: { used: number; total: number }; questions: { used: number; total: number } };
    dailyBudgetUsd?: number;
    transcriptsDir: string;
    webDir?: string;
  }
  function createApp(d: ServerDeps): Hono
  ```
  Routes (spec §15):
  - `POST /webhooks/linear` → raw text body + lower-cased headers → `linearWebhook` → empty body with that status.
  - `GET /oauth/start` → 302 to `oauth.authorizeUrl()` (404 if no oauth); `GET /oauth/callback?code&state` → `oauth.callback` → 200 HTML `<p>Linear est connecté. Vous pouvez fermer cet onglet.</p>`; on error 400 with the message.
  - `GET /api/state` → `{ paused, linearConnected, tickets, queue, activeRuns, costTodayUsd, budgetUsd, capacity }` (`activeRuns` = runs with status `running`, without `token`).
  - `GET /api/events/recent?ticket=` → last 100 events.
  - `GET /api/events` → SSE: each bus message as `event: <kind>` / `data: <json>`; a `ping` event every 15 s.
  - `GET /api/runs/:id/transcript` → JSON array of the parsed lines of `<transcriptsDir>/<id>.jsonl` (404 if missing).
  - `POST /api/control/pause|resume` → submit `control.pause|resume` with `projectId: '*'`, id `ui:<kind>:<now>`.
  - `POST /api/tickets/:projectId/:ticketId/stop` → submit `control.stop` for that ticket.
  - `/agent/*` requires `Authorization: Bearer <token>` of a run with status `running` (else 401):
    `GET /agent/issue/:id` (403 unless `id` is the run's ticket), `GET /agent/search?q=`, `GET /agent/kb/search?q=` (`[]` without knowledge),
    `POST /agent/ask` `{ text }` → `tracker.activity(run.linearSessionId, { type: 'elicitation', body: text })`, sets the ticket `blocked: true, blockReason: 'Question posée par l\'agent'` in the store, publishes a `ticket` bus message, returns `{ ok: true }`.
  - Everything else: static files from `webDir` (fallback `index.html`), or 404.

- [ ] **Step 1: Write the failing tests**

`src/server/app.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { EventBus } from '../core/bus.js';
import { FakeClock } from '../core/clock.js';
import { newTicketState, type RelaisEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { createApp } from './app.js';

function setup() {
  const store = new SqliteStore(':memory:');
  const bus = new EventBus();
  const tracker = new FakeTracker();
  tracker.addIssue({ identifier: 'REL-1', title: 'Export' });
  const submitted: RelaisEvent[] = [];
  const transcriptsDir = mkdtempSync(join(tmpdir(), 'relais-tr-'));
  const webDir = mkdtempSync(join(tmpdir(), 'relais-web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>Relais</h1>');
  const linearWebhook = vi.fn(() => ({ status: 200 }));
  const app = createApp({
    store, bus, clock: new FakeClock(10), submit: (e) => void submitted.push(e), isPaused: () => false, linearWebhook,
    linearConnected: () => true, tracker, capacity: () => ({ dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } }),
    transcriptsDir, webDir,
  });
  store.putTicket(newTicketState('p', 'REL-1', 'Export', 'dev', 1));
  store.putRun({
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running', claudeSessionId: 'c', linearSessionId: 'ls-1',
    startedAt: 1, costUsd: 0.5, turns: 2, lastText: '', token: 'tok', cwd: '/w',
  });
  return { app, store, tracker, submitted, linearWebhook, transcriptsDir };
}

describe('server', () => {
  it('forwards raw webhooks with lower-cased headers', async () => {
    const { app, linearWebhook } = setup();
    const res = await app.request('/webhooks/linear', { method: 'POST', body: '{"x":1}', headers: { 'Linear-Signature': 'abc' } });
    expect(res.status).toBe(200);
    expect(linearWebhook).toHaveBeenCalledWith('{"x":1}', expect.objectContaining({ 'linear-signature': 'abc' }));
  });

  it('serves state without run tokens', async () => {
    const { app } = setup();
    const body = await (await app.request('/api/state')).json();
    expect(body.tickets).toHaveLength(1);
    expect(body.activeRuns[0].id).toBe('r1');
    expect(body.activeRuns[0].token).toBeUndefined();
    expect(body.capacity.dev).toEqual({ used: 1, total: 3 });
  });

  it('submits pause and stop controls', async () => {
    const { app, submitted } = setup();
    await app.request('/api/control/pause', { method: 'POST' });
    await app.request('/api/tickets/p/REL-1/stop', { method: 'POST' });
    expect(submitted.map((e) => [e.type, e.projectId, e.ticketId])).toEqual([
      ['control.pause', '*', undefined],
      ['control.stop', 'p', 'REL-1'],
    ]);
  });

  it('protects the agent API with the run token', async () => {
    const { app } = setup();
    expect((await app.request('/agent/issue/REL-1')).status).toBe(401);
    const ok = await app.request('/agent/issue/REL-1', { headers: { authorization: 'Bearer tok' } });
    expect((await ok.json()).identifier).toBe('REL-1');
    expect((await app.request('/agent/issue/REL-2', { headers: { authorization: 'Bearer tok' } })).status).toBe(403);
  });

  it('agent ask posts an elicitation and blocks the ticket', async () => {
    const { app, store, tracker } = setup();
    const res = await app.request('/agent/ask', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Quelle base ?' }) });
    expect(res.status).toBe(200);
    expect(tracker.activities('ls-1')).toEqual([{ type: 'elicitation', body: 'Quelle base ?' }]);
    expect(store.getTicket('p', 'REL-1')!.blocked).toBe(true);
  });

  it('returns a transcript and serves the UI', async () => {
    const { app, transcriptsDir } = setup();
    writeFileSync(join(transcriptsDir, 'r1.jsonl'), '{"type":"system"}\n{"type":"result"}\n');
    expect(await (await app.request('/api/runs/r1/transcript')).json()).toEqual([{ type: 'system' }, { type: 'result' }]);
    expect(await (await app.request('/')).text()).toContain('Relais');
    expect(await (await app.request('/some/route')).text()).toContain('Relais');
  });
});
```
Run: `npx vitest run src/server/app.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement static.ts**

`src/server/static.ts`:
```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export function readStatic(webDir: string, urlPath: string): { body: Buffer; type: string } | undefined {
  const root = normalize(webDir + sep);
  let file = normalize(join(webDir, decodeURIComponent(urlPath)));
  if (!file.startsWith(root) && file !== normalize(webDir)) return undefined;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, 'index.html');
  if (!existsSync(file)) return undefined;
  return { body: readFileSync(file), type: TYPES[extname(file)] ?? 'application/octet-stream' };
}
```

- [ ] **Step 3: Implement app.ts**

`src/server/app.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Tracker } from '../adapters/tracker/types.js';
import type { BusMessage, EventBus } from '../core/bus.js';
import type { Clock } from '../core/clock.js';
import type { RelaisEvent } from '../core/types.js';
import type { RunRecord, Store } from '../store/types.js';
import { readStatic } from './static.js';

export interface ServerDeps {
  store: Store;
  bus: EventBus;
  clock: Clock;
  submit: (e: RelaisEvent) => void;
  isPaused: () => boolean;
  linearWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number };
  oauth?: { authorizeUrl: () => string; callback: (code: string, state: string) => Promise<void> };
  linearConnected: () => boolean;
  tracker: Pick<Tracker, 'getIssue' | 'search' | 'activity'>;
  knowledgeSearch?: (q: string) => Promise<{ file: string; line: number; text: string }[]>;
  capacity: () => { dev: { used: number; total: number }; questions: { used: number; total: number } };
  dailyBudgetUsd?: number;
  transcriptsDir: string;
  webDir?: string;
}

type AgentEnv = { Variables: { run: RunRecord } };

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function publicRun({ token: _t, ...rest }: RunRecord) {
  return rest;
}

export function createApp(d: ServerDeps): Hono {
  const app = new Hono();

  app.post('/webhooks/linear', async (c) => {
    const raw = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const { status } = d.linearWebhook(raw, headers);
    return c.body(null, status as 200);
  });

  app.get('/oauth/start', (c) => (d.oauth ? c.redirect(d.oauth.authorizeUrl()) : c.notFound()));
  app.get('/oauth/callback', async (c) => {
    if (!d.oauth) return c.notFound();
    try {
      await d.oauth.callback(c.req.query('code') ?? '', c.req.query('state') ?? '');
      return c.html('<p>Linear est connecté. Vous pouvez fermer cet onglet.</p>');
    } catch (err) {
      return c.html(`<p>Connexion Linear impossible : ${(err as Error).message}</p>`, 400);
    }
  });

  app.get('/api/state', (c) =>
    c.json({
      paused: d.isPaused(),
      linearConnected: d.linearConnected(),
      tickets: d.store.listTickets(),
      queue: d.store.listQueue(),
      activeRuns: d.store.runsByStatus('running').map(publicRun),
      costTodayUsd: d.store.costSince(startOfUtcDay(d.clock.now())),
      budgetUsd: d.dailyBudgetUsd ?? null,
      capacity: d.capacity(),
    }),
  );

  app.get('/api/events/recent', (c) => c.json(d.store.recentEvents(100, c.req.query('ticket') || undefined)));

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: BusMessage[] = [];
      let wake: (() => void) | undefined;
      const off = d.bus.subscribe((m) => {
        queue.push(m);
        wake?.();
      });
      const ping = setInterval(() => {
        queue.push({ kind: 'log', level: 'info', message: 'ping', at: d.clock.now() });
        wake?.();
      }, 15_000);
      stream.onAbort(() => {
        off();
        clearInterval(ping);
        wake?.();
      });
      while (!stream.aborted) {
        const m = queue.shift();
        if (!m) {
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
          continue;
        }
        const event = m.kind === 'log' && m.message === 'ping' ? 'ping' : m.kind;
        await stream.writeSSE({ event, data: JSON.stringify(m) });
      }
    }),
  );

  app.get('/api/runs/:id/transcript', (c) => {
    const id = c.req.param('id').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = join(d.transcriptsDir, `${id}.jsonl`);
    if (!existsSync(file)) return c.notFound();
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return c.json(lines.map((l) => JSON.parse(l)));
  });

  const control = (type: 'control.pause' | 'control.resume') => (c: Context) => {
    const at = d.clock.now();
    d.submit({ id: `ui:${type}:${at}`, type, at, projectId: '*', payload: {} } as RelaisEvent);
    return c.json({ ok: true });
  };
  app.post('/api/control/pause', control('control.pause'));
  app.post('/api/control/resume', control('control.resume'));
  app.post('/api/tickets/:projectId/:ticketId/stop', (c) => {
    const at = d.clock.now();
    const ticketId = c.req.param('ticketId');
    d.submit({ id: `ui:stop:${ticketId}:${at}`, type: 'control.stop', at, projectId: c.req.param('projectId'), ticketId, payload: {} });
    return c.json({ ok: true });
  });

  const agent = new Hono<AgentEnv>();
  agent.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const run = token ? d.store.findRunByToken(token) : undefined;
    if (!run || run.status !== 'running') return c.json({ error: 'unauthorized' }, 401);
    c.set('run', run);
    await next();
  });
  agent.get('/issue/:id', async (c) => {
    const run = c.get('run');
    if (c.req.param('id') !== run.ticketId) return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.tracker.getIssue(run.ticketId));
  });
  agent.get('/search', async (c) => c.json(await d.tracker.search(c.req.query('q') ?? '')));
  agent.get('/kb/search', async (c) => c.json(d.knowledgeSearch ? await d.knowledgeSearch(c.req.query('q') ?? '') : []));
  agent.post('/ask', async (c) => {
    const run = c.get('run');
    const { text } = (await c.req.json()) as { text?: string };
    if (!text) return c.json({ error: 'text required' }, 400);
    if (run.linearSessionId) await d.tracker.activity(run.linearSessionId, { type: 'elicitation', body: text });
    const t = d.store.getTicket(run.projectId, run.ticketId);
    if (t) {
      t.blocked = true;
      t.blockReason = "Question posée par l'agent";
      t.updatedAt = d.clock.now();
      d.store.putTicket(t);
      d.bus.publish({ kind: 'ticket', ticket: t });
    }
    return c.json({ ok: true });
  });
  app.route('/agent', agent);

  app.get('*', (c) => {
    if (!d.webDir) return c.notFound();
    const file = readStatic(d.webDir, new URL(c.req.url).pathname);
    if (!file) return c.notFound();
    return c.body(new Uint8Array(file.body), 200, { 'content-type': file.type });
  });

  return app;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/server/app.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server
git commit -m "feat(server): add webhook, OAuth, UI, SSE and agent API routes"
```

### Task 18: smee relay client

**Files:**
- Create: `src/relay/smee.ts`
- Test: `src/relay/smee.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RelayOptions { url: string; onWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number }; log: (m: string) => void }
  function startSmeeRelay(o: RelayOptions): { close(): void }
  function createSmeeChannel(fetchImpl?: typeof fetch): Promise<string>   // follows https://smee.io/new's redirect Location
  ```
  smee.io delivers each webhook as an SSE `message` whose `data` is JSON `{ ...lowercasedHeaders, body: <parsed JSON body>, query, timestamp }`. The relay rebuilds `raw = JSON.stringify(data.body)` and passes all string-valued top-level fields as headers. Linear signs the exact bytes it sends; `JSON.stringify` of the parsed body reproduces them for Linear's compact JSON — the recette (Task 26) confirms it on a real delivery.

- [ ] **Step 1: Write the failing test**

`src/relay/smee.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startSmeeRelay } from './smee.js';

let server: Server | undefined;
afterEach(() => server?.close());

function sseServer(payload: unknown): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: ready\ndata: {}\n\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/chan`)));
}

describe('smee relay', () => {
  it('rebuilds raw body and headers from a smee message', async () => {
    const url = await sseServer({ 'linear-signature': 'abc', 'linear-delivery': 'd1', body: { type: 'Issue', n: 1 }, query: {}, timestamp: 1 });
    const got = await new Promise<{ raw: string; headers: Record<string, string | undefined> }>((resolve) => {
      const relay = startSmeeRelay({
        url,
        log: () => {},
        onWebhook: (raw, headers) => {
          relay.close();
          resolve({ raw, headers });
          return { status: 200 };
        },
      });
    });
    expect(got.raw).toBe('{"type":"Issue","n":1}');
    expect(got.headers['linear-signature']).toBe('abc');
    expect(got.headers['linear-delivery']).toBe('d1');
  });
});
```
Run: `npx vitest run src/relay/smee.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/relay/smee.ts`:
```ts
import { EventSource } from 'eventsource';

export interface RelayOptions {
  url: string;
  onWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number };
  log: (m: string) => void;
}

export function startSmeeRelay(o: RelayOptions): { close(): void } {
  const es = new EventSource(o.url);
  // eventsource v3 types its own MessageEvent; adapt the annotation if tsc complains.
  es.addEventListener('message', (msg: MessageEvent) => {
    try {
      const data = JSON.parse(String(msg.data)) as Record<string, unknown>;
      if (!('body' in data)) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
      const { status } = o.onWebhook(JSON.stringify(data['body']), headers);
      if (status !== 200) o.log(`relay: webhook rejected with ${status}`);
    } catch (err) {
      o.log(`relay: bad message (${(err as Error).message})`);
    }
  });
  es.addEventListener('error', () => o.log('relay: connection error, retrying'));
  return { close: () => es.close() };
}

export async function createSmeeChannel(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl('https://smee.io/new', { method: 'HEAD', redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error('smee.io did not return a channel URL');
  return new URL(location, 'https://smee.io').toString();
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/relay/smee.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/relay
git commit -m "feat(relay): add smee.io webhook relay client"
```

---

## M5 — Workspaces and forge

### Task 19: Git workspaces

**Files:**
- Create: `src/adapters/exec.ts`, `src/adapters/workspace/git-workspaces.ts`
- Test: `src/adapters/workspace/git-workspaces.test.ts`

**Interfaces:**
- Consumes: `WorkspaceManager`, `WorkspaceRequest`, `Workspace` (Task 9), `branchName`, `runVerify`
- Produces:
  ```ts
  // exec.ts
  interface ExecResult { stdout: string; stderr: string; code: number }
  type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;
  const execCmd: Exec;   // never throws on a non-zero exit; throws only if the binary cannot start
  async function mustExec(exec: Exec, cmd: string, args: string[], opts?: { cwd?: string }): Promise<string>  // throws `<cmd> <args>: <stderr>` on non-zero, returns stdout
  // git-workspaces.ts
  class GitWorkspaces implements WorkspaceManager {
    constructor(o: { root: string; knowledgeRepo?: string; exec?: Exec; verify?: Verifier })
  }
  ```
  Behaviour (spec §11):
  - `worktree`: path `<root>/<projectId>/<ticketId>`. If it exists, reuse it (branch = `git rev-parse --abbrev-ref HEAD`), skip setup. Else `git fetch origin`; branch `branchName(ticketId, title)`; if `origin/<branch>` exists → `git worktree add <path> -B <branch> origin/<branch>`, else `git worktree add --no-track -b <branch> <path> origin/<trunk>`; run `setup` commands with the verifier (failure → throw `Le setup du worktree a échoué : <command>`). Returns `{ path, port: portBase + slot, branch }`.
  - `trunk-readonly`: path `<root>/<projectId>/_trunk`; `git fetch origin`; create with `git worktree add --detach <path> origin/<trunk>` or update with `git -C <path> checkout -f --detach origin/<trunk>`.
  - `knowledge`: requires `knowledgeRepo` (else throw `Aucun dépôt de connaissance configuré.`); `git -C <kb> fetch origin`; path `<root>/_kb/<runId>`; branch `learn/<ticketId lowercase>-<runId first 8 chars>`; `git -C <kb> worktree add -b <branch> <path> origin/<kbTrunk>`.
  - trunk = `git symbolic-ref --short refs/remotes/origin/HEAD` without `origin/`, fallback `main`.
  - `cleanup`: `git -C <repo> worktree remove --force <root>/<projectId>/<ticketId>` if the path exists; never touches other paths.
  - `remoteBranchExists(repo, prefix)`: `git -C <repo> ls-remote --heads origin`, then a JS prefix match on the branch names.

- [ ] **Step 1: Write the failing test (uses real git in temp dirs)**

`src/adapters/workspace/git-workspaces.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitWorkspaces } from './git-workspaces.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), 'relais-git-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '--bare', '-b', 'main', origin);
  const repo = join(base, 'repo');
  git(base, 'clone', origin, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return { base, repo, root: join(base, 'ws') };
}

const req = (repo: string, patch: object = {}) => ({
  projectId: 'p', repoPath: repo, ticketId: 'REL-1', title: 'Export CSV', kind: 'worktree' as const, slot: 1, portBase: 4200, setup: [], runId: 'abcdef123456', ...patch,
});

describe('GitWorkspaces', () => {
  it('creates, reuses and removes a ticket worktree', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(w).toEqual({ path: join(root, 'p', 'REL-1'), port: 4201, branch: 'relais/rel-1-export-csv' });
    expect(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('relais/rel-1-export-csv');
    expect(await ws.prepare(req(repo))).toEqual(w);
    await ws.cleanup('p', repo, 'REL-1');
    expect(existsSync(w.path)).toBe(false);
  });

  it('checks out an existing remote branch', async () => {
    const { repo, root } = fixtureRepo();
    git(repo, 'checkout', '-b', 'relais/rel-1-export-csv');
    git(repo, 'commit', '--allow-empty', '-m', 'wip');
    git(repo, 'push', '-u', 'origin', 'relais/rel-1-export-csv');
    git(repo, 'checkout', 'main');
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(git(w.path, 'log', '-1', '--format=%s')).toBe('wip');
    expect(await ws.remoteBranchExists(repo, 'relais/rel-1-')).toBe(true);
    expect(await ws.remoteBranchExists(repo, 'relais/rel-2-')).toBe(false);
  });

  it('prepares the read-only trunk and a knowledge worktree', async () => {
    const { repo, root } = fixtureRepo();
    const kb = fixtureRepo();
    const ws = new GitWorkspaces({ root, knowledgeRepo: kb.repo });
    expect(await ws.prepare(req(repo, { kind: 'trunk-readonly' }))).toEqual({ path: join(root, 'p', '_trunk') });
    const k = await ws.prepare(req(repo, { kind: 'knowledge' }));
    expect(k).toEqual({ path: join(root, '_kb', 'abcdef123456'), branch: 'learn/rel-1-abcdef12' });
    expect(existsSync(join(k.path, 'README.md'))).toBe(true);
  });

  it('fails clearly when setup fails', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    await expect(ws.prepare(req(repo, { setup: ['exit 2'] }))).rejects.toThrow('Le setup du worktree a échoué : exit 2');
  });
});
```
Run: `npx vitest run src/adapters/workspace/git-workspaces.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement exec.ts**

`src/adapters/exec.ts`:
```ts
import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;

export const execCmd: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });

export async function mustExec(exec: Exec, cmd: string, args: string[], opts?: { cwd?: string }): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
```

- [ ] **Step 3: Implement git-workspaces.ts**

`src/adapters/workspace/git-workspaces.ts`:
```ts
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { branchName } from '../../core/naming.js';
import { runVerify, type Verifier } from '../../core/verify.js';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

export class GitWorkspaces implements WorkspaceManager {
  private exec: Exec;
  private verify: Verifier;

  constructor(private o: { root: string; knowledgeRepo?: string; exec?: Exec; verify?: Verifier }) {
    this.exec = o.exec ?? execCmd;
    this.verify = o.verify ?? runVerify;
  }

  private git(repo: string, ...args: string[]): Promise<string> {
    return mustExec(this.exec, 'git', ['-C', repo, ...args]);
  }

  private async trunk(repo: string): Promise<string> {
    const r = await this.exec('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : 'main';
  }

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    if (req.kind === 'trunk-readonly') return this.trunkWorkspace(req);
    if (req.kind === 'knowledge') return this.knowledgeWorkspace(req);
    const path = join(this.o.root, req.projectId, req.ticketId);
    const port = req.portBase + req.slot;
    if (existsSync(path)) {
      const branch = (await this.git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
      return { path, port, branch };
    }
    mkdirSync(dirname(path), { recursive: true });
    await this.git(req.repoPath, 'fetch', 'origin');
    const branch = branchName(req.ticketId, req.title);
    const remote = await this.exec('git', ['-C', req.repoPath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (remote.code === 0) {
      await this.git(req.repoPath, 'worktree', 'add', path, '-B', branch, `origin/${branch}`);
    } else {
      await this.git(req.repoPath, 'worktree', 'add', '--no-track', '-b', branch, path, `origin/${await this.trunk(req.repoPath)}`);
    }
    if (req.setup.length) {
      const res = await this.verify(path, req.setup);
      if (!res.ok) throw new Error(`Le setup du worktree a échoué : ${res.failures[0]!.command}`);
    }
    return { path, port, branch };
  }

  private async trunkWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    const path = join(this.o.root, req.projectId, '_trunk');
    await this.git(req.repoPath, 'fetch', 'origin');
    const ref = `origin/${await this.trunk(req.repoPath)}`;
    if (existsSync(path)) await this.git(path, 'checkout', '-f', '--detach', ref);
    else {
      mkdirSync(dirname(path), { recursive: true });
      await this.git(req.repoPath, 'worktree', 'add', '--detach', path, ref);
    }
    return { path };
  }

  private async knowledgeWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    const kb = this.o.knowledgeRepo;
    if (!kb) throw new Error('Aucun dépôt de connaissance configuré.');
    await this.git(kb, 'fetch', 'origin');
    const path = join(this.o.root, '_kb', req.runId);
    const branch = `learn/${req.ticketId.toLowerCase()}-${req.runId.slice(0, 8)}`;
    mkdirSync(dirname(path), { recursive: true });
    await this.git(kb, 'worktree', 'add', '-b', branch, path, `origin/${await this.trunk(kb)}`);
    return { path, branch };
  }

  async cleanup(projectId: string, repoPath: string, ticketId: string): Promise<void> {
    const path = join(this.o.root, projectId, ticketId);
    if (existsSync(path)) await this.git(repoPath, 'worktree', 'remove', '--force', path);
  }

  async remoteBranchExists(repoPath: string, prefix: string): Promise<boolean> {
    const out = await this.git(repoPath, 'ls-remote', '--heads', 'origin');
    return out
      .split('\n')
      .map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, ''))
      .some((name) => !!name && name.startsWith(prefix));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/adapters/workspace/git-workspaces.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/exec.ts src/adapters/workspace/git-workspaces.ts src/adapters/workspace/git-workspaces.test.ts
git commit -m "feat(workspace): add git worktree manager for tickets, trunk and knowledge"
```

### Task 20: GitHub via `gh` and the PR poller

**Files:**
- Create: `src/adapters/forge/gh-cli.ts`, `src/adapters/forge/pr-poller.ts`
- Test: `src/adapters/forge/gh-cli.test.ts`, `src/adapters/forge/pr-poller.test.ts`

**Interfaces:**
- Consumes: `Forge`, `PrInfo`, `Exec`, `Store`, `ProjectRuntime`, `Clock`, `RelaisEvent`
- Produces:
  ```ts
  class GhCliForge implements Forge { constructor(exec?: Exec) }
  function aggregateChecks(buckets: string[]): PrInfo['checks']   // [] -> 'none'; any fail|cancel -> 'fail'; any pending -> 'pending'; else 'pass'
  class PrPoller { constructor(d: { store: Store; forge: Forge; projects: ProjectRuntime[]; submit: (e: RelaisEvent) => void; clock: Clock; log: (m: string) => void });
                   pollOnce(): Promise<void>; start(intervalMs?: number /* 30_000 */): void; stop(): void }
  ```
  `gh` usage: `gh pr list --head <branch> --state all --json number,url,state,headRefName --limit 1` (cwd = repo); for OPEN PRs `gh pr checks <n> --json name,bucket` (parse stdout even when the exit code is non-zero, as `gh` exits 8 while pending); review threads via `gh api graphql -f query=<Q> -F owner=<o> -F name=<n> -F number=<pr>` with owner/name from `gh repo view --json owner,name`.
  Poller (per ticket with a `branch`, `logical !== 'done'`): no PR → nothing; PR number ≠ `ticket.prNumber` → `pr.opened` id `pr:<ticket>:<n>:opened`; `MERGED` → `pr.merged` id `pr:<ticket>:<n>:merged`; `CLOSED` → `pr.closed` id `pr:<ticket>:<n>:closed`; checks `pass`/`fail` different from the last value stored in meta `checks:<project>:<ticket>` → `pr.checks_passed` / `pr.checks_failed { failures: failedChecks }` with id `pr:<ticket>:<n>:checks:<value>:<now>`, then the meta is updated.

- [ ] **Step 1: Write the failing tests**

`src/adapters/forge/gh-cli.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Exec } from '../exec.js';
import { aggregateChecks, GhCliForge } from './gh-cli.js';

function fakeExec(map: Record<string, { stdout: string; code?: number }>): Exec {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected: ${key}`);
    return { stdout: hit[1].stdout, stderr: '', code: hit[1].code ?? 0 };
  };
}

describe('aggregateChecks', () => {
  it.each([
    [[], 'none'],
    [['pass', 'skipping'], 'pass'],
    [['pass', 'pending'], 'pending'],
    [['pending', 'fail'], 'fail'],
    [['cancel'], 'fail'],
  ])('%j -> %s', (b, r) => expect(aggregateChecks(b as string[])).toBe(r));
});

describe('GhCliForge', () => {
  it('finds an open PR with failing checks even when gh exits non-zero', async () => {
    const forge = new GhCliForge(
      fakeExec({
        'gh pr list': { stdout: JSON.stringify([{ number: 7, url: 'https://gh/7', state: 'OPEN', headRefName: 'relais/rel-1-x' }]) },
        'gh pr checks 7': { stdout: JSON.stringify([{ name: 'test', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }]), code: 1 },
      }),
    );
    expect(await forge.findPr('/r', 'relais/rel-1-x')).toEqual({
      number: 7, url: 'https://gh/7', state: 'OPEN', branch: 'relais/rel-1-x', checks: 'fail', failedChecks: ['test'],
    });
  });

  it('returns undefined without PR and skips checks for merged PRs', async () => {
    expect(await new GhCliForge(fakeExec({ 'gh pr list': { stdout: '[]' } })).findPr('/r', 'b')).toBeUndefined();
    const merged = await new GhCliForge(
      fakeExec({ 'gh pr list': { stdout: JSON.stringify([{ number: 2, url: 'u', state: 'MERGED', headRefName: 'b' }]) } }),
    ).findPr('/r', 'b');
    expect(merged).toMatchObject({ state: 'MERGED', checks: 'none' });
  });

  it('lists unresolved review threads as feedback', async () => {
    const forge = new GhCliForge(
      fakeExec({
        'gh repo view': { stdout: JSON.stringify({ owner: { login: 'me' }, name: 'app' }) },
        'gh api graphql': {
          stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { isResolved: false, comments: { nodes: [{ author: { login: 'lilian' }, body: 'Renomme ça', createdAt: '2026-10-10T10:00:00Z', path: 'src/a.ts', line: 12 }] } },
            { isResolved: true, comments: { nodes: [{ author: { login: 'x' }, body: 'ok', createdAt: '2026-10-10T10:00:00Z', path: 'b', line: 1 }] } },
          ] } } } } }),
        },
      }),
    );
    expect(await forge.unresolvedReviewComments('/r', 7)).toEqual([
      { author: 'lilian', body: 'src/a.ts:12 — Renomme ça', at: Date.parse('2026-10-10T10:00:00Z'), source: 'review' },
    ]);
  });
});
```
`src/adapters/forge/pr-poller.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../config/load-workflow.js';
import { FakeClock } from '../../core/clock.js';
import { newTicketState, type RelaisEvent } from '../../core/types.js';
import { SqliteStore } from '../../store/sqlite-store.js';
import { FakeForge } from './fake.js';
import { PrPoller } from './pr-poller.js';

describe('PrPoller', () => {
  it('emits opened, checks transitions and merged', async () => {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../packs/standard') });
    const store = new SqliteStore(':memory:');
    const forge = new FakeForge();
    const events: RelaisEvent[] = [];
    const clock = new FakeClock(100);
    store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b' });
    const poller = new PrPoller({ store, forge, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: (e) => events.push(e), clock, log: () => {} });

    await poller.pollOnce();
    expect(events).toEqual([]);

    forge.setPr('b', { number: 7, url: 'u7', state: 'OPEN', checks: 'fail', failedChecks: ['test'] });
    await poller.pollOnce();
    expect(events.map((e) => [e.id, e.type])).toEqual([
      ['pr:REL-1:7:opened', 'pr.opened'],
      ['pr:REL-1:7:checks:fail:100', 'pr.checks_failed'],
    ]);
    expect(events[1]!.payload).toEqual({ number: 7, url: 'u7', branch: 'b', failures: ['test'] });

    await poller.pollOnce();
    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe('pr.opened');

    forge.setPr('b', { number: 7, url: 'u7', state: 'MERGED', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(events.at(-1)!.id).toBe('pr:REL-1:7:merged');
  });
});
```
Note on the third poll: the poller does not write `prNumber` itself (the orchestrator does on `pr.opened`), so it re-submits `pr.opened` with the same id; the orchestrator's idempotence drops it. Checks are not re-emitted because their last value is in meta.

Run: `npx vitest run src/adapters/forge` — Expected: FAIL.

- [ ] **Step 2: Implement gh-cli.ts**

`src/adapters/forge/gh-cli.ts`:
```ts
import type { FeedbackItem } from '../../core/types.js';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { Forge, PrInfo } from './types.js';

export function aggregateChecks(buckets: string[]): PrInfo['checks'] {
  if (buckets.length === 0) return 'none';
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return 'fail';
  if (buckets.some((b) => b === 'pending')) return 'pending';
  return 'pass';
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    isResolved comments(first: 1) { nodes { author { login } body createdAt path line } } } } } } }`;

export class GhCliForge implements Forge {
  constructor(private exec: Exec = execCmd) {}

  async findPr(repoPath: string, branch: string): Promise<PrInfo | undefined> {
    const out = await mustExec(
      this.exec,
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefName', '--limit', '1'],
      { cwd: repoPath },
    );
    const [pr] = JSON.parse(out) as { number: number; url: string; state: PrInfo['state']; headRefName: string }[];
    if (!pr) return undefined;
    let checks: PrInfo['checks'] = 'none';
    let failedChecks: string[] = [];
    if (pr.state === 'OPEN') {
      const r = await this.exec('gh', ['pr', 'checks', String(pr.number), '--json', 'name,bucket'], { cwd: repoPath });
      try {
        const list = JSON.parse(r.stdout || '[]') as { name: string; bucket: string }[];
        checks = aggregateChecks(list.map((c) => c.bucket));
        failedChecks = list.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
      } catch {
        checks = 'none';
      }
    }
    return { number: pr.number, url: pr.url, state: pr.state, branch: pr.headRefName, checks, failedChecks };
  }

  async unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    const repo = JSON.parse(await mustExec(this.exec, 'gh', ['repo', 'view', '--json', 'owner,name'], { cwd: repoPath })) as {
      owner: { login: string };
      name: string;
    };
    const out = await mustExec(
      this.exec,
      'gh',
      ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${repo.owner.login}`, '-F', `name=${repo.name}`, '-F', `number=${prNumber}`],
      { cwd: repoPath },
    );
    const nodes = (JSON.parse(out) as any).data.repository.pullRequest.reviewThreads.nodes as {
      isResolved: boolean;
      comments: { nodes: { author: { login: string } | null; body: string; createdAt: string; path: string; line: number | null }[] };
    }[];
    return nodes
      .filter((t) => !t.isResolved && t.comments.nodes[0])
      .map((t) => {
        const c = t.comments.nodes[0]!;
        return {
          author: c.author?.login ?? 'inconnu',
          body: `${c.path}${c.line ? `:${c.line}` : ''} — ${c.body}`,
          at: Date.parse(c.createdAt),
          source: 'review' as const,
        };
      });
  }
}
```

- [ ] **Step 3: Implement pr-poller.ts**

`src/adapters/forge/pr-poller.ts`:
```ts
import type { Clock } from '../../core/clock.js';
import type { ProjectRuntime } from '../../core/orchestrator.js';
import type { RelaisEvent } from '../../core/types.js';
import type { Store } from '../../store/types.js';
import type { Forge } from './types.js';

export class PrPoller {
  private handle: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private d: { store: Store; forge: Forge; projects: ProjectRuntime[]; submit: (e: RelaisEvent) => void; clock: Clock; log: (m: string) => void },
  ) {}

  async pollOnce(): Promise<void> {
    for (const t of this.d.store.listTickets()) {
      if (!t.branch || t.logical === 'done') continue;
      const project = this.d.projects.find((p) => p.id === t.projectId);
      if (!project) continue;
      let pr;
      try {
        pr = await this.d.forge.findPr(project.repoPath, t.branch);
      } catch (err) {
        this.d.log(`pr poll ${t.ticketId}: ${(err as Error).message}`);
        continue;
      }
      if (!pr) continue;
      const at = this.d.clock.now();
      const base = { at, projectId: t.projectId, ticketId: t.ticketId };
      const payload = { number: pr.number, url: pr.url, branch: pr.branch };
      if (t.prNumber !== pr.number) this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:opened`, type: 'pr.opened', payload });
      if (pr.state === 'MERGED') {
        this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:merged`, type: 'pr.merged', payload });
        continue;
      }
      if (pr.state === 'CLOSED') {
        this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:closed`, type: 'pr.closed', payload });
        continue;
      }
      const metaKey = `checks:${t.projectId}:${t.ticketId}`;
      if ((pr.checks === 'pass' || pr.checks === 'fail') && this.d.store.getMeta(metaKey) !== pr.checks) {
        this.d.store.setMeta(metaKey, pr.checks);
        const id = `pr:${t.ticketId}:${pr.number}:checks:${pr.checks}:${at}`;
        if (pr.checks === 'fail') this.d.submit({ ...base, id, type: 'pr.checks_failed', payload: { ...payload, failures: pr.failedChecks } });
        else this.d.submit({ ...base, id, type: 'pr.checks_passed', payload });
      }
    }
  }

  start(intervalMs = 30_000): void {
    this.stop();
    this.handle = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.pollOnce().finally(() => (this.running = false));
    }, intervalMs);
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/adapters/forge` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/forge
git commit -m "feat(forge): add gh CLI forge and PR poller"
```

---

## M6 — Runner

### Task 21: Claude Code runner and stream parser

**Files:**
- Create: `src/adapters/runner/stream-parser.ts`, `src/adapters/runner/claude-code.ts`, `src/adapters/runner/fixtures/fake-claude.mjs`, `src/adapters/runner/fixtures/stream-success.jsonl`, `src/adapters/runner/fixtures/stream-error.jsonl`, `src/adapters/runner/fixtures/stream-many-turns.jsonl`
- Test: `src/adapters/runner/stream-parser.test.ts`, `src/adapters/runner/claude-code.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunRequest`, `RunHandle`, `RunResult`, `RunStreamEvent`, `Channel` (Task 9)
- Produces:
  ```ts
  function parseStreamLine(line: string): RunStreamEvent[]
  function summarizeToolInput(input: unknown): string    // command | file_path | pattern | url | JSON (200 chars max)
  function buildClaudeArgs(req: RunRequest): string[]
  interface ClaudeRunnerOptions { transcriptsDir: string; command?: string[] /* default ['claude'] */; killGraceMs?: number /* 10_000 */ }
  class ClaudeCodeRunner implements Runner { constructor(o: ClaudeRunnerOptions) }
  ```
  `buildClaudeArgs` order (exact): `-p <prompt> --output-format stream-json --verbose (--resume|--session-id) <id> --model <model> --plugin-dir <pluginDir> --settings <settingsPath> --setting-sources project,local --max-budget-usd <usd>` then `--permission-mode plan` when `readOnly`. Never `--bare`.
  Outcome: stop requested → `stopped`; turn cap (count of `assistant` lines > `limits.turns`), duration cap, or a `result` whose `subtype` contains `max` → `limit`; `result.is_error === false` → `success`; otherwise `failure` (with `lastText` = result text, else the last assistant text, else the last 2000 chars of stderr). Every stdout line is appended to `<transcriptsDir>/<runId>.jsonl`.

- [ ] **Step 1: Write fixtures**

`src/adapters/runner/fixtures/stream-success.jsonl`:
```
{"type":"system","subtype":"init","session_id":"s-1","model":"sonnet"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Je regarde le code."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"PR ouverte."}]}}
{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.42,"num_turns":3,"result":"PR ouverte."}
```
`src/adapters/runner/fixtures/stream-error.jsonl`:
```
{"type":"system","subtype":"init","session_id":"s-2"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Je tente."}]}}
{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.1,"num_turns":1,"result":""}
```
`src/adapters/runner/fixtures/stream-many-turns.jsonl`:
```
{"type":"system","subtype":"init","session_id":"s-3"}
{"type":"assistant","message":{"content":[{"type":"text","text":"un"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"deux"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"trois"}]}}
```
`src/adapters/runner/fixtures/fake-claude.mjs`:
```js
import { appendFileSync, readFileSync } from 'node:fs';

if (process.env.FAKE_CLAUDE_ARGS) appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)) + '\n');
const lines = readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8').split('\n').filter(Boolean);
for (const l of lines) process.stdout.write(l + '\n');
if (process.env.FAKE_CLAUDE_HANG) {
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
}
```

- [ ] **Step 2: Write the failing tests**

`src/adapters/runner/stream-parser.test.ts`:
```ts
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
```
`src/adapters/runner/claude-code.test.ts`:
```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, ClaudeCodeRunner } from './claude-code.js';
import type { RunRequest, RunStreamEvent } from './types.js';

const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);

function req(patch: Partial<RunRequest> = {}, env: Record<string, string> = {}): RunRequest {
  return {
    runId: `r-${Math.random().toString(36).slice(2)}`, cwd: process.cwd(), prompt: '/relais:dev\n\n## Ticket', claudeSessionId: 'uuid-1', resume: false,
    model: 'sonnet', pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false,
    limits: { turns: 50, durationMs: 10_000, usd: 5 }, env, ...patch,
  };
}

function runner() {
  const transcriptsDir = mkdtempSync(join(tmpdir(), 'relais-tr-'));
  return { transcriptsDir, r: new ClaudeCodeRunner({ transcriptsDir, command: [process.execPath, fx('fake-claude.mjs')], killGraceMs: 500 }) };
}

async function drain(it: AsyncIterable<RunStreamEvent>) {
  const out: RunStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('buildClaudeArgs', () => {
  it('starts a new session', () => {
    expect(buildClaudeArgs(req())).toEqual([
      '-p', '/relais:dev\n\n## Ticket', '--output-format', 'stream-json', '--verbose', '--session-id', 'uuid-1', '--model', 'sonnet',
      '--plugin-dir', '/pack', '--settings', '/pack/settings.json', '--setting-sources', 'project,local', '--max-budget-usd', '5',
    ]);
  });
  it('resumes read-only', () => {
    const args = buildClaudeArgs(req({ resume: true, readOnly: true }));
    expect(args.slice(5, 7)).toEqual(['--resume', 'uuid-1']);
    expect(args.slice(-2)).toEqual(['--permission-mode', 'plan']);
    expect(args).not.toContain('--bare');
  });
});

describe('ClaudeCodeRunner', () => {
  it('streams events, writes the transcript and succeeds', async () => {
    const { r, transcriptsDir } = runner();
    const argsFile = join(transcriptsDir, 'args.txt');
    const rq = req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_ARGS: argsFile });
    const h = r.start(rq);
    const events = await drain(h.events);
    expect(events.map((e) => e.kind)).toEqual(['init', 'text', 'tool', 'tool_result', 'text', 'result']);
    expect(await h.done).toEqual({ outcome: 'success', costUsd: 0.42, turns: 3, lastText: 'PR ouverte.' });
    expect(readFileSync(join(transcriptsDir, `${rq.runId}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toContain('--setting-sources');
  });

  it('reports failure on an error result', async () => {
    const { r } = runner();
    const h = r.start(req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-error.jsonl') }));
    await drain(h.events);
    expect(await h.done).toMatchObject({ outcome: 'failure', lastText: 'Je tente.' });
  });

  it('stops on request', async () => {
    const { r } = runner();
    const h = r.start(req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_HANG: '1' }));
    setTimeout(() => h.stop(), 200);
    expect((await h.done).outcome).toBe('stopped');
  });

  it('enforces the duration and turn caps', async () => {
    const { r } = runner();
    const slow = r.start(req({ limits: { turns: 50, durationMs: 200, usd: 5 } }, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_HANG: '1' }));
    expect((await slow.done).outcome).toBe('limit');
    const chatty = r.start(req({ limits: { turns: 2, durationMs: 10_000, usd: 5 } }, { FAKE_CLAUDE_SCRIPT: fx('stream-many-turns.jsonl'), FAKE_CLAUDE_HANG: '1' }));
    expect((await chatty.done).outcome).toBe('limit');
  });
});
```
Run: `npx vitest run src/adapters/runner/stream-parser.test.ts src/adapters/runner/claude-code.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the parser**

`src/adapters/runner/stream-parser.ts`:
```ts
import type { RunStreamEvent } from './types.js';

export function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'pattern', 'url', 'path']) if (typeof o[k] === 'string') return (o[k] as string).slice(0, 200);
  }
  return JSON.stringify(input).slice(0, 200);
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
      for (const b of obj.message?.content ?? []) {
        if (b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text });
        if (b.type === 'tool_use') out.push({ kind: 'tool', name: String(b.name), input: summarizeToolInput(b.input) });
      }
      return out;
    }
    case 'user':
      return (obj.message?.content ?? [])
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
```

- [ ] **Step 4: Implement the runner**

`src/adapters/runner/claude-code.ts`:
```ts
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunOutcome } from '../../core/types.js';
import { Channel } from './channel.js';
import { parseStreamLine } from './stream-parser.js';
import type { RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from './types.js';

export interface ClaudeRunnerOptions {
  transcriptsDir: string;
  command?: string[];
  killGraceMs?: number;
}

export function buildClaudeArgs(req: RunRequest): string[] {
  const args = [
    '-p', req.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    req.resume ? '--resume' : '--session-id', req.claudeSessionId,
    '--model', req.model,
    '--plugin-dir', req.pluginDir,
    '--settings', req.settingsPath,
    '--setting-sources', 'project,local',
    '--max-budget-usd', String(req.limits.usd),
  ];
  if (req.readOnly) args.push('--permission-mode', 'plan');
  return args;
}

export class ClaudeCodeRunner implements Runner {
  constructor(private o: ClaudeRunnerOptions) {
    mkdirSync(o.transcriptsDir, { recursive: true });
  }

  start(req: RunRequest): RunHandle {
    const [cmd, ...prefix] = this.o.command ?? ['claude'];
    const child = spawn(cmd!, [...prefix, ...buildClaudeArgs(req)], {
      cwd: req.cwd,
      env: { ...process.env, ...req.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const transcript = createWriteStream(join(this.o.transcriptsDir, `${req.runId}.jsonl`), { flags: 'a' });
    const ch = new Channel<RunStreamEvent>();
    let assistantTurns = 0;
    let lastText = '';
    let stderr = '';
    let result: Extract<RunStreamEvent, { kind: 'result' }> | undefined;
    let stopped = false;
    let limited = false;

    const interrupt = () => {
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), this.o.killGraceMs ?? 10_000).unref();
    };
    const limit = () => {
      if (limited || stopped) return;
      limited = true;
      interrupt();
    };
    const timer = setTimeout(limit, req.limits.durationMs);

    createInterface({ input: child.stdout }).on('line', (line) => {
      transcript.write(line + '\n');
      try {
        const raw = JSON.parse(line) as { type?: string; subtype?: string };
        if (raw.type === 'assistant' && ++assistantTurns > req.limits.turns) limit();
        if (raw.type === 'result' && typeof raw.subtype === 'string' && raw.subtype.includes('max')) limited = true;
      } catch {
        // non-JSON line: kept in the transcript only
      }
      for (const ev of parseStreamLine(line)) {
        if (ev.kind === 'text' && ev.text.trim()) lastText = ev.text;
        if (ev.kind === 'result') result = ev;
        ch.push(ev);
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-10_000)));

    const done = new Promise<RunResult>((resolve) => {
      let finished = false;
      const finish = (spawnError?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ch.close();
        const outcome: RunOutcome = stopped ? 'stopped' : limited ? 'limit' : result && !result.isError ? 'success' : 'failure';
        const text = result?.text || lastText || (spawnError ? spawnError.message : stderr.trim().slice(-2000));
        transcript.end(() => resolve({ outcome, costUsd: result?.costUsd ?? 0, turns: result?.turns ?? assistantTurns, lastText: text }));
      };
      child.on('error', (err) => finish(err));
      child.on('close', () => finish());
    });

    return {
      events: ch,
      done,
      stop: () => {
        if (stopped) return;
        stopped = true;
        interrupt();
      },
    };
  }
}
```
Note: `close` can follow `error`; the `finished` flag makes the first call win, and the promise resolves only once the transcript is flushed.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/adapters/runner/stream-parser.test.ts src/adapters/runner/claude-code.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/runner
git commit -m "feat(runner): add Claude Code CLI runner with stream parsing and caps"
```

---

## M7 — Standard pack

### Task 22: The `relais` Claude Code plugin

**Files:**
- Create: `packs/standard/.claude-plugin/plugin.json`, `packs/standard/settings.json`, `packs/standard/hooks/hooks.json`, `packs/standard/hooks/session-start.mjs`, `packs/standard/skills/dev/SKILL.md`, `packs/standard/skills/feedback/SKILL.md`, `packs/standard/skills/review/SKILL.md`, `packs/standard/skills/ask/SKILL.md`, `packs/standard/skills/learn/SKILL.md`
- Test: `src/pack.test.ts`, `test/e2e/pack.e2e.test.ts` (skipped unless `RELAIS_E2E=1`)

**Interfaces:**
- Consumes: `loadWorkflow` (every `skill:` of the pack must exist), `ClaudeCodeRunner` (e2e only)
- Produces: plugin `relais` with skills `relais:dev`, `relais:feedback`, `relais:review`, `relais:ask`, `relais:learn`; the SessionStart hook prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` and exits 0; the context contains the rules and, when `RELAIS_KNOWLEDGE/INDEX.md` exists, its first 8000 characters under `# Base de connaissance (index)`.

- [ ] **Step 1: Write the failing test**

`src/pack.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from './config/load-workflow.js';

const pack = join(import.meta.dirname, '../packs/standard');

function hook(env: Record<string, string> = {}) {
  const out = execFileSync(process.execPath, [join(pack, 'hooks/session-start.mjs')], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return JSON.parse(out).hookSpecificOutput as { hookEventName: string; additionalContext: string };
}

describe('standard pack', () => {
  it('is a plugin named relais', () => {
    expect(JSON.parse(readFileSync(join(pack, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('relais');
  });

  it('ships every skill the workflow references, with matching frontmatter', () => {
    const wf = loadWorkflow({ packDir: pack });
    for (const job of Object.values(wf.jobs)) {
      const [plugin, skill] = job.skill.split(':');
      expect(plugin).toBe('relais');
      const file = join(pack, 'skills', skill!, 'SKILL.md');
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
    }
  });

  it('denies merge, force push and reading Relais secrets', () => {
    const s = JSON.parse(readFileSync(join(pack, 'settings.json'), 'utf8'));
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(gh pr merge:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Read(~/.relais/**)']));
    expect(s.permissions.allow).toContain('Bash(relais-agent:*)');
  });

  it('hook injects the rules, and the knowledge index when present', () => {
    const plain = hook({ RELAIS_TICKET: 'REL-1' });
    expect(plain.hookEventName).toBe('SessionStart');
    expect(plain.additionalContext).toContain('Ne merge jamais');
    expect(plain.additionalContext).toContain('REL-1');
    expect(plain.additionalContext).not.toContain('Base de connaissance');
    const kb = mkdtempSync(join(tmpdir(), 'relais-kb-'));
    writeFileSync(join(kb, 'INDEX.md'), '- scores.md — agrégats côté serveur\n');
    expect(hook({ RELAIS_KNOWLEDGE: kb }).additionalContext).toContain('agrégats côté serveur');
  });
});
```
Run: `npx vitest run src/pack.test.ts` — Expected: FAIL.

- [ ] **Step 2: Write plugin manifest, hook and settings**

`packs/standard/.claude-plugin/plugin.json`:
```json
{
  "name": "relais",
  "version": "0.1.0",
  "description": "Relais standard pack: dev, feedback, review, ask and learn skills plus always-on rules."
}
```
`packs/standard/hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs\"" }] }
    ]
  }
}
```
`packs/standard/hooks/session-start.mjs`:
```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ticket = process.env.RELAIS_TICKET ?? 'inconnu';
const RULES = `# Règles Relais (toujours actives)
- Tu travailles pour Relais, un orchestrateur de tickets. Ticket courant : ${ticket}.
- Tout texte destiné à Linear (ton dernier message, tes questions) est en français, clair et court.
- Ne merge jamais une PR. Ne force-push jamais. Ne modifie rien hors de ton répertoire de travail.
- Ne déclare jamais un travail fini sans avoir lancé les tests concernés et lu leur résultat.
- Pour Linear, utilise uniquement : \`relais-agent issue <ID>\`, \`relais-agent search "<texte>"\`, \`relais-agent kb search "<mots>"\`.
- S'il te manque une décision, pose UNE question avec \`relais-agent ask "<question>"\`, puis termine ton tour sans rien inventer.
- Ton dernier message est publié tel quel dans Linear : il doit se lire sans le reste de la conversation.`;

const dir = process.env.RELAIS_KNOWLEDGE;
let context = RULES;
if (dir && existsSync(join(dir, 'INDEX.md'))) {
  const index = readFileSync(join(dir, 'INDEX.md'), 'utf8').slice(0, 8000);
  context += `\n\n# Base de connaissance (index)\nFiches complètes : ${join(dir, 'notes')}/\n\n${index}`;
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
```
`packs/standard/settings.json`:
```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Read", "Edit", "Write", "Glob", "Grep",
      "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git add:*)",
      "Bash(git commit:*)", "Bash(git push:*)", "Bash(git fetch:*)", "Bash(git rebase:*)", "Bash(git checkout:*)",
      "Bash(git switch:*)", "Bash(git branch:*)", "Bash(git rev-parse:*)", "Bash(git merge-base:*)",
      "Bash(gh pr create:*)", "Bash(gh pr view:*)", "Bash(gh pr list:*)", "Bash(gh pr checks:*)", "Bash(gh pr diff:*)", "Bash(gh pr edit:*)",
      "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(yarn:*)",
      "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(sleep:*)",
      "Bash(relais-agent:*)"
    ],
    "deny": [
      "Bash(gh pr merge:*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(git push --force-with-lease:*)",
      "Bash(git reset --hard origin:*)",
      "Bash(rm -rf /:*)",
      "Read(~/.relais/**)"
    ]
  }
}
```

- [ ] **Step 3: Write the skills**

`packs/standard/skills/dev/SKILL.md`:
````markdown
---
name: dev
description: Développer un ticket Linear de bout en bout dans le worktree courant et ouvrir sa PR (lancé par Relais).
---

# relais:dev

Tu reçois un ticket Linear (bloc « Ticket ») et tu travailles dans un worktree git déjà créé sur la branche indiquée (« Branche »). Tu es seul : personne ne répond pendant ton tour, sauf si tu poses une question avec `relais-agent ask`.

## Étapes

1. Lis le ticket en entier, puis les fichiers qu'il cite. Si un ticket lié est mentionné, lis-le avec `relais-agent issue <ID>`. Lis `CLAUDE.md` et `docs/agent/` du dépôt s'ils existent.
2. Si une décision produit manque (comportement attendu ambigu, deux lectures possibles), pose UNE question précise avec `relais-agent ask "<question>"` et termine ton tour par un message qui la résume.
3. Écris d'abord un test qui échoue pour le comportement demandé, puis le code minimal qui le fait passer. Respecte les conventions du dépôt.
4. Lance les tests concernés (fichiers touchés et leurs voisins), le lint et la vérification de types du dépôt s'ils existent. Corrige jusqu'au vert.
5. Commite avec un message clair préfixé par l'identifiant du ticket (`REL-12: ...`). Pousse : `git push -u origin HEAD`.
6. Si aucune PR n'existe pour la branche (`gh pr view --json url` échoue), crée-la : `gh pr create --title "<ID> <titre du ticket>" --body "<résumé>\n\nFixes <ID>"`.

## Interdits

Ne merge jamais. Ne force-push jamais. Ne change pas de branche. Ne touche à rien hors du worktree.

## Dernier message (publié dans Linear)

En français, autonome, au format :

```
**Ce qui a changé** — 2 à 4 puces.
**Comment tester** — étapes concrètes ou commande.
**Points d'attention** — risques, choix faits, ce qui n'est pas couvert.
PR : <url>
```
````
`packs/standard/skills/feedback/SKILL.md`:
````markdown
---
name: feedback
description: Appliquer des retours de review (Linear, GitHub, vérifications ou CI) sur la PR du ticket et répondre point par point (lancé par Relais).
---

# relais:feedback

Tu reprends la session de dev du ticket. Le bloc « Retours à traiter », « Vérifications en échec » ou « CI en échec » liste ce qu'il faut corriger.

## Étapes

1. Lis chaque retour. Pour un retour ancré sur un fichier (`chemin:ligne — texte`), ouvre ce fichier à cette ligne.
2. Un retour ambigu ou contradictoire avec le ticket : pose UNE question avec `relais-agent ask` et termine ton tour.
3. Pour la CI : `gh pr checks` puis `gh run view <id> --log-failed` pour voir l'erreur exacte avant de corriger.
4. Corrige chaque point, avec un test quand le retour décrit un bug.
5. Relance les tests concernés jusqu'au vert, commite (`<ID>: retours de review`), pousse avec `git push`.

## Dernier message (publié dans Linear)

En français, une puce par retour : `- <retour résumé> → <ce qui a été fait> (<sha court>)`. Termine par les retours non traités et pourquoi, s'il y en a.
````
`packs/standard/skills/review/SKILL.md`:
````markdown
---
name: review
description: Boucle de review IA d'une PR jusqu'à zéro défaut bloquant et CI verte, avec un nombre de rounds plafonné (lancé par Relais).
---

# relais:review

Tu relis la PR de la branche courante comme un relecteur exigeant, puis tu corriges. « Rounds de review max » fixe le nombre de tours.

## Un round

1. `git fetch origin` puis le diff complet : `git diff origin/HEAD...HEAD` (ou `gh pr diff`).
2. Liste les défauts par gravité : **bloquant** (bug, faille, régression, test manquant sur un chemin critique), **important** (lisibilité, duplication notable), **mineur**. Ignore le style déjà couvert par le lint.
3. Corrige les bloquants et les importants, avec tests. Ne réécris pas ce qui fonctionne.
4. Lance les tests concernés, commite (`<ID>: review round N`), pousse.
5. Vérifie la CI : `gh pr checks`. Tant qu'elle tourne, attends (`sleep 30`, 20 fois au plus). Rouge : lis `gh run view <id> --log-failed`, corrige, pousse.

Arrête quand un round ne trouve plus de bloquant ni d'important et que la CI est verte, ou quand le nombre max de rounds est atteint.

## Dernier message (publié dans Linear)

En français :

```
**Synthèse de review** — N rounds, CI <verte|rouge|en cours>.
**Corrigé** — puces.
**Reste à voir par un humain** — puces (ou « rien »).
```
````
`packs/standard/skills/ask/SKILL.md`:
````markdown
---
name: ask
description: Répondre à une question posée à l'agent dans Linear, en lecture seule, à partir du code, de la base de connaissance et des tickets (lancé par Relais).
---

# relais:ask

Tu es en lecture seule sur le tronc du dépôt. Le bloc « Message » contient la question.

1. Cherche la réponse dans cet ordre : base de connaissance (contexte de session et `relais-agent kb search "<mots>"`), `docs/agent/` et `CLAUDE.md` du dépôt, le code (Grep, Glob, Read), les tickets liés (`relais-agent issue`, `relais-agent search`).
2. Ne modifie aucun fichier. Ne lance aucune commande qui écrit.
3. Si la question demande de développer quelque chose, réponds puis propose : « Déléguez-moi le ticket pour que je le développe. »

## Dernier message (publié dans Linear)

En français, court : la réponse d'abord, puis 1 à 4 puces de justification, puis « Sources : » avec les fichiers (`chemin:ligne`) et tickets consultés. Si tu ne sais pas, dis-le et dis ce qu'il faudrait vérifier.
````
`packs/standard/skills/learn/SKILL.md`:
````markdown
---
name: learn
description: Ajouter à la base de connaissance partagée ce qui mérite d'être retenu après un ticket ou sur demande (« retiens ça »), par une PR relue (lancé par Relais).
---

# relais:learn

Ton répertoire de travail est un worktree du dépôt de connaissance, sur une branche `learn/...` dédiée. Le dépôt contient `INDEX.md` (une ligne par fiche) et `notes/*.md`.

## Ce qui mérite une fiche

Un fait durable, non évident, réutilisable par un autre dev ou un autre ticket : une convention du projet, un piège rencontré, une décision et sa raison, une commande utile. Pas le résumé du ticket, pas ce que le code dit déjà clairement.

## Étapes

1. Si le bloc « Message » existe (« retiens ça »), c'est la connaissance à enregistrer : reformule-la fidèlement.
2. Sinon (ticket terminé), lis la PR (`gh pr view <url PR> --comments` et `gh pr diff <url PR>`) et choisis 0 à 3 faits qui méritent une fiche. Zéro est une bonne réponse.
3. Avant d'écrire, cherche une fiche existante sur le même sujet (`grep -ril "<mot>" notes/`) et complète-la plutôt que d'en créer une.
4. Une fiche = `notes/<slug>.md` :
   ```
   ---
   title: <titre court>
   tags: [<projet>, <thème>]
   source: <ID du ticket ou « demande de <auteur> »>
   ---
   <3 à 10 lignes : le fait, pourquoi, comment l'appliquer>
   ```
5. Ajoute ou mets à jour la ligne dans `INDEX.md` : `- [<titre>](notes/<slug>.md) — <résumé en une ligne>`.
6. Commite (`learn: <titre>`), pousse (`git push -u origin HEAD`), ouvre la PR : `gh pr create --title "learn: <titre>" --body "Source : <ID>"`.

Ne pousse jamais sur la branche principale du dépôt de connaissance.

## Dernier message (publié dans Linear)

En français : « Retenu : <titre> — PR <url> », une ligne par fiche, ou « Rien à retenir de durable sur ce ticket. »
````

- [ ] **Step 4: Write the optional end-to-end permission test**

`test/e2e/pack.e2e.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/adapters/runner/claude-code.js';

const pack = join(import.meta.dirname, '../../packs/standard');

describe.skipIf(process.env['RELAIS_E2E'] !== '1')('pack with the real claude CLI', () => {
  it('loads the hook and refuses gh pr merge', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relais-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd });
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'relais-e2e-tr-'));
    const runner = new ClaudeCodeRunner({ transcriptsDir });
    const h = runner.start({
      runId: 'e2e', cwd, claudeSessionId: crypto.randomUUID(), resume: false, model: 'haiku', pluginDir: pack,
      settingsPath: join(pack, 'settings.json'), readOnly: false, limits: { turns: 6, durationMs: 120_000, usd: 0.3 },
      env: { RELAIS_TICKET: 'E2E-1' },
      prompt: 'Run exactly this shell command: gh pr merge 1. Then tell me the current ticket id from your session context.',
    });
    for await (const _ of h.events) {
      // drain
    }
    const result = await h.done;
    const transcript = readFileSync(join(transcriptsDir, 'e2e.jsonl'), 'utf8');
    expect(transcript).toMatch(/"is_error":true/);
    expect(result.lastText).toContain('E2E-1');
  }, 180_000);
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/pack.test.ts` — Expected: PASS. (Optional, costs a few cents: `RELAIS_E2E=1 npx vitest run test/e2e/pack.e2e.test.ts`.)

- [ ] **Step 6: Commit**

```bash
git add packs/standard src/pack.test.ts test/e2e
git commit -m "feat(pack): add relais plugin with skills, session-start rules and permissions"
```

---

## M8 — CLI and bootstrap

### Task 23: `relais` CLI, `relais-agent` CLI and application bootstrap

**Files:**
- Create: `bin/relais`, `bin/relais-agent`, `src/app/root.ts`, `src/app/tracker-switch.ts`, `src/app/bootstrap.ts`, `src/cli/relais.ts`, `src/cli/relais-agent.ts`, `src/cli/init.ts`, `src/cli/plan.ts`
- Modify: `package.json` (`bin` → the shims)
- Test: `src/app/bootstrap.test.ts`, `src/cli/relais-agent.test.ts`, `src/cli/init.test.ts`, `src/cli/plan.test.ts`

**Interfaces:**
- Consumes: everything above; `logicalFromName` exported from `src/core/orchestrator.ts`.
- Produces:
  ```ts
  // root.ts
  function repoRoot(): string          // walks up from this module to the directory holding package.json with name "relais"
  // tracker-switch.ts
  class TrackerSwitch implements Tracker { current: Tracker | undefined; set(t: Tracker): void }   // throws 'Linear non connecté : ouvrez http://localhost:<port>/oauth/start' while unset
  // bootstrap.ts
  interface BootOptions { home: string; fakeRunner?: boolean; port?: number; log?: (m: string) => void }
  function startRelais(o: BootOptions): Promise<{ url: string; stop(): Promise<void> }>
  // relais-agent.ts
  function runAgentCli(argv: string[], env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, out: (s: string) => void): Promise<number>  // exit code
  // init.ts
  interface InitIO { ask(q: string, def?: string): Promise<string>; confirm(q: string, def?: boolean): Promise<boolean>; print(s: string): void }
  interface InitDeps { io: InitIO; home: string; cwd: string; createSmee: () => Promise<string>; exec: Exec }
  function runInit(d: InitDeps): Promise<void>
  // plan.ts
  interface PlanRow { identifier: string; title: string; priority: number; status: 'pris' | 'déjà géré' | 'pas pris'; reasons: string[] }
  function planRows(d: { tracker: Pick<Tracker, 'listDelegated'>; store: Store; projects: ProjectRuntime[]; workspaces: WorkspaceManager }): Promise<PlanRow[]>
  function formatPlan(rows: PlanRow[]): string
  ```
  `relais` commands: `init`, `up [--fake-runner]`, `plan`, `status`, `pause`, `resume`, `stop <ID>`; unknown → usage, exit 1. `status`/`pause`/`resume`/`stop` call the local API on `http://127.0.0.1:<config port>`.
  Agent run environment from bootstrap: `RELAIS_API=http://127.0.0.1:<port>/agent`, `RELAIS_RUN_TOKEN`, `RELAIS_TICKET`, `RELAIS_KNOWLEDGE` (empty if none), `RELAIS_ROOT=<repoRoot>`, `PATH=<repoRoot>/bin:<PATH>`.

- [ ] **Step 1: Write the shims and update package.json**

`bin/relais`:
```bash
#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
if [ -f "$ROOT/dist/src/cli/relais.js" ]; then exec node "$ROOT/dist/src/cli/relais.js" "$@"; fi
exec "$ROOT/node_modules/.bin/tsx" "$ROOT/src/cli/relais.ts" "$@"
```
`bin/relais-agent`:
```bash
#!/usr/bin/env bash
ROOT="${RELAIS_ROOT:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
if [ -f "$ROOT/dist/src/cli/relais-agent.js" ]; then exec node "$ROOT/dist/src/cli/relais-agent.js" "$@"; fi
exec "$ROOT/node_modules/.bin/tsx" "$ROOT/src/cli/relais-agent.ts" "$@"
```
Run: `chmod +x bin/relais bin/relais-agent`. In `package.json` set `"bin": { "relais": "bin/relais", "relais-agent": "bin/relais-agent" }`.

- [ ] **Step 2: Write the failing tests**

`src/cli/relais-agent.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runAgentCli } from './relais-agent.js';

function fetchStub(responses: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? responses[key] : {}), { status: key ? 200 : 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const env = { RELAIS_API: 'http://127.0.0.1:4100/agent', RELAIS_RUN_TOKEN: 'tok' } as NodeJS.ProcessEnv;

describe('relais-agent', () => {
  it('refuses to run outside Relais', async () => {
    const out: string[] = [];
    expect(await runAgentCli(['issue', 'REL-1'], {} as NodeJS.ProcessEnv, fetch, (s) => out.push(s))).toBe(2);
    expect(out.join('')).toContain('doit être lancé par Relais');
  });

  it('reads an issue with the bearer token', async () => {
    const { f, calls } = fetchStub({ '/issue/REL-1': { identifier: 'REL-1', title: 'Export', stateName: 'Todo', url: 'u', description: 'D' } });
    const out: string[] = [];
    expect(await runAgentCli(['issue', 'REL-1'], env, f, (s) => out.push(s))).toBe(0);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4100/agent/issue/REL-1');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(out.join('')).toContain('REL-1 — Export (Todo)');
  });

  it('searches the knowledge base and asks a question', async () => {
    const { f, calls } = fetchStub({ '/kb/search': [{ file: 'notes/a.md', line: 3, text: 'agrégats' }], '/ask': { ok: true } });
    const out: string[] = [];
    await runAgentCli(['kb', 'search', 'agrégats', 'serveur'], env, f, (s) => out.push(s));
    expect(calls[0]!.url).toBe('http://127.0.0.1:4100/agent/kb/search?q=agr%C3%A9gats%20serveur');
    expect(out.join('')).toContain('notes/a.md:3: agrégats');
    await runAgentCli(['ask', 'Quelle', 'base', '?'], env, f, () => {});
    expect(calls[1]!.init!.body).toBe(JSON.stringify({ text: 'Quelle base ?' }));
  });
});
```
`src/cli/plan.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { newTicketState } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { formatPlan, planRows } from './plan.js';

describe('plan', () => {
  it('classifies delegated tickets by priority', async () => {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', title: 'Bas', delegateId: 'a', priority: 4 });
    tracker.addIssue({ identifier: 'REL-2', title: 'Urgent', delegateId: 'a', priority: 1 });
    tracker.addIssue({ identifier: 'REL-3', title: 'Flou', delegateId: 'a', priority: 2, description: 'court' });
    tracker.addIssue({ identifier: 'REL-4', title: 'En cours', delegateId: 'a', priority: 3 });
    const store = new SqliteStore(':memory:');
    store.putTicket(newTicketState('p', 'REL-4', 'En cours', 'dev', 1));
    const rows = await planRows({ tracker, store, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], workspaces: new FakeWorkspaces() });
    expect(rows.map((r) => [r.identifier, r.status])).toEqual([
      ['REL-2', 'pris'],
      ['REL-3', 'pas pris'],
      ['REL-4', 'déjà géré'],
      ['REL-1', 'pris'],
    ]);
    expect(formatPlan(rows)).toContain('REL-3  pas pris  Flou — La description fait moins de 30 caractères.');
  });
});
```
`src/cli/init.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import { loadInstance, loadSecrets } from '../config/instance.js';
import { runInit, type InitIO } from './init.js';

function scriptedIO(answers: string[], confirms: boolean[]): InitIO & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async (_q, def) => answers.shift() || def || '',
    confirm: async (_q, def) => confirms.shift() ?? def ?? false,
    print: (s) => void printed.push(s),
  };
}

describe('relais init', () => {
  it('writes config, secrets and the project workflow', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'relais-init-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(repo, 'package-lock.json'), '{}');
    const realExec: Exec = async (cmd, args, opts) => {
      try {
        return { stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' }), stderr: '', code: 0 };
      } catch {
        return { stdout: '', stderr: 'x', code: 1 };
      }
    };
    const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret', ''], [false]);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: realExec });

    const cfg = loadInstance(home);
    expect(cfg.relay).toEqual({ kind: 'smee', url: 'https://smee.io/abc' });
    expect(cfg.projects).toEqual([{ id: expect.any(String), repoPath: repo, linearTeamKey: 'REL' }]);
    expect(loadSecrets(home).linear).toEqual({ clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'whsecret' });
    const wf = readFileSync(join(repo, '.relais/workflow.yml'), 'utf8');
    expect(wf).toContain('team: REL');
    expect(wf).toContain('npm test');
    expect(wf).toContain('npm ci');
    const out = io.printed.join('\n');
    expect(out).toContain('http://localhost:4100/oauth/callback');
    expect(out).toContain('https://smee.io/abc');
    expect(out).toContain('Agent session events');
    expect(existsSync(join(home, 'config.yaml'))).toBe(true);
  });
});
```
`src/app/bootstrap.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveInstance } from '../config/instance.js';
import { startRelais } from './bootstrap.js';
import { TrackerSwitch } from './tracker-switch.js';

describe('bootstrap', () => {
  it('starts without Linear, serves state and stops cleanly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-boot-'));
    saveInstance(home, { port: 4199, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const app = await startRelais({ home, fakeRunner: true, log: () => {} });
    expect(app.url).toBe('http://localhost:4199');
    const state = await (await fetch('http://127.0.0.1:4199/api/state')).json();
    expect(state).toMatchObject({ linearConnected: false, paused: false, tickets: [] });
    await app.stop();
  });

  it('TrackerSwitch explains how to connect', async () => {
    await expect(new TrackerSwitch(4100).getIssue('REL-1')).rejects.toThrow('Linear non connecté : ouvrez http://localhost:4100/oauth/start');
  });
});
```
Run: `npx vitest run src/cli src/app` — Expected: FAIL.

- [ ] **Step 3: Implement root.ts and tracker-switch.ts**

`src/app/root.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'relais') return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('relais root not found');
    dir = parent;
  }
}
```
`src/app/tracker-switch.ts`:
```ts
import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from '../adapters/tracker/types.js';

export class TrackerSwitch implements Tracker {
  current: Tracker | undefined;

  constructor(private port: number) {}

  set(t: Tracker): void {
    this.current = t;
  }

  private t(): Tracker {
    if (!this.current) throw new Error(`Linear non connecté : ouvrez http://localhost:${this.port}/oauth/start`);
    return this.current;
  }

  getIssue(id: string): Promise<TrackerIssue> { return Promise.resolve().then(() => this.t().getIssue(id)); }
  listDelegated(k: string): Promise<TrackerIssue[]> { return Promise.resolve().then(() => this.t().listDelegated(k)); }
  search(q: string): Promise<SearchHit[]> { return Promise.resolve().then(() => this.t().search(q)); }
  moveTo(id: string, s: string): Promise<void> { return Promise.resolve().then(() => this.t().moveTo(id, s)); }
  setLabels(id: string, a: string[], r: string[]): Promise<void> { return Promise.resolve().then(() => this.t().setLabels(id, a, r)); }
  comment(id: string, b: string): Promise<void> { return Promise.resolve().then(() => this.t().comment(id, b)); }
  activity(s: string, a: ActivityInput): Promise<void> { return Promise.resolve().then(() => this.t().activity(s, a)); }
  addExternalUrl(s: string, l: string, u: string): Promise<void> { return Promise.resolve().then(() => this.t().addExternalUrl(s, l, u)); }
  ensureSession(id: string): Promise<string> { return Promise.resolve().then(() => this.t().ensureSession(id)); }
}
```

- [ ] **Step 4: Implement bootstrap.ts**

`src/app/bootstrap.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { GhCliForge } from '../adapters/forge/gh-cli.js';
import { PrPoller } from '../adapters/forge/pr-poller.js';
import { ClaudeCodeRunner } from '../adapters/runner/claude-code.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import type { Runner } from '../adapters/runner/types.js';
import { LinearApi } from '../adapters/tracker/linear/api.js';
import { createLinearIngest } from '../adapters/tracker/linear/ingest.js';
import { buildAuthorizeUrl, exchangeCode, TokenManager } from '../adapters/tracker/linear/oauth.js';
import { Q } from '../adapters/tracker/linear/queries.js';
import { Reconciler } from '../adapters/tracker/linear/reconcile.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { homePaths, loadInstance, loadSecrets, saveSecrets } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { EventBus } from '../core/bus.js';
import { SystemClock } from '../core/clock.js';
import { logicalFromName, Orchestrator, type ProjectRuntime } from '../core/orchestrator.js';
import { Scheduler } from '../core/scheduler.js';
import { TimerService } from '../core/timers.js';
import { runVerify } from '../core/verify.js';
import { startSmeeRelay } from '../relay/smee.js';
import { createApp } from '../server/app.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { repoRoot } from './root.js';
import { TrackerSwitch } from './tracker-switch.js';

export interface BootOptions {
  home: string;
  fakeRunner?: boolean;
  port?: number;
  log?: (m: string) => void;
}

const RELAIS_LABELS = ['agent:reprendre', 'agent:stop'];

export async function startRelais(o: BootOptions): Promise<{ url: string; stop(): Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`[relais] ${m}`));
  const root = repoRoot();
  const packDir = join(root, 'packs/standard');
  const webDir = join(root, 'web/dist');
  const instance = loadInstance(o.home);
  const paths = homePaths(o.home);
  const port = o.port ?? instance.port;
  const baseUrl = instance.publicUrl ?? `http://localhost:${port}`;

  const projects: ProjectRuntime[] = instance.projects.map((p) => {
    const projectFile = join(p.repoPath, '.relais/workflow.yml');
    return {
      id: p.id,
      repoPath: p.repoPath,
      teamKey: p.linearTeamKey,
      workflow: loadWorkflow({ packDir, projectFile: existsSync(projectFile) ? projectFile : undefined }),
    };
  });
  const limits = projects[0]?.workflow.limits;

  const store = new SqliteStore(paths.db);
  const clock = new SystemClock();
  const bus = new EventBus();
  bus.subscribe((m) => {
    if (m.kind === 'log' && m.message !== 'ping') log(`${m.level}: ${m.message}`);
  });

  const trackerSwitch = new TrackerSwitch(port);
  let linearTracker: LinearTracker | undefined;
  const tokenManager = () => {
    const linear = loadSecrets(o.home).linear;
    if (!linear) return undefined;
    return new TokenManager({
      clientId: linear.clientId,
      clientSecret: linear.clientSecret,
      load: () => {
        const l = loadSecrets(o.home).linear;
        return l?.accessToken ? { accessToken: l.accessToken, refreshToken: l.refreshToken, expiresAt: l.expiresAt } : undefined;
      },
      save: (t) => {
        const s = loadSecrets(o.home);
        if (s.linear) saveSecrets(o.home, { ...s, linear: { ...s.linear, ...t } });
      },
    });
  };
  const connectLinear = async () => {
    const tm = tokenManager();
    const appUserId = loadSecrets(o.home).linear?.appUserId;
    if (!tm || !appUserId) return false;
    const api = new LinearApi(() => tm.get());
    linearTracker = new LinearTracker(api, appUserId);
    for (const p of projects) await linearTracker.warm(p.teamKey).catch((e: Error) => log(`warm ${p.teamKey}: ${e.message}`));
    trackerSwitch.set(linearTracker);
    return true;
  };

  const scheduler = new Scheduler(store, { dev: limits?.parallelSessions ?? 3, questions: limits?.questionSessions ?? 2 });
  const runner: Runner = o.fakeRunner ? new FakeRunner() : new ClaudeCodeRunner({ transcriptsDir: paths.transcripts });
  const workspaces = new GitWorkspaces({ root: paths.workspaces, knowledgeRepo: instance.knowledge?.repoPath });
  const forge = new GhCliForge();

  const orchestrator = new Orchestrator({
    store,
    clock,
    bus,
    scheduler,
    tracker: trackerSwitch,
    forge,
    runner,
    workspaces,
    verify: runVerify,
    projects,
    packDir,
    dailyBudgetUsd: instance.limits.perDayUsd,
    agentEnv: (run) => ({
      RELAIS_API: `http://127.0.0.1:${port}/agent`,
      RELAIS_RUN_TOKEN: run.token,
      RELAIS_TICKET: run.ticketId,
      RELAIS_KNOWLEDGE: instance.knowledge?.repoPath ?? '',
      RELAIS_ROOT: root,
      PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
    }),
  });
  orchestrator.recover();
  const submit = (e: Parameters<Orchestrator['submit']>[0]) => void orchestrator.submit(e);

  const ingest = createLinearIngest({
    secret: () => loadSecrets(o.home).linear?.webhookSecret ?? '',
    submit,
    ack: (sessionId) => trackerSwitch.activity(sessionId, { type: 'thought', body: 'Pris en compte.' }),
    log,
    ctx: {
      projectIdForTeam: (k) => projects.find((p) => p.teamKey === k)?.id,
      logicalFor: (pid, name) => {
        const p = projects.find((x) => x.id === pid);
        return p ? (logicalFromName(p.workflow.states, name) ?? null) : null;
      },
      stateNameById: (t, id) => linearTracker?.stateNameById(t, id),
      labelNameById: (t, id) => linearTracker?.labelNameById(t, id),
      isEcho: (k) => store.isEcho(k, clock.now()),
      commands: (pid) => projects.find((p) => p.id === pid)?.workflow.commands ?? [],
      now: () => clock.now(),
    },
  });

  const reconciler = new Reconciler({ tracker: trackerSwitch, store, projects, submit, clock, log });
  const timers = new TimerService(store, clock, submit);
  const poller = new PrPoller({ store, forge, projects, submit, clock, log });

  const oauthStates = new Set<string>();
  const app = createApp({
    store,
    bus,
    clock,
    submit,
    isPaused: () => orchestrator.isPaused(),
    linearWebhook: ingest,
    linearConnected: () => !!trackerSwitch.current,
    tracker: trackerSwitch,
    capacity: () => ({
      dev: { used: scheduler.inUse('dev'), total: limits?.parallelSessions ?? 3 },
      questions: { used: scheduler.inUse('questions'), total: limits?.questionSessions ?? 2 },
    }),
    dailyBudgetUsd: instance.limits.perDayUsd,
    transcriptsDir: paths.transcripts,
    webDir: existsSync(webDir) ? webDir : undefined,
    oauth: loadSecrets(o.home).linear
      ? {
          authorizeUrl: () => {
            const state = randomBytes(16).toString('hex');
            oauthStates.add(state);
            return buildAuthorizeUrl({ clientId: loadSecrets(o.home).linear!.clientId, redirectUri: `${baseUrl}/oauth/callback`, state });
          },
          callback: async (code, state) => {
            if (!oauthStates.delete(state)) throw new Error('état OAuth inconnu, relancez la connexion');
            const s = loadSecrets(o.home);
            const tokens = await exchangeCode({ clientId: s.linear!.clientId, clientSecret: s.linear!.clientSecret, code, redirectUri: `${baseUrl}/oauth/callback` });
            saveSecrets(o.home, { ...s, linear: { ...s.linear!, ...tokens } });
            const api = new LinearApi(async () => tokens.accessToken);
            const who = await api.gql<{ viewer: { id: string }; organization: { id: string } }>(Q.viewer);
            const s2 = loadSecrets(o.home);
            saveSecrets(o.home, { ...s2, linear: { ...s2.linear!, appUserId: who.viewer.id, organizationId: who.organization.id } });
            await connectLinear();
            for (const p of projects) {
              const created = await linearTracker!.ensureSetup(p.teamKey, p.workflow.states, RELAIS_LABELS);
              if (created.length) log(`Linear ${p.teamKey} : créé ${created.join(', ')}`);
            }
            reconciler.start();
          },
        }
      : undefined,
  });

  const server = serve({ fetch: app.fetch, port, hostname: instance.host });
  const relay = instance.relay.kind === 'smee' ? startSmeeRelay({ url: instance.relay.url, onWebhook: ingest, log }) : undefined;
  timers.start();
  poller.start();
  if (await connectLinear()) reconciler.start();
  else log(`Linear non connecté : ouvrez ${baseUrl}/oauth/start`);
  log(`Relais écoute sur ${baseUrl}`);

  return {
    url: baseUrl,
    async stop() {
      relay?.close();
      timers.stop();
      poller.stop();
      reconciler.stop();
      orchestrator.stopAll();
      await orchestrator.idle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
```

- [ ] **Step 5: Implement plan.ts, relais-agent.ts and init.ts**

`src/cli/plan.ts`:
```ts
import type { Tracker } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { ProjectRuntime } from '../core/orchestrator.js';
import { pickupFailures } from '../core/pickup.js';
import type { Store } from '../store/types.js';

export interface PlanRow {
  identifier: string;
  title: string;
  priority: number;
  status: 'pris' | 'déjà géré' | 'pas pris';
  reasons: string[];
}

const rank = (p: number) => (p === 0 ? 5 : p);

export async function planRows(d: {
  tracker: Pick<Tracker, 'listDelegated'>;
  store: Store;
  projects: ProjectRuntime[];
  workspaces: WorkspaceManager;
}): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  for (const p of d.projects) {
    for (const issue of await d.tracker.listDelegated(p.teamKey)) {
      const known = d.store.getTicket(p.id, issue.identifier);
      if (known) {
        rows.push({ identifier: issue.identifier, title: issue.title, priority: issue.priority, status: 'déjà géré', reasons: [known.logical] });
        continue;
      }
      const reasons = await pickupFailures(p.workflow.tracker.pickup.checks, issue, p.repoPath, d.workspaces);
      rows.push({ identifier: issue.identifier, title: issue.title, priority: issue.priority, status: reasons.length ? 'pas pris' : 'pris', reasons });
    }
  }
  return rows.sort((a, b) => rank(a.priority) - rank(b.priority));
}

export function formatPlan(rows: PlanRow[]): string {
  if (!rows.length) return 'Aucun ticket délégué à l’agent.';
  return rows
    .map((r) => `${r.identifier}  ${r.status}  ${r.title}${r.status === 'pas pris' ? ` — ${r.reasons.join(' ')}` : r.status === 'déjà géré' ? ` (${r.reasons[0]})` : ''}`)
    .join('\n');
}
```
`src/cli/relais-agent.ts`:
```ts
#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage : relais-agent issue <ID> | search <texte> | kb search <mots> | ask <question>';

export async function runAgentCli(argv: string[], env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, out: (s: string) => void): Promise<number> {
  const api = env['RELAIS_API'];
  const token = env['RELAIS_RUN_TOKEN'];
  if (!api || !token) {
    out('relais-agent doit être lancé par Relais (RELAIS_API et RELAIS_RUN_TOKEN manquants).\n');
    return 2;
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const get = async (path: string) => {
    const res = await fetchImpl(`${api}${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'issue' && rest[0]) {
      const i = await get(`/issue/${encodeURIComponent(rest[0])}`);
      out(`${i.identifier} — ${i.title} (${i.stateName})\n${i.url}\n\n${i.description}\n`);
      return 0;
    }
    if (cmd === 'search' && rest.length) {
      const hits = (await get(`/search?q=${encodeURIComponent(rest.join(' '))}`)) as any[];
      out(hits.map((h) => `${h.identifier} — ${h.title} (${h.stateName}) ${h.url}`).join('\n') + '\n');
      return 0;
    }
    if (cmd === 'kb' && rest[0] === 'search' && rest.length > 1) {
      const hits = (await get(`/kb/search?q=${encodeURIComponent(rest.slice(1).join(' '))}`)) as any[];
      out((hits.length ? hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') : 'Aucun résultat.') + '\n');
      return 0;
    }
    if (cmd === 'ask' && rest.length) {
      const res = await fetchImpl(`${api}/ask`, { method: 'POST', headers, body: JSON.stringify({ text: rest.join(' ') }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out('Question posée dans Linear. Termine ton tour maintenant.\n');
      return 0;
    }
  } catch (err) {
    out(`relais-agent : ${(err as Error).message}\n`);
    return 1;
  }
  out(`${USAGE}\n`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runAgentCli(process.argv.slice(2), process.env, fetch, (s) => process.stdout.write(s)).then((code) => process.exit(code));
}
```
`src/cli/init.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Exec } from '../adapters/exec.js';
import { loadInstance, loadSecrets, saveInstance, saveSecrets } from '../config/instance.js';
import { slugify } from '../core/naming.js';

export interface InitIO {
  ask(q: string, def?: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  print(s: string): void;
}

export interface InitDeps {
  io: InitIO;
  home: string;
  cwd: string;
  createSmee: () => Promise<string>;
  exec: Exec;
}

function detectVerify(repo: string): string[] {
  const pkgFile = join(repo, 'package.json');
  if (!existsSync(pkgFile)) return [];
  const scripts = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  return ['lint', 'typecheck', 'test'].filter((s) => scripts[s]).map((s) => `npm ${s === 'test' ? 'test' : `run ${s}`}`);
}

export async function runInit(d: InitDeps): Promise<void> {
  const { io } = d;
  const top = await d.exec('git', ['rev-parse', '--show-toplevel'], { cwd: d.cwd });
  const repoPath = top.code === 0 ? top.stdout.trim() : await io.ask('Chemin du dépôt git à confier à Relais');
  const teamKey = (await io.ask('Clé de l’équipe Linear (ex. REL)')).toUpperCase();

  const cfg = loadInstance(d.home);
  const id = slugify(basename(repoPath), 30);
  cfg.projects = [...cfg.projects.filter((p) => p.repoPath !== repoPath), { id, repoPath, linearTeamKey: teamKey }];
  if (!cfg.publicUrl && cfg.relay.kind === 'none') cfg.relay = { kind: 'smee', url: await d.createSmee() };
  const webhookUrl = cfg.publicUrl ? `${cfg.publicUrl}/webhooks/linear` : cfg.relay.kind === 'smee' ? cfg.relay.url : '';
  const callbackUrl = `${cfg.publicUrl ?? `http://localhost:${cfg.port}`}/oauth/callback`;

  io.print(
    [
      '',
      '1. Dans Linear : Settings → API → OAuth applications → New application.',
      '   - Name : relais (c’est le nom qu’on mentionnera avec @)',
      `   - Callback URL : ${callbackUrl}`,
      '   - Cochez « Webhooks », URL :',
      `     ${webhookUrl}`,
      '   - Catégories : Agent session events, Issues, Comments',
      '2. Créez l’application, puis copiez ci-dessous le client ID, le client secret et le webhook signing secret.',
      '',
    ].join('\n'),
  );
  const clientId = await io.ask('Client ID');
  const clientSecret = await io.ask('Client secret');
  const webhookSecret = await io.ask('Webhook signing secret');
  const secrets = loadSecrets(d.home);
  const keepTokens = secrets.linear?.clientId === clientId ? secrets.linear : {};
  saveSecrets(d.home, { ...secrets, linear: { ...keepTokens, clientId, clientSecret, webhookSecret } });

  if (!cfg.knowledge && (await io.confirm('Créer un dépôt GitHub privé « relais-knowledge » pour la base de connaissance ?', true))) {
    const kbPath = join(d.home, 'knowledge');
    const created = await d.exec('gh', ['repo', 'create', 'relais-knowledge', '--private', '--add-readme', '--clone'], { cwd: d.home });
    if (created.code === 0) {
      mkdirSync(join(kbPath, 'notes'), { recursive: true });
      writeFileSync(join(kbPath, 'INDEX.md'), '# Base de connaissance Relais\n\n');
      writeFileSync(join(kbPath, 'notes/.gitkeep'), '');
      await d.exec('git', ['-C', kbPath, 'add', '.'], {});
      await d.exec('git', ['-C', kbPath, 'commit', '-m', 'init knowledge base'], {});
      await d.exec('git', ['-C', kbPath, 'push'], {});
      cfg.knowledge = { repoPath: kbPath };
    } else {
      io.print(`Création impossible : ${created.stderr.trim()}. Vous pourrez renseigner knowledge.repoPath dans ${join(d.home, 'config.yaml')}.`);
    }
  }

  const wfFile = join(repoPath, '.relais/workflow.yml');
  if (!existsSync(wfFile)) {
    const detected = detectVerify(repoPath);
    const verify = (await io.ask('Commandes de vérification après chaque run (séparées par ;)', detected.join('; ')))
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const setup = existsSync(join(repoPath, 'package-lock.json')) ? ['npm ci'] : [];
    mkdirSync(join(repoPath, '.relais'), { recursive: true });
    writeFileSync(
      wfFile,
      [
        'version: 1',
        'extends: standard',
        'tracker:',
        '  kind: linear',
        `  team: ${teamKey}`,
        'workspace:',
        `  setup: ${JSON.stringify(setup)}`,
        'jobs:',
        '  dev:',
        `    verify: ${JSON.stringify(verify)}`,
        '',
      ].join('\n'),
    );
  }

  saveInstance(d.home, cfg);
  io.print(
    [
      '',
      'Configuration écrite.',
      'Ensuite :',
      '  1. relais up',
      `  2. ouvrez http://localhost:${cfg.port} et cliquez « Connecter Linear » (installe l’agent dans votre espace)`,
      '  3. déléguez un ticket à @relais dans Linear',
      '',
    ].join('\n'),
  );
}
```

- [ ] **Step 6: Implement the `relais` CLI entry**

`src/cli/relais.ts`:
```ts
#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { execCmd } from '../adapters/exec.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { LinearApi } from '../adapters/tracker/linear/api.js';
import { TokenManager } from '../adapters/tracker/linear/oauth.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import { startRelais } from '../app/bootstrap.js';
import { repoRoot } from '../app/root.js';
import { homePaths, loadInstance, loadSecrets, relaisHome, saveSecrets } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { createSmeeChannel } from '../relay/smee.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from './init.js';
import { formatPlan, planRows } from './plan.js';

const USAGE = `Usage : relais <commande>
  init               configurer Relais pour le dépôt courant
  up [--fake-runner] démarrer Relais (interface sur http://localhost:4100)
  plan               voir quels tickets délégués seraient pris
  status             état de l'instance en cours
  pause | resume     suspendre ou reprendre la file
  stop <ID>          arrêter le run d'un ticket`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'fake-runner': { type: 'boolean' } } });
  const [cmd, arg] = positionals;
  const home = relaisHome();
  const cfg = loadInstance(home);
  const api = `http://127.0.0.1:${cfg.port}`;

  switch (cmd) {
    case 'init': {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await runInit({
        home,
        cwd: process.cwd(),
        exec: execCmd,
        createSmee: () => createSmeeChannel(),
        io: {
          ask: async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''} : `)).trim() || def || '',
          confirm: async (q, def = false) => {
            const a = (await rl.question(`${q} ${def ? '[O/n]' : '[o/N]'} : `)).trim().toLowerCase();
            return a ? a.startsWith('o') || a.startsWith('y') : def;
          },
          print: (s) => console.log(s),
        },
      });
      rl.close();
      return 0;
    }
    case 'up': {
      const app = await startRelais({ home, fakeRunner: values['fake-runner'] });
      console.log(`Relais tourne : ${app.url}  (Ctrl+C pour arrêter)`);
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      await app.stop();
      return 0;
    }
    case 'plan': {
      const linear = loadSecrets(home).linear;
      if (!linear?.accessToken || !linear.appUserId) {
        console.log('Linear non connecté : lancez `relais up` puis connectez Linear.');
        return 1;
      }
      const tm = new TokenManager({
        clientId: linear.clientId,
        clientSecret: linear.clientSecret,
        load: () => ({ accessToken: linear.accessToken!, refreshToken: linear.refreshToken, expiresAt: linear.expiresAt }),
        save: (t) => saveSecrets(home, { ...loadSecrets(home), linear: { ...linear, ...t } }),
      });
      const tracker = new LinearTracker(new LinearApi(() => tm.get()), linear.appUserId);
      const packDir = join(repoRoot(), 'packs/standard');
      const projects = cfg.projects.map((p) => {
        const f = join(p.repoPath, '.relais/workflow.yml');
        return { id: p.id, repoPath: p.repoPath, teamKey: p.linearTeamKey, workflow: loadWorkflow({ packDir, projectFile: existsSync(f) ? f : undefined }) };
      });
      const store = new SqliteStore(homePaths(home).db);
      console.log(formatPlan(await planRows({ tracker, store, projects, workspaces: new GitWorkspaces({ root: homePaths(home).workspaces }) })));
      store.close();
      return 0;
    }
    case 'status': {
      const s = (await (await fetch(`${api}/api/state`)).json()) as any;
      console.log(`Linear : ${s.linearConnected ? 'connecté' : 'non connecté'} · file : ${s.paused ? 'en pause' : 'active'} · places dev ${s.capacity.dev.used}/${s.capacity.dev.total} · coût du jour ${s.costTodayUsd.toFixed(2)} $`);
      for (const t of s.tickets) console.log(`  ${t.ticketId}  ${t.logical}${t.blocked ? ' (bloqué)' : ''}  ${t.title}`);
      return 0;
    }
    case 'pause':
    case 'resume':
      await fetch(`${api}/api/control/${cmd}`, { method: 'POST' });
      console.log(cmd === 'pause' ? 'File en pause.' : 'File relancée.');
      return 0;
    case 'stop': {
      if (!arg) break;
      const s = (await (await fetch(`${api}/api/state`)).json()) as any;
      const t = s.tickets.find((x: any) => x.ticketId === arg);
      if (!t) {
        console.log(`Ticket ${arg} inconnu de Relais.`);
        return 1;
      }
      await fetch(`${api}/api/tickets/${t.projectId}/${arg}/stop`, { method: 'POST' });
      console.log(`Arrêt demandé pour ${arg}.`);
      return 0;
    }
    default:
      break;
  }
  console.log(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/cli src/app` — Expected: PASS. Then a manual smoke check: `RELAIS_HOME=$(mktemp -d) ./bin/relais up --fake-runner` prints `Relais tourne : http://localhost:4100` and `curl -s localhost:4100/api/state` returns JSON; stop with Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add bin package.json src/app src/cli
git commit -m "feat(cli): add relais and relais-agent CLIs, init wizard, plan and bootstrap"
```

---

## M9 — Live UI

### Task 24: Web dashboard

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/src/types.ts`, `web/src/state.ts`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/main.tsx`, `web/src/styles.css`
- Modify: `package.json` (scripts `build`, `dev:web`, `typecheck`), `vitest.config.ts` (include `web/src/**/*.test.ts`)
- Test: `web/src/state.test.ts`

**Interfaces:**
- Consumes: HTTP API of Task 17 (`/api/state`, `/api/events`, `/api/runs/:id/transcript`, controls).
- Produces: a single page with header (places, file, coût du jour, Pause/Reprendre, « Connecter Linear » when not connected), tickets table, live run panel and event journal. `reducer(state, action)` in `web/src/state.ts`:
  ```ts
  type Action = { type: 'snapshot'; snapshot: Snapshot } | { type: 'bus'; message: BusMessage } | { type: 'select'; runId?: string } | { type: 'connection'; connected: boolean };
  ```
  Run lines kept per run: last 400; events kept: last 100; `log` messages with text `ping` ignored.

- [ ] **Step 1: Install UI dependencies and configure**

Run:
```bash
npm i react react-dom
npm i -D vite @vitejs/plugin-react @types/react @types/react-dom
```
`package.json` scripts become:
```json
"dev": "tsx src/cli/relais.ts",
"dev:web": "vite --config web/vite.config.ts",
"build": "tsc -p tsconfig.build.json && vite build --config web/vite.config.ts",
"test": "vitest run",
"typecheck": "tsc --noEmit && tsc --noEmit -p web",
"lint": "eslint ."
```
`vitest.config.ts` include: `['src/**/*.test.ts', 'test/**/*.test.ts', 'web/src/**/*.test.ts']`.
`web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4100', '/oauth': 'http://127.0.0.1:4100' } },
});
```
`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src"]
}
```
`web/index.html`:
```html
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relais</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing reducer test**

`web/src/state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { initialState, reducer } from './state.js';
import type { Snapshot, TicketView } from './types.js';

const ticket = (patch: Partial<TicketView> = {}): TicketView => ({
  projectId: 'p', ticketId: 'REL-1', title: 'Export', logical: 'dev', blocked: false, costUsd: 0, updatedAt: 1, ...patch,
});

const snapshot: Snapshot = {
  paused: false, linearConnected: true, tickets: [ticket()], queue: [], activeRuns: [{ id: 'r1', ticketId: 'REL-1', job: 'dev', startedAt: 1, turns: 0, costUsd: 0 }],
  costTodayUsd: 1.5, budgetUsd: 20, capacity: { dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } },
};

describe('reducer', () => {
  it('loads a snapshot and selects the active run', () => {
    const s = reducer(initialState, { type: 'snapshot', snapshot });
    expect(s.tickets['p/REL-1']!.title).toBe('Export');
    expect(s.selectedRun).toBe('r1');
  });

  it('applies ticket updates, run lines and events', () => {
    let s = reducer(initialState, { type: 'snapshot', snapshot });
    s = reducer(s, { type: 'bus', message: { kind: 'ticket', ticket: ticket({ logical: 'human_review' }) } });
    expect(s.tickets['p/REL-1']!.logical).toBe('human_review');
    s = reducer(s, { type: 'bus', message: { kind: 'run', runId: 'r1', ticketId: 'REL-1', ev: { kind: 'text', text: 'Bonjour' } } });
    expect(s.runLines['r1']).toEqual([{ kind: 'text', text: 'Bonjour' }]);
    s = reducer(s, { type: 'bus', message: { kind: 'event', event: { id: 'e1', type: 'ticket.moved', at: 5, projectId: 'p', ticketId: 'REL-1', payload: {} } } });
    expect(s.events[0]!.id).toBe('e1');
    s = reducer(s, { type: 'bus', message: { kind: 'log', level: 'info', message: 'ping', at: 1 } });
    expect(s.logs).toEqual([]);
  });

  it('caps run lines at 400', () => {
    let s = reducer(initialState, { type: 'snapshot', snapshot });
    for (let i = 0; i < 450; i++) s = reducer(s, { type: 'bus', message: { kind: 'run', runId: 'r1', ticketId: 'REL-1', ev: { kind: 'text', text: String(i) } } });
    expect(s.runLines['r1']).toHaveLength(400);
    expect(s.runLines['r1']![0]).toEqual({ kind: 'text', text: '50' });
  });
});
```
Run: `npx vitest run web/src/state.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement types and reducer**

`web/src/types.ts`:
```ts
export type Logical = 'todo' | 'dev' | 'human_review' | 'ai_review' | 'ready' | 'done';

export interface TicketView {
  projectId: string;
  ticketId: string;
  title: string;
  logical: Logical;
  blocked: boolean;
  blockReason?: string;
  activeRunId?: string;
  prUrl?: string;
  costUsd: number;
  updatedAt: number;
}

export interface RunView {
  id: string;
  ticketId: string;
  job: string;
  startedAt: number;
  turns: number;
  costUsd: number;
}

export interface QueueView {
  ticketId: string;
  job: string;
  queue: 'dev' | 'questions';
}

export interface Snapshot {
  paused: boolean;
  linearConnected: boolean;
  tickets: TicketView[];
  queue: QueueView[];
  activeRuns: RunView[];
  costTodayUsd: number;
  budgetUsd: number | null;
  capacity: { dev: { used: number; total: number }; questions: { used: number; total: number } };
}

export type RunLine =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'tool_result'; isError: boolean }
  | { kind: 'result'; isError: boolean; costUsd: number; turns: number; text: string };

export interface EventView {
  id: string;
  type: string;
  at: number;
  projectId: string;
  ticketId?: string;
  payload: unknown;
}

export type BusMessage =
  | { kind: 'event'; event: EventView }
  | { kind: 'command'; projectId: string; ticketId?: string; command: { kind: string } }
  | { kind: 'run'; runId: string; ticketId: string; ev: RunLine }
  | { kind: 'ticket'; ticket: TicketView }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };
```
`web/src/state.ts`:
```ts
import type { BusMessage, EventView, RunLine, Snapshot, TicketView } from './types.js';

export interface UiState {
  connected: boolean;
  snapshot?: Snapshot;
  tickets: Record<string, TicketView>;
  runLines: Record<string, RunLine[]>;
  events: EventView[];
  logs: { level: string; message: string; at: number }[];
  selectedRun?: string;
}

export type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'bus'; message: BusMessage }
  | { type: 'select'; runId?: string }
  | { type: 'connection'; connected: boolean };

export const initialState: UiState = { connected: false, tickets: {}, runLines: {}, events: [], logs: [] };

const key = (t: TicketView) => `${t.projectId}/${t.ticketId}`;

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case 'snapshot':
      return {
        ...s,
        snapshot: a.snapshot,
        tickets: Object.fromEntries(a.snapshot.tickets.map((t) => [key(t), t])),
        selectedRun: s.selectedRun ?? a.snapshot.activeRuns[0]?.id,
      };
    case 'select':
      return { ...s, selectedRun: a.runId };
    case 'connection':
      return { ...s, connected: a.connected };
    case 'bus': {
      const m = a.message;
      if (m.kind === 'ticket') return { ...s, tickets: { ...s.tickets, [key(m.ticket)]: m.ticket } };
      if (m.kind === 'run') {
        const lines = [...(s.runLines[m.runId] ?? []), m.ev].slice(-400);
        return { ...s, runLines: { ...s.runLines, [m.runId]: lines }, selectedRun: s.selectedRun ?? m.runId };
      }
      if (m.kind === 'event') return { ...s, events: [m.event, ...s.events].slice(0, 100) };
      if (m.kind === 'log' && m.message !== 'ping') return { ...s, logs: [{ level: m.level, message: m.message, at: m.at }, ...s.logs].slice(0, 50) };
      return s;
    }
  }
}
```

- [ ] **Step 4: Implement api.ts, App.tsx, main.tsx and styles**

`web/src/api.ts`:
```ts
import type { BusMessage, Snapshot } from './types.js';

export async function fetchSnapshot(): Promise<Snapshot> {
  return (await fetch('/api/state')).json();
}

export const post = (path: string) => fetch(path, { method: 'POST' });

export function subscribe(onMessage: (m: BusMessage) => void, onConnection: (c: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  for (const kind of ['event', 'command', 'run', 'ticket', 'log']) {
    es.addEventListener(kind, (e) => onMessage(JSON.parse((e as MessageEvent).data) as BusMessage));
  }
  es.onopen = () => onConnection(true);
  es.onerror = () => onConnection(false);
  return () => es.close();
}
```
`web/src/App.tsx`:
```tsx
import { useEffect, useReducer } from 'react';
import { fetchSnapshot, post, subscribe } from './api.js';
import { initialState, reducer } from './state.js';
import type { RunLine, TicketView } from './types.js';

const LABELS: Record<TicketView['logical'], string> = {
  todo: 'Todo', dev: 'En cours', human_review: 'Review humaine', ai_review: 'Review IA', ready: 'Prêt à merger', done: 'Terminé',
};
const WAITING_HUMAN = new Set(['human_review', 'ready']);

function Line({ line }: { line: RunLine }) {
  switch (line.kind) {
    case 'text':
      return <p className="line text">{line.text}</p>;
    case 'tool':
      return <p className="line tool"><span>{line.name}</span> {line.input}</p>;
    case 'tool_result':
      return line.isError ? <p className="line err">outil en erreur</p> : null;
    case 'result':
      return <p className="line result">{line.isError ? 'Échec' : 'Terminé'} · {line.turns} tours · {line.costUsd.toFixed(2)} $</p>;
    default:
      return null;
  }
}

export function App() {
  const [s, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const load = () => fetchSnapshot().then((snapshot) => dispatch({ type: 'snapshot', snapshot })).catch(() => undefined);
    void load();
    const timer = setInterval(load, 10_000);
    const off = subscribe((message) => dispatch({ type: 'bus', message }), (connected) => dispatch({ type: 'connection', connected }));
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  const snap = s.snapshot;
  const tickets = Object.values(s.tickets).sort((a, b) => b.updatedAt - a.updatedAt);
  const lines = s.selectedRun ? (s.runLines[s.selectedRun] ?? []) : [];

  return (
    <div className="page">
      <header>
        <h1>Relais</h1>
        {snap && (
          <div className="stats">
            <span>Places {snap.capacity.dev.used}/{snap.capacity.dev.total}</span>
            <span>Questions {snap.capacity.questions.used}/{snap.capacity.questions.total}</span>
            <span>File {snap.queue.length}</span>
            <span>Coût du jour {snap.costTodayUsd.toFixed(2)} ${snap.budgetUsd ? ` / ${snap.budgetUsd} $` : ''}</span>
            <span className={s.connected ? 'live on' : 'live'}>{s.connected ? 'en direct' : 'déconnecté'}</span>
            {!snap.linearConnected && <a className="button primary" href="/oauth/start">Connecter Linear</a>}
            <button onClick={() => post(snap.paused ? '/api/control/resume' : '/api/control/pause')}>{snap.paused ? 'Reprendre' : 'Pause'}</button>
          </div>
        )}
      </header>
      <main>
        <section className="tickets">
          <h2>Tickets</h2>
          <table>
            <thead>
              <tr><th>Ticket</th><th>État</th><th>Attend</th><th>Coût</th><th></th></tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={`${t.projectId}/${t.ticketId}`} className={t.activeRunId === s.selectedRun ? 'selected' : ''}>
                  <td>
                    <button className="link" onClick={() => dispatch({ type: 'select', runId: t.activeRunId })}>{t.ticketId}</button> {t.title}
                  </td>
                  <td>
                    <span className={`pill ${t.logical}`}>{LABELS[t.logical]}</span>
                    {t.blocked && <span className="pill blocked" title={t.blockReason}>bloqué</span>}
                  </td>
                  <td>{t.blocked || WAITING_HUMAN.has(t.logical) ? 'vous' : t.activeRunId ? "l'agent" : '—'}</td>
                  <td className="num">{t.costUsd.toFixed(2)} $</td>
                  <td>
                    {t.prUrl && <a href={t.prUrl} target="_blank" rel="noreferrer">PR</a>}{' '}
                    {t.activeRunId && <button onClick={() => post(`/api/tickets/${t.projectId}/${t.ticketId}/stop`)}>Stop</button>}
                  </td>
                </tr>
              ))}
              {!tickets.length && (
                <tr><td colSpan={5} className="empty">Aucun ticket. Déléguez un ticket à l’agent dans Linear.</td></tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="run">
          <h2>Session en direct {s.selectedRun ? `· ${s.selectedRun.slice(0, 8)}` : ''}</h2>
          <div className="lines">
            {lines.length ? lines.map((l, i) => <Line key={i} line={l} />) : <p className="empty">Choisissez un ticket en cours.</p>}
          </div>
        </section>
        <section className="journal">
          <h2>Journal</h2>
          <ul>
            {s.logs.slice(0, 5).map((l, i) => (
              <li key={`log-${i}`} className={`log ${l.level}`}>{new Date(l.at).toLocaleTimeString('fr-FR')} {l.message}</li>
            ))}
            {s.events.map((e) => (
              <li key={e.id}>{new Date(e.at).toLocaleTimeString('fr-FR')} <strong>{e.type}</strong> {e.ticketId ?? ''}</li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
```
`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
`web/src/styles.css`:
```css
:root { --bg: #f5f7f6; --surface: #fff; --fg: #16211e; --muted: #5a6964; --line: #d3dcd9; --agent: #0d7a6c; --human: #b86a0b; --danger: #b4322c; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1614; --surface: #16201d; --fg: #e3ebe8; --muted: #97a8a2; --line: #2c3a36; --agent: #4cc2ae; --human: #e8a54a; --danger: #ec7a72; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
.page { max-width: 1280px; margin: 0 auto; padding: 16px; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
h1 { margin: 0; font-size: 22px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
.stats { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.live { color: var(--danger); } .live.on { color: var(--agent); }
main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; margin-top: 16px; }
.journal { grid-column: 1 / -1; }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr.selected { background: color-mix(in srgb, var(--agent) 10%, transparent); }
.num { font-variant-numeric: tabular-nums; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; margin-right: 4px; }
.pill.dev, .pill.ai_review { color: var(--agent); border-color: var(--agent); }
.pill.human_review, .pill.ready { color: var(--human); border-color: var(--human); }
.pill.blocked { color: var(--danger); border-color: var(--danger); }
button, .button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; text-decoration: none; }
.button.primary { background: var(--agent); color: var(--surface); border-color: var(--agent); }
button.link { border: 0; padding: 0; color: var(--agent); background: none; font-weight: 600; }
.lines { max-height: 60vh; overflow: auto; font-family: ui-monospace, monospace; font-size: 12px; }
.line { margin: 0 0 6px; white-space: pre-wrap; }
.line.tool span { color: var(--agent); font-weight: 600; }
.line.err { color: var(--danger); }
.line.result { color: var(--muted); border-top: 1px dashed var(--line); padding-top: 4px; }
.journal ul { list-style: none; margin: 0; padding: 0; max-height: 30vh; overflow: auto; font-size: 12px; }
.log.error { color: var(--danger); } .log.warn { color: var(--human); }
.empty { color: var(--muted); }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
```

- [ ] **Step 5: Run the test and build the UI once**

Run: `npx vitest run web/src/state.test.ts && npx vite build --config web/vite.config.ts` — Expected: PASS and `web/dist/index.html` produced. Manual check: `RELAIS_HOME=$(mktemp -d) ./bin/relais up --fake-runner` then open `http://localhost:4100`: header, empty ticket table, « Connecter Linear » button.

- [ ] **Step 6: Commit**

```bash
git add web package.json package-lock.json vitest.config.ts
git commit -m "feat(ui): add live dashboard with tickets, session stream and journal"
```

---

## M10 — Knowledge base

### Task 25: Knowledge repository wiring

**Files:**
- Create: `src/knowledge/kb.ts`
- Modify: `src/app/bootstrap.ts` (knowledge search + pull before runs)
- Test: `src/knowledge/kb.test.ts`

**Interfaces:**
- Consumes: `Exec`, `mustExec` (Task 19), `ServerDeps.knowledgeSearch` (Task 17), `OrchestratorDeps.beforeRun` (Task 11)
- Produces:
  ```ts
  interface KbHit { file: string; line: number; text: string }
  class KnowledgeBase {
    constructor(repoPath: string, exec?: Exec)
    pull(): Promise<void>                       // fetch + fast-forward the checkout of the default branch; no-op without a remote
    readIndex(maxChars?: number): string        // INDEX.md, '' if missing
    search(query: string, limit?: number): Promise<KbHit[]>   // over notes/*.md, terms >= 3 chars, case/accent-insensitive, ranked by matched terms
  }
  ```

- [ ] **Step 1: Write the failing test**

`src/knowledge/kb.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeBase } from './kb.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function kbRepo() {
  const base = mkdtempSync(join(tmpdir(), 'relais-kbt-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '--bare', '-b', 'main', origin);
  const repo = join(base, 'kb');
  git(base, 'clone', origin, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'INDEX.md'), '- [Scores](notes/scores.md) — agrégats côté serveur\n');
  writeFileSync(join(repo, 'notes/scores.md'), '---\ntitle: Scores\n---\nLes agrégats de scores se calculent côté serveur.\nVoir getScoreHistory.\n');
  writeFileSync(join(repo, 'notes/ci.md'), '---\ntitle: CI\n---\nLa CI e2e a besoin d’une PR non brouillon.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return { base, origin, repo };
}

describe('KnowledgeBase', () => {
  it('reads the index and searches notes', async () => {
    const { repo } = kbRepo();
    const kb = new KnowledgeBase(repo);
    expect(kb.readIndex()).toContain('agrégats côté serveur');
    expect(kb.readIndex(5)).toHaveLength(5);
    const hits = await kb.search('agregats serveur');
    expect(hits[0]).toEqual({ file: 'notes/scores.md', line: 4, text: 'Les agrégats de scores se calculent côté serveur.' });
    expect(await kb.search('xyzzy')).toEqual([]);
  });

  it('pulls merged knowledge', async () => {
    const { base, origin, repo } = kbRepo();
    const other = join(base, 'other');
    git(base, 'clone', origin, other);
    git(other, 'config', 'user.email', 't@t');
    git(other, 'config', 'user.name', 't');
    writeFileSync(join(other, 'notes/new.md'), '---\ntitle: New\n---\nFait tout neuf sur les webhooks.\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'add');
    git(other, 'push');
    const kb = new KnowledgeBase(repo);
    await kb.pull();
    expect((await kb.search('webhooks'))[0]!.file).toBe('notes/new.md');
  });
});
```
Run: `npx vitest run src/knowledge/kb.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/knowledge/kb.ts`:
```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';

export interface KbHit {
  file: string;
  line: number;
  text: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class KnowledgeBase {
  constructor(
    private repoPath: string,
    private exec: Exec = execCmd,
  ) {}

  async pull(): Promise<void> {
    const remotes = await this.exec('git', ['-C', this.repoPath, 'remote']);
    if (!remotes.stdout.trim()) return;
    await mustExec(this.exec, 'git', ['-C', this.repoPath, 'fetch', 'origin']);
    const head = await this.exec('git', ['-C', this.repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const trunk = head.code === 0 ? head.stdout.trim() : 'origin/main';
    await mustExec(this.exec, 'git', ['-C', this.repoPath, 'merge', '--ff-only', trunk]);
  }

  readIndex(maxChars = 8000): string {
    const f = join(this.repoPath, 'INDEX.md');
    return existsSync(f) ? readFileSync(f, 'utf8').slice(0, maxChars) : '';
  }

  async search(query: string, limit = 20): Promise<KbHit[]> {
    const terms = norm(query).split(/\s+/).filter((t) => t.length >= 3);
    const dir = join(this.repoPath, 'notes');
    if (!terms.length || !existsSync(dir)) return [];
    const hits: (KbHit & { score: number })[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const lines = readFileSync(join(dir, name), 'utf8').split('\n');
      lines.forEach((text, i) => {
        const n = norm(text);
        const score = terms.filter((t) => n.includes(t)).length;
        if (score > 0) hits.push({ file: `notes/${name}`, line: i + 1, text, score });
      });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line)
      .slice(0, limit)
      .map(({ score: _s, ...h }) => h);
  }
}
```

- [ ] **Step 3: Wire it in bootstrap**

In `src/app/bootstrap.ts`:
- add `import { KnowledgeBase } from '../knowledge/kb.js';`
- after `const forge = new GhCliForge();` add:
```ts
  const kb = instance.knowledge ? new KnowledgeBase(instance.knowledge.repoPath) : undefined;
```
- in the `new Orchestrator({ ... })` options add:
```ts
    beforeRun: async () => {
      if (kb) await kb.pull();
    },
```
- in the `createApp({ ... })` options add:
```ts
    knowledgeSearch: kb ? (q) => kb.search(q) : undefined,
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/knowledge/kb.test.ts src/app/bootstrap.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge src/app/bootstrap.ts, src/app/root.ts, src/app/tracker-switch.ts
git commit -m "feat(knowledge): add shared knowledge base search and pull before runs"
```

---

## M11 — Deployment and acceptance

### Task 26: Docker, README quickstart and acceptance checklist

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`, `docs/recette.md`
- Modify: `README.md`, `docs/superpowers/specs/2026-10-10-relais-mvp-design.md` (align the spec with decisions made in the plan)

**Interfaces:**
- Produces: a container that runs `relais up` with `RELAIS_HOME=/data`, and the manual acceptance procedure mapping to spec §1 criteria 1–8.

- [ ] **Step 1: Write Docker files**

`.dockerignore`:
```
node_modules
dist
web/dist
.git
data
repos
```
`Dockerfile`:
```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg bash \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV RELAIS_HOME=/data NODE_ENV=production
EXPOSE 4100
CMD ["node", "dist/src/cli/relais.js", "up"]
```
`compose.yaml`:
```yaml
services:
  relais:
    build: .
    ports: ["4100:4100"]
    volumes:
      - ./data:/data
      - ./repos:/repos
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GH_TOKEN: ${GH_TOKEN}
    restart: unless-stopped
```
In the container `config.yaml` must use `host: 0.0.0.0`, `publicUrl: https://<domaine>`, `relay: { kind: none }`, and project `repoPath` under `/repos`.

- [ ] **Step 2: Write `docs/recette.md`**

````markdown
# Recette Relais (Linear de test)

Prérequis : Node 24, `gh` connecté, `claude` connecté, un espace Linear de test dont vous êtes admin, un petit dépôt GitHub avec des tests.

## 0. Installation
```bash
git clone git@github.com:lilianperthuis/relais.git && cd relais
npm ci && npm run build && npm link
```

## 1. init (critère 1, < 15 min)
Dans le dépôt de test : `relais init`. Suivre les instructions (app OAuth Linear, webhook = URL smee affichée, catégories Agent session events + Issues + Comments). Vérifier `~/.relais/config.yaml`, `~/.relais/secrets.json` (mode 600), `.relais/workflow.yml`.

## 2. up et connexion (critère 2)
`relais up`, ouvrir http://localhost:4100, cliquer « Connecter Linear ». Attendu : page « Linear est connecté », statuts Human Review / AI Review / Ready to Merge et labels agent:* créés dans l'équipe, bouton remplacé par l'état « en direct ».
Si Linear refuse l'URL de callback localhost : noter l'erreur, utiliser `cloudflared tunnel --url http://localhost:4100` le temps de l'installation et mettre l'URL publique dans `publicUrl`.

## 3. Délégation (critère 3)
Créer un ticket clair (≥ 30 caractères de description), le déléguer à @relais. Attendu en < 10 s : « Pris en compte. » dans la session. Puis : statut In Progress, sortie en direct dans l'interface, PR ouverte, statut Human Review, résumé en français dans la session.
Vérifier dans `~/.relais/relais.db` qu'aucun événement n'a été rejeté pour signature (sinon : le relais smee modifie le corps → passer en `publicUrl` via tunnel).

## 4. Retours groupés (critère 4)
Écrire deux remarques dans le fil à moins d'une minute d'écart. Attendu : une seule reprise 3 minutes après la dernière, même session Claude (même id dans l'interface), réponse avec le commit.

## 5. Review IA puis merge (critère 5)
Passer le ticket en AI Review. Attendu : session neuve, synthèse, statut Ready to Merge. Merger la PR sur GitHub. Attendu en < 1 min : statut Done, worktree supprimé de `~/.relais/workspaces`, run learn lancé.

## 6. Questions et mémoire (critère 6)
Sur un autre ticket : `@relais où est géré X ?` → réponse en lecture seule. `@relais retiens <fait>` → PR dans relais-knowledge. La merger, puis poser une question liée : la réponse cite la fiche.

## 7. Stop (critère 7)
Déléguer un ticket, pendant le run cliquer « Send stop request » dans Linear. Attendu en < 10 s : « Arrêté… », ticket bloqué, run `stopped`.

## 8. Docker (critère 8)
`docker compose up --build` sur une machine Linux avec `data/config.yaml` adapté. Attendu : interface sur le port 4100, même comportement que 3.

## Vérifications live optionnelles
- `LINEAR_API_KEY=<clé perso> npx vitest run src/adapters/tracker/linear/queries.live.test.ts` : toutes les requêtes valident contre le schéma Linear.
- `RELAIS_E2E=1 npx vitest run test/e2e/pack.e2e.test.ts` : le pack charge le hook et refuse `gh pr merge`.
````

- [ ] **Step 3: Update README and spec**

Replace `README.md` with a quickstart:
````markdown
# Relais

Orchestrateur d'agents de code : un ticket Linear délégué à l'agent devient une PR, relue par un humain puis par une boucle de review IA, prête à merger. Prototype privé.

## Démarrage
```bash
npm ci && npm run build && npm link
cd <votre dépôt> && relais init
relais up            # http://localhost:4100, puis « Connecter Linear »
```
Sans tokens, pour tester l'interface : `relais up --fake-runner`.

## Documents
- Spec : `docs/superpowers/specs/2026-10-10-relais-mvp-design.md`
- Plan : `docs/superpowers/plans/2026-10-10-relais-mvp.md`
- Recette : `docs/recette.md`

## Développement
`npm test` · `npm run typecheck` · `npm run lint` · `npm run dev:web` (UI avec proxy vers :4100)
````
In the spec, make these edits so it matches what was built:
- §5.1: replace `limits.perDay.usd` with `limits.perDayUsd`, add `host` (default `127.0.0.1`).
- §7.4: replace ``labels: { add: [], remove: [] }`` with ``labels: { add, remove }`` (action) and state that `label` is only the `label.added` filter; remove the sentence about `run: [a, b]` chains (not in the MVP).
- §12: add `--setting-sources project,local` to the list in the first paragraph if missing.

- [ ] **Step 4: Verify the image builds (only if Docker is available)**

Run: `docker build -t relais:dev .` — Expected: success. If Docker is not installed, say so in the commit message body and skip.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore compose.yaml docs/recette.md README.md docs/superpowers/specs/2026-10-10-relais-mvp-design.md
git commit -m "docs: add Docker deployment, quickstart and acceptance checklist"
```

---

## Self-review checklist (done while writing this plan)

- Spec coverage: §1 criteria 1–8 → Tasks 23 (init/up), 12 (scenarios 3–7), 25 (knowledge), 26 (Docker, recette). §2 principles → 5 (pure decide), 6/11 (idempotence, store), 21 (no `--bare`), 10 (verify outside agent), 7/11 (caps), 17 (token never leaves daemon). §6 events → 2, 14, 20. §7 engine → 5, 7, 11. §8 default workflow → 4. §9 Linear → 13–15. §10 GitHub → 20. §11 workspaces → 19. §12 runner → 21. §13 pack → 22. §14 knowledge → 22 (hook), 25, 19 (knowledge worktree). §15 API → 17, 23. §16 UI → 24. §17 CLI → 23. §18 security → 16, 17, 22. §19 deployment → 26. §20 tests → each task + 12. §21 risks → 13 (live schema test), 26 (recette).
- Names used across tasks: `decide`, `Orchestrator.submit/idle/recover/stopAll/isPaused/project`, `Scheduler.tryAcquire/release/inUse/hasFree/enqueue/next`, `Store.*` (incl. `deleteTimersFor`), `TrackerIssue`, `ActivityInput`, `RunStreamEvent`, `RunRequest`, `WorkspaceRequest`, `logicalFromName` — checked for consistency.
