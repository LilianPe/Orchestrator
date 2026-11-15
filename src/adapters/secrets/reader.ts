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

  /** `minLength`: a repository's secret is sealed in its files, hence its minimum; a server secret is never sealed (ORC-398). */
  async read(refs: Readonly<Record<string, SecretRef>>, minLength = MIN_REPO_SECRET_LENGTH): Promise<Record<string, string>> {
    const entries = await Promise.all(Object.entries(refs).map(async ([name, ref]) => [name, await this.one(name, ref, minLength)] as const));
    return Object.fromEntries(entries);
  }

  /** Every value read so far, a rotated one included. */
  values(): string[] {
    return [...this.seen];
  }

  private async one(name: string, ref: SecretRef, minLength: number): Promise<string> {
    const at = `the secret ${name} (${refText(ref)})`;
    const source = Object.hasOwn(this.sources, ref.source) ? this.sources[ref.source] : undefined;
    if (!source) throw new Error(`${at} could not be read: no source ${ref.source}`);
    let value: unknown;
    try {
      value = await source.read(ref.path);
    } catch (err) {
      throw new Error(`${at} could not be read: ${err instanceof Error ? err.message : 'the source failed'}`, { cause: err });
    }
    if (typeof value !== 'string') throw new Error(`${at} could not be read: the source answered no text`);
    if (value.length < minLength) throw new Error(`${at}: at least ${minLength} characters expected`);
    this.seen.add(value);
    return value;
  }
}
