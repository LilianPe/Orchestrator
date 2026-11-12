import { refText, type SecretRef, type SecretSource } from './types.js';

/** Sealing purges the files that hold a secret: a value this short would be found in many that do not. */
export const MIN_REPO_SECRET_LENGTH = 8;

/**
 * Reads a repository's secrets at its `setup` (ORC-308), from the sources `factory.yml` opens. Its errors name the secret
 * and its reference, never a value. It keeps what it read, which the daemon masks as its own secrets.
 */
export class SecretReader {
  private readonly seen = new Set<string>();

  constructor(private readonly sources: Readonly<Record<string, SecretSource>>) {}

  async read(refs: Readonly<Record<string, SecretRef>>): Promise<Record<string, string>> {
    const entries = await Promise.all(Object.entries(refs).map(async ([name, ref]) => [name, await this.one(name, ref)] as const));
    return Object.fromEntries(entries);
  }

  /** Every value read so far, a rotated one included. */
  values(): string[] {
    return [...this.seen];
  }

  private async one(name: string, ref: SecretRef): Promise<string> {
    const at = `the secret ${name} (${refText(ref)})`;
    const source = this.sources[ref.source];
    let value: string;
    try {
      if (!source) throw new Error(`no source ${ref.source}`);
      value = await source.read(ref.path);
    } catch (err) {
      throw new Error(`${at} could not be read: ${(err as Error).message}`, { cause: err });
    }
    if (value.length < MIN_REPO_SECRET_LENGTH) throw new Error(`${at}: at least ${MIN_REPO_SECRET_LENGTH} characters expected`);
    this.seen.add(value);
    return value;
  }
}
