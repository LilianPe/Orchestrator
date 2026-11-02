import type { Store } from '../../../store/types.js';

/**
 * The labels of a ticket as the factory last read them in Linear (ORC-185): by the reconciliation, or by
 * an issue webhook once its events are in the inbox, the factory's own echoes included. A label change
 * is reported only when it differs from them, whichever source sees it first, so a rule under
 * `label.changed` is not run twice for one change. `at` is the issue's `updatedAt` in Linear when read:
 * a reading older than the one kept (a pass that read Linear before a webhook came, a webhook out of
 * order) never replaces it.
 */
export interface KnownLabels {
  labels: string[];
  at: number;
}

const key = (projectId: string, ticketId: string) => `linear-labels:${projectId}:${ticketId}`;

export async function knownLabels(store: Pick<Store, 'getMeta'>, projectId: string, ticketId: string): Promise<KnownLabels | undefined> {
  const raw = await store.getMeta(key(projectId, ticketId));
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<KnownLabels>;
    return Array.isArray(v.labels) && v.labels.every((l) => typeof l === 'string') && typeof v.at === 'number' ? { labels: v.labels, at: v.at } : undefined;
  } catch {
    return undefined;
  }
}

export async function recordLabels(store: Pick<Store, 'getMeta' | 'setMeta'>, projectId: string, ticketId: string, labels: readonly string[], at: number): Promise<void> {
  const kept = await knownLabels(store, projectId, ticketId);
  const sorted = [...new Set(labels)].sort();
  if (kept && (kept.at > at || (kept.at === at && kept.labels.join('\n') === sorted.join('\n')))) return;
  await store.setMeta(key(projectId, ticketId), JSON.stringify({ labels: sorted, at }));
}

/** What `known` lacks or has too, as label changes: what a webhook would have reported. */
export function labelChanges(known: readonly string[], now: readonly string[]): { label: string; change: 'added' | 'removed' }[] {
  return [
    ...now.filter((l) => !known.includes(l)).map((label) => ({ label, change: 'added' as const })),
    ...known.filter((l) => !now.includes(l)).map((label) => ({ label, change: 'removed' as const })),
  ];
}

/** Runs its tasks one at a time, in call order; a failed one does not stop the next. */
export type Serial = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * One turn for the webhook and the reconciliation around the known labels (ORC-185): each reads the
 * reading, writes its events and records the new reading before the other reads it, so one change is
 * not reported by both.
 */
export function serial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
