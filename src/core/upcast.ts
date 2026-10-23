import { SCHEMA_VERSION, type FactoryEvent, type Taint } from './types.js';

/** An event as it may sit in the journal, whatever factory version wrote it. */
export interface StoredEvent {
  id: string;
  type: string;
  at: number;
  projectId: string;
  ticketId?: string;
  schemaVersion?: number;
  taint?: Taint;
  payload: unknown;
}

const RENAMED_V1: Record<string, string> = { 'ticket.moved': 'status.changed', 'label.added': 'label.changed' };

/** Upcaster from version N to N + 1, indexed by N. A row without a version is version 1. */
const UPCASTERS: Record<number, (e: StoredEvent) => StoredEvent> = {
  1: (e) => ({
    ...e,
    type: RENAMED_V1[e.type] ?? e.type,
    payload: e.type === 'label.added' ? { ...(e.payload as object), change: 'added' } : e.payload,
    schemaVersion: 2,
    // Version 1 had no taint and the factory trusted every event: replaying it must give the same decisions.
    // A row that does carry a taint keeps it: an unversioned producer must not launder an untrusted event.
    taint: e.taint ?? 'trusted',
  }),
};

export function upcast(stored: StoredEvent): FactoryEvent {
  let e = stored;
  let version = e.schemaVersion ?? 1;
  if (version > SCHEMA_VERSION) throw new Error(`event ${e.id}: schema version ${version} is newer than ${SCHEMA_VERSION}`);
  while (version < SCHEMA_VERSION) {
    const up = UPCASTERS[version];
    if (!up) throw new Error(`event ${e.id}: no upcaster from schema version ${version}`);
    e = up(e);
    version += 1;
  }
  return e as FactoryEvent;
}
