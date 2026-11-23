/** A repository secret's reference in `factory.yml` (ORC-308): written `<source>:<path>`, `env` or a source under `secret_sources`. */
export interface SecretRef {
  source: string;
  path: string;
}

export const refText = (ref: SecretRef): string => `${ref.source}:${ref.path}`;

/** What a source knows of a secret besides its value (ORC-398). */
export interface SecretDescription {
  /** When the value now held was written: its last rotation. Absent when the source does not know. */
  rotatedAt?: Date;
}

/** Where the daemon reads a secret: a repository's at each `setup` (ORC-308), the server's at its start (ORC-398). Docs: docs/ports/secret-source.md. */
export interface SecretSource {
  /** The value at `path`. Rejects when the source does not hold it or is out of service; its error never carries a value. */
  read(path: string): Promise<string>;
  /** What it knows of `path` without reading its value, for `doctor`; optional, a source without it knows no rotation date. */
  describe?(path: string): Promise<SecretDescription>;
}

/** An adapter, as `secret_sources.<name>.kind` names it: registered in `registry.ts`. */
export interface SecretSourceKind {
  /** Why `path` is not one of its paths, checked at startup without reading anything; undefined when it is. */
  checkPath(path: string): string | undefined;
  /** Its options that hold a credential: written `env:NAME`, resolved and masked, refused in clear in factory.yml (ORC-418). */
  credentialOptions?: readonly string[];
  /** Its options that name a file holding a credential (`age_key_file`, `token_file`): `doctor` lists each as in clear in a file (ORC-418). */
  credentialFiles?: readonly string[];
  /** The faults of a declaration's options (every key but `kind`), each prefixed by its key. */
  checkOptions(options: Record<string, unknown>): string[];
  /** The source of a declaration whose options passed `checkOptions`. */
  create(options: Record<string, unknown>, env: NodeJS.ProcessEnv): SecretSource;
}
