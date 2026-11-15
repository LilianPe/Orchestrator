/** A repository secret's reference in `factory.yml` (ORC-308): written `<source>:<path>`, `env` or a source under `secret_sources`. */
export interface SecretRef {
  source: string;
  path: string;
}

export const refText = (ref: SecretRef): string => `${ref.source}:${ref.path}`;

/** Where the daemon reads a repository's secrets, at each `setup` (ORC-308). Docs: docs/ports/secret-source.md. */
export interface SecretSource {
  /** The value at `path`. Rejects when the source does not hold it or is out of service; its error never carries a value. */
  read(path: string): Promise<string>;
}

/** An adapter, as `secret_sources.<name>.kind` names it: registered in `registry.ts`. */
export interface SecretSourceKind {
  /** Why `path` is not one of its paths, checked at startup without reading anything; undefined when it is. */
  checkPath(path: string): string | undefined;
  /** The faults of a declaration's options (every key but `kind`), each prefixed by its key. */
  checkOptions(options: Record<string, unknown>): string[];
  /** The source of a declaration whose options passed `checkOptions`. */
  create(options: Record<string, unknown>, env: NodeJS.ProcessEnv): SecretSource;
}
