# SecretSource port

Where the daemon reads a repository's secrets (`repos[].secrets` of `factory.yml`), at each `setup` that gets them (ORC-308), and the server's own secrets (`github.private_key`, the Claude tokens, `secrets_key`…), at its start (ORC-398).

- Interface: `SecretSource` (`src/adapters/secrets/types.ts`), with `SecretSourceKind`, an adapter as `secret_sources.<name>.kind` names it.
- Implementations: `env`, the daemon's environment (`src/adapters/secrets/env.ts`, built in, never declared), `systemd-creds` (`src/adapters/secrets/systemd-creds.ts`, ORC-398), `file` (`src/adapters/secrets/file.ts`, ORC-470), `FakeSecretSource` (`src/adapters/secrets/fake.ts`, the harness's secret manager, with `fakeSecretKind`).
- Registry: `SECRET_SOURCE_KINDS` (`src/adapters/secrets/registry.ts`): `env`, `systemd-creds` and `file`. No adapter that needs a network credential (a cloud KMS, Vault) yet: it waited for `verify` and the runs to leave the host (ORC-151, ORC-179), whose code could read the daemon's environment, so a manager's credential, worth far more than one secret; they now come with ORC-418. `systemd-creds` and `file` need none.
- Reader: `SecretReader` (`src/adapters/secrets/reader.ts`) reads a setup's references from the opened sources, checks the minimal length (8 characters, below which sealing would purge too many files), and keeps what it read for the masking.
- Suite: `test/contracts/secret-source.contract.ts`, run by `src/adapters/secrets/env.test.ts`, `src/adapters/secrets/systemd-creds.test.ts`, `src/adapters/secrets/file.test.ts` and `src/adapters/secrets/fake.test.ts`.

## References

