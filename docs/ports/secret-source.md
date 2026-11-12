# SecretSource port

Where the daemon reads a repository's secrets (`repos[].secrets` of `factory.yml`), at each `setup` that gets them (ORC-308).

- Interface: `SecretSource` (`src/adapters/secrets/types.ts`), with `SecretSourceKind`, an adapter as `secret_sources.<name>.kind` names it.
- Implementations: `env`, the daemon's environment (`src/adapters/secrets/env.ts`, built in, never declared), `FakeSecretSource` (`src/adapters/secrets/fake.ts`, the harness's secret manager, with `fakeSecretKind`).
- Registry: `SECRET_SOURCE_KINDS` (`src/adapters/secrets/registry.ts`). Only `env` is registered: no real secret manager before ORC-151 and ORC-179. Until `verify` and the runs on the host are gone, their code can read the daemon's environment, so a manager's credential, worth far more than one secret.
- Reader: `SecretReader` (`src/adapters/secrets/reader.ts`) reads a setup's references from the opened sources, checks the minimal length (8 characters, below which sealing would purge too many files), and keeps what it read for the masking.
- Suite: `test/contracts/secret-source.contract.ts`, run by `src/adapters/secrets/env.test.ts` and `src/adapters/secrets/fake.test.ts`.

## References

A reference is written `<source>:<path>`: `env:NPM_TOKEN`, or `coffre:kv/app#seed_key` for a source declared under `secret_sources`. At startup, only its syntax is checked: its source is `env` or declared, and its adapter accepts its path (`checkPath`). Nothing is read before a `setup`.

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `read(path)` | the value at `path`, as the source holds it now | reads again, the same value while nobody rotated it | rejects when the source does not hold `path` or is out of service; the message never carries a value of the source |
| `SecretSourceKind.checkPath(path)` | why `path` is not one of its paths, without reading anything; undefined when it is | pure | none |
| `SecretSourceKind.checkOptions(options)` | the faults of a declaration's options (every key but `kind`), each prefixed by its key | pure | none |
| `SecretSourceKind.create(options, env)` | the source of a declaration whose options passed `checkOptions` | a new source | may throw on options it refused |

## What the daemon does with it

- The value is read at each `setup` that gets the repository's secrets, for the names its `.factory/config.yml` declares under `setup_secrets` only, before the setup's container exists. A setup on work nobody reviewed gets no secret and reads none.
- A source that fails, or a reference it does not hold: no setup container is created, the worktree is removed, and the ticket is blocked as a launch error, whose message names the secret and its reference, never the value. There is no fallback to another source.
- The journal receives names only: the replay does not change.
- Masking and `sealSecrets` use the values of this launch. Every value read stays masked in the transcripts while the daemon runs, a rotated one included. After a crash, the worktree is made anew (ORC-211's mark), so a rotation needs nothing more.

## Idempotence

`read` writes nothing: replaying it reads again. Two reads return the same value as long as the secret is not rotated.

## Fencing

None: a value has no attempt. The setup that reads it belongs to its run, which carries the fencing.

## What the suite asks of the implementation

`SecretSourceSubject`: the source, a path it holds and its value, a valid path it does not hold, and optionally the same source out of service (`env` has none: the environment is always there) and its kind with a valid and an invalid path.

## Adding an adapter

Its file under `src/adapters/secrets/`, one line in `SECRET_SOURCE_KINDS`, a test that runs `describeSecretSourceContract` on it, and its options here. Nothing else changes: the engine reads every source through `SecretReader`.

## Known gaps

None.
