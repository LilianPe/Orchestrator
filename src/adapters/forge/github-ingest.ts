import type { FactoryEvent } from '../../core/types.js';
import { mapGithubWebhook, verifyGithubSignature, type GithubMapContext } from './github-webhook.js';

export interface GithubIngestDeps {
  /** `github.webhookSecret` of config.yaml, or `GH_WEBHOOK_SECRET`; empty refuses every webhook. */
  secret: () => string;
  ctx: GithubMapContext;
  /** Writes an event to the inbox (ORC-147); resolves once committed, `false` for an id already there. */
  accept: (e: FactoryEvent) => Promise<boolean>;
  log: (m: string) => void;
}

/**
 * The GitHub webhook (ORC-134), as the Linear one (ORC-147): the answer comes only once its events are
 * in the inbox. 401 for a body not signed with the secret, and nothing is written; 200 means written
 * (or already there: a redelivery is a duplicate by event id); 500 means nothing may have been written.
 */
export function createGithubIngest(d: GithubIngestDeps) {
  // One webhook at a time, in arrival order: the mapping reads the store, and a later webhook of the
  // same ticket must not reach the inbox first.
  let tail: Promise<unknown> = Promise.resolve();
  return async (raw: string, headers: Record<string, string | undefined>): Promise<{ status: number }> => {
    if (!verifyGithubSignature(raw, headers['x-hub-signature-256'], d.secret())) return { status: 401 };
    const name = headers['x-github-event'];
    if (!name) return { status: 400 };
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400 };
    }
    const turn = tail.then(async () => {
      for (const e of await mapGithubWebhook(name, body, d.ctx)) await d.accept(e);
    });
    tail = turn.catch(() => undefined);
    try {
      await turn;
    } catch (err) {
      d.log(`github webhook ${headers['x-github-delivery'] ?? '?'} (${name}) not written to the inbox: ${(err as Error).message}`);
      return { status: 500 };
    }
    return { status: 200 };
  };
}