A reference is written `<source>:<path>`: `env:NPM_TOKEN`, or `coffre:kv/app#seed_key` for a source declared under `secret_sources`. At startup, its syntax is checked: its source is `env` or declared, and its adapter accepts its path (`checkPath`). A repository's is read at each `setup`, never before; a server secret's at the start (below).

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `read(path)` | the value at `path`, as the source holds it now | reads again, the same value while nobody rotated it | rejects when the source does not hold `path` or is out of service; neither the message nor its `cause` carries a value of the source (the daemon's log keeps the cause chain) |
| `describe(path)`, optional | what the source knows of `path` without reading its value: `rotatedAt`, when the value now held was written; `{}` when it does not know, a path it does not hold included | asks again | may reject when the source is out of service; never carries a value. `doctor` says « its rotation date could not be read » |
| `SecretSourceKind.checkPath(path)` | why `path` is not one of its paths, without reading anything; undefined when it is | pure | none |
| `SecretSourceKind.checkOptions(options)` | the faults of a declaration's options (every key but `kind`), each prefixed by its key | pure | none |
| `SecretSourceKind.create(options, env)` | the source of a declaration whose options passed `checkOptions`, called at startup: it does not contact the source, whose faults (network, credential) appear at `read` only | a new source | may throw on options it refused |

## What the daemon does with it

### The server's secrets (ORC-398)

- `linear.client_secret`, `linear.webhook_secret`, `github.private_key`, `github.webhook_secret`, `github.client_secret`, `claude.accounts[].token`, `secrets_key`, and each option of a `secret_sources` declaration written `env:NAME`, are references.
- `env:NAME` is resolved while `factory.yml` is parsed, as before. Every other reference is read **once, at the daemon's start**, through the `SecretReader` that later reads the repositories' secrets (`loadSealedFactoryYml`, `src/config/server-secrets.ts`): the file is parsed a first time to find the references, they are read, and it is parsed again with their values. A source that fails stops the start, with `the secret github.private_key (creds:github-key) could not be read: <why>`, never a value. The values are masked in the transcripts from the start.
- The Claude account is re-read at each launch (ORC-215) with the values read at the start: an account added since with a reference of another source than `env` waits for the next start (the last account stays, with the usual warning).
- `factory doctor` reports, without reading a value, each server secret in clear (`env`, or a GitHub key in `GH_APP_KEY`) and the rotation date of the others through `describe`: past 180 days, or unknown, is a warning; never part of the verdict.
- `baseline` and `doctor` read the server secrets the same way: run outside the daemon's service, a `systemd-creds` reference fails (no `CREDENTIALS_DIRECTORY`).

### The repositories' secrets (ORC-308)

- The value is read at each `setup` that gets the repository's secrets, for the names its `.factory/config.yml` declares under `setup_secrets` only, before the setup's container exists. A setup on work nobody reviewed gets no secret and reads none.
- A source that fails, or a reference it does not hold: no setup container is created, the worktree is removed, and the ticket is blocked as a launch error, whose message names the secret and its reference, never the value. There is no fallback to another source.
- The journal receives names, and the reference of a secret that blocked the ticket, never a value: the replay does not change.
- `sealSecrets` uses the values of this launch. The values of a source that reads the daemon's environment (`env`, or a source of `kind: env`) are masked in the transcripts from the daemon's start; those of another source once a setup read them, and while the daemon runs, a rotated one included. After a restart, a run reattached before any new setup masks none of the latter.

## Idempotence

`read` writes nothing: replaying it reads again. Two reads return the same value as long as the secret is not rotated.

## Fencing

None: a value has no attempt. The setup that reads it belongs to its run, which carries the fencing.

## What the suite asks of the implementation

`SecretSourceSubject`: the source, a path it holds and its value, a valid path it does not hold, and optionally the same source out of service (`env` has none: the environment is always there) and its kind with a valid and an invalid path.

## Adding an adapter

Its file under `src/adapters/secrets/`, one line in `SECRET_SOURCE_KINDS`, a test that runs `describeSecretSourceContract` on it, and its options here. Two tests pin the registered adapters (`reader.test.ts`, `factory-yml.test.ts`): they change with each new one. The engine reads every source through `SecretReader`.

## Adapters' options

### `systemd-creds`

The credentials systemd decrypts for the daemon's service at its start, each a file of `$CREDENTIALS_DIRECTORY`, held in memory (ramfs), never written in clear to the disk. Encrypted with the host's key, and its TPM2 when it has one: a credential copied to another machine cannot be decrypted (this is systemd's property, not tested in CI). No network credential.

```yaml
secret_sources:
  creds: { kind: systemd-creds, store: /etc/credstore.encrypted }
github: { app_id: 123456, private_key: creds:github-app-key }
```

```ini
# factoryd.service
[Service]
LoadCredentialEncrypted=github-app-key
```

- A path is a credential name (`LoadCredentialEncrypted=<name>`): letters, digits, `_`, `.`, `-`, never `.` or `..`.
- `store`, optional, an absolute path: the folder of the encrypted files (`systemd-creds encrypt --name=github-app-key key.pem /etc/credstore.encrypted/github-app-key.cred`). `describe` gives the date of `<store>/<name>.cred`, else `<store>/<name>`, as its rotation date: re-encrypting a rotated key dates it. Without it, the rotation date is unknown.
- `read` drops one final line break: `echo … | systemd-creds encrypt` keeps it, and a webhook secret must not.
- Out of the service (`CREDENTIALS_DIRECTORY` not set), `read` rejects: `CREDENTIALS_DIRECTORY is not set: the daemon does not run as a systemd service with LoadCredentialEncrypted=<name>`.

### `file`

A value held in a file of `dir`, for the `secrets_key` `factory init --dev` draws on a workstation (ORC-470), beside the `secrets.json` it encrypts but never in it. In clear on that disk, its owner's alone: `factory doctor` says it `in clear`; a server keeps its secrets in a sealed source. No network credential.

```yaml
secret_sources:
  factory_home: { kind: file, dir: /home/<user>/.factory }
secrets_key: factory_home:secrets.key
```

- `dir`, required, an absolute path. A path is a file name of that folder: letters, digits, `_`, `.`, `-`, never starting with a dot, never a path.
- `read` refuses a file others than its owner can read on POSIX (`the file <name> is readable by others than its owner: chmod 600 it`), and a symbolic link or anything but a regular file (`the file <name> is not a regular file`); it drops one final line break. A missing file: `no file <name> in its folder`. Windows has no mode bits: the folder's ACL keeps it ([`installation.md`](../installation.md)).
- `describe` gives the file's modification date as its rotation date (`doctor` never warns of the rotation of `secrets_key`, which nothing re-encrypts yet).

## Known gaps

- An option of a `secret_sources` declaration can only be resolved from `env:NAME` (resolved at startup, masked like the daemon's own secrets, ORC-398), not from another source.
