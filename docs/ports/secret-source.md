# SecretSource port

Where the daemon reads a repository's secrets (`repos[].secrets` of `factory.yml`), at each `setup` that gets them (ORC-308), and the server's own secrets (`github.private_key`, the Claude tokens, `secrets_key`…), at its start (ORC-398).

- Interface: `SecretSource` (`src/adapters/secrets/types.ts`), with `SecretSourceKind`, an adapter as `secret_sources.<name>.kind` names it.
- Implementations: `env`, the daemon's environment (`src/adapters/secrets/env.ts`, built in, never declared), `systemd-creds` (`src/adapters/secrets/systemd-creds.ts`, ORC-398), `file` (`src/adapters/secrets/file.ts`, ORC-470), `sops` (`src/adapters/secrets/sops.ts`, ORC-418), `vault` (`src/adapters/secrets/vault.ts`, ORC-418), `FakeSecretSource` (`src/adapters/secrets/fake.ts`, the harness's secret manager, with `fakeSecretKind`).
- Registry: `SECRET_SOURCE_KINDS` (`src/adapters/secrets/registry.ts`): `env`, `systemd-creds`, `file`, `sops` and `vault`. The last two hold a manager's credential (sops's decryption key, Vault's token), worth far more than one secret: they waited for `verify` and the runs to leave the host (ORC-151, ORC-179), whose code could read the daemon's environment, and came with ORC-418. `systemd-creds` and `file` need none.
- Reader: `SecretReader` (`src/adapters/secrets/reader.ts`) reads a setup's references from the opened sources, checks the minimal length (8 characters, below which sealing would purge too many files), and keeps what it read for the masking.
- Suite: `test/contracts/secret-source.contract.ts`, run by `src/adapters/secrets/env.test.ts`, `src/adapters/secrets/systemd-creds.test.ts`, `src/adapters/secrets/file.test.ts`, `src/adapters/secrets/sops.test.ts` (a simulated `sops` binary), `src/adapters/secrets/vault.test.ts` (a fake Vault server on the loopback) and `src/adapters/secrets/fake.test.ts`. No test needs a real sops, age key, KMS or Vault.

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
- `baseline` reads the server secrets the same way, and `doctor` the GitHub App's (Linear's apart, for its statuses check), all of them with `--secrets` (ORC-456, [`cli.md`](../cli.md#factory-doctor-repo)): run outside the daemon's service, a `systemd-creds` reference read fails (no `CREDENTIALS_DIRECTORY`).

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

### `sops`

A file encrypted by [sops](https://github.com/getsops/sops), with [age](https://age-encryption.org) or a cloud KMS, deployed beside the daemon (or committed to its configuration repository): only its values are encrypted, its keys stay readable. At each read, the daemon runs `sops --decrypt --output-type json <file>` and keeps the clear document in memory only, never on its disk. The `sops` binary must be on the daemon's `PATH`.

```yaml
secret_sources:
  sops: { kind: sops, file: /etc/factory/secrets.enc.yaml, age_key_file: /etc/factory/age.key }
github: { app_id: 123456, private_key: sops:github.private_key, webhook_secret: sops:github.webhook_secret }
```

```bash
age-keygen -o /etc/factory/age.key && chmod 600 /etc/factory/age.key
sops encrypt --age "$(age-keygen -y /etc/factory/age.key)" secrets.yaml > /etc/factory/secrets.enc.yaml
```

- `file`, required, an absolute path: the encrypted file, YAML, JSON, dotenv or INI (sops reads its format from its extension).
- `age_key_file`, optional, an absolute path: handed to sops as `SOPS_AGE_KEY_FILE`. Without it, sops finds its key as it always does in the daemon's environment: `SOPS_AGE_KEY_FILE`, `SOPS_AGE_KEY`, its default `keys.txt`, or a cloud KMS's credentials (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`…) for a file encrypted with one. Keep the key file the daemon's user's alone (`chmod 600`).
- A path is a key path of the decrypted document: names of letters, digits, `_`, `-`, joined by `.` (`github.private_key`); an index reaches an item of a list (`hosts.0`). A key whose name holds a dot cannot be reached.
- The value must be a text: a number, a list or a section is refused (`the key port of the sops file is not a text`), without its content. A missing key: `no key github.absent in the sops file`.
- sops that cannot decrypt rejects with its first line of error (`sops could not decrypt the file: Failed to get the data key required to decrypt the SOPS file.`); sops missing from the `PATH`: `sops is not installed (no sops in the PATH)`. A read is limited to 30 seconds.
- `describe` gives the date sops writes in the file's metadata, in clear (`sops.lastmodified`, `sops_lastmodified=` in a dotenv file, `lastmodified` of the `[sops]` section in an INI one), as its rotation date: every `sops edit` or `sops set` that changes a value dates it, whichever value changed. It decrypts the file to check that the key exists.

### `vault`

A field of a secret of HashiCorp Vault's key/value engine, version 2 (`GET /v1/<mount>/data/<path>`), read at each read with a token. The token goes in `X-Vault-Token`, never in the URL.

```yaml
secret_sources:
  vault: { kind: vault, address: https://vault.example.com:8200, mount: secret, token: env:VAULT_TOKEN }
github: { app_id: 123456, private_key: vault:factory/github#private_key }
```

- `address`, required: the server alone, an `https://` URL, or `http://` on the loopback alone (`127.0.0.1`, `localhost`, `[::1]`), where the token never crosses a network; no path, query or credentials. A redirect is never followed (`Vault answered 307: a redirect is not followed`): it would carry the token to wherever it points.
- `token` or `token_file`, one of them. `token` is written `env:NAME` (`env:VAULT_TOKEN`): resolved at the start and masked as the daemon's own secrets (`factory doctor` says it `in clear in the daemon's environment`). Nothing checks it: a token written in clear in `factory.yml` is read, but neither masked nor reported, so never write one. `token_file`, an absolute path, is re-read at each read (an empty file is refused): where a [Vault Agent](https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent) writes the token it renews (its `sink`), the way to keep a short-lived token without restarting the daemon.
- `mount`, optional: the engine's mount path, `secret` by default (`team/kv` is one). `namespace`, optional: sent as `X-Vault-Namespace` (Vault Enterprise, HCP Vault).
- A path is `<path>#<field>`: the secret's path in the engine, segments of letters, digits, spaces, `_`, `.`, `-` (never `.` or `..`) joined by `/`, then the field of its data. The token's policy needs `read` on `<mount>/data/<path>`.
- The field must be a text. A missing secret: `no secret factory/absent in Vault (secret)`; a missing field: `no field absent in the Vault secret factory/github`. A refused token, expired or without the policy: `Vault refused the token (403): …`; another status: `Vault answered 503`; no answer within 10 seconds, or no connection: `Vault is unreachable at <address>`. A token that is no header value (a space, a line break inside it) is refused before any request, without quoting it. No error quotes Vault's body.
- `describe` gives the creation date of the secret's current version (`metadata.created_time`) as its rotation date: writing a new version of the secret dates it, whichever field changed.

## Known gaps

- `vault` reads the KV v2 engine with a token only: no KV v1, no other engine (database credentials, PKI), no other auth method (AppRole, Kubernetes) but through a Vault Agent's `token_file`. A cloud manager (AWS Secrets Manager, GCP Secret Manager) has no adapter of its own: a sops file encrypted with that cloud's KMS reaches it.

- An option of a `secret_sources` declaration can only be resolved from `env:NAME` (resolved at startup, masked like the daemon's own secrets, ORC-398), not from another source.
