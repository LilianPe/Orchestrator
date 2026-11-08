import type { RunStreamEvent } from '../runner/types.js';
import type { ActivityInput } from './types.js';

/**
 * What the live feed says of a tool, in the factory's words (ORC-214): a closed table, never the tool's parameters (a command,
 * a path, a search, which the agent writes) nor the name of a tool outside it.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: 'Running a command',
  Read: 'Reading the code',
  Grep: 'Searching the code',
  Glob: 'Searching the code',
  LS: 'Reading the code',
  Edit: 'Editing files',
  MultiEdit: 'Editing files',
  Write: 'Editing files',
  NotebookEdit: 'Editing files',
  Skill: 'Following a method skill',
  Task: 'Working with a subagent',
  Agent: 'Working with a subagent',
  TodoWrite: 'Updating its plan',
  WebFetch: 'Reading the web',
  WebSearch: 'Reading the web',
  mcp__factory__submit_result: 'Submitting its result',
  mcp__factory__ask: 'Asking a question',
};
const OTHER_TOOL = 'Using a tool';

/**
 * The agent's thoughts are not relayed: what it says of its work reaches Linear only through what the factory composes of its result.
 * The dashboard's live feed of a run shows the same (ORC-301).
 */
export function composedActivity(ev: RunStreamEvent, step: string): ActivityInput | undefined {
  if (ev.kind !== 'tool') return undefined;
  return { type: 'action', action: TOOL_LABELS[ev.name] ?? OTHER_TOOL, parameter: `step ${step}`, ephemeral: true };
}

/** The live feed of a run in its Linear session: at most one composed activity (what the agent does, at which step) per interval, the latest. */
export class ActivityRelay {
  private last = Number.NEGATIVE_INFINITY;
  private pending: ActivityInput | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private send: (a: ActivityInput) => Promise<void>,
    private step: string,
    private intervalMs = 2000,
    private now: () => number = Date.now,
  ) {}

  push(ev: RunStreamEvent): void {
    const a = composedActivity(ev, this.step);
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
