# Threat model

The factory assumes the agent is compromised: an issue, a comment, a README or a dependency can steer it. It does not promise the agent will do nothing wrong; it bounds what the agent can reach. This page lists, for the slice from the first ticket to the PR, the five threats the factory answers to, each attack with the defense that bounds it and the tests that check that defense. Where there is no defense or no test, the row says so: an **open** hole, with the ticket that owns it when there is one.

`src/docs-threat-model.test.ts` reads this page: each of the five threats is here, every row names a defense and either a test or the word **Open**, every cited test file exists, and every test title quoted after a file (« … ») is in that file.

How to read the Tests column:

- `test/isolation/…` runs only with `FACTORY_ISOLATION=1` and a container engine: the `isolation` CI job, rootless Podman ([`tests.md`](tests.md#isolation-tests)). Test no. 11 (`claude-settings.test.ts`) also skips without a real `claude` and a credential; tests no. 12 and 13 skip without a test GitHub App (in CI they run in the `isolation-github` job, on `main` only).
- `src/…` runs in the `unit` project, on every CI run.
- A quoted title names the case within the file; without one, the whole file is the test.

The defenses are described where they live: [`interface-and-security.md`](interface-and-security.md) (sandbox, network, secrets, server), [`pack-and-skills.md`](pack-and-skills.md#permissions) (refusals and `PreToolUse` hook), [`linear.md`](linear.md#authorizations-who-can-do-what) (authorization matrix), [`repository-configuration.md`](repository-configuration.md) (forbidden paths, `verify` checks), [`github.md`](github.md) (GitHub App, `doctor`, branch protection).

## 1. Compromised agent

Whatever it was told, the agent runs code in its sandbox. Everything below holds with sandboxes (`FACTORY_CONTAINER_CLI`); without them see [threat 5](#5-server-access).

| Attack | Defense | Tests |
|---|---|---|
| Escape the container: capabilities, kernel calls, mounts, host processes | Rootless engine, no capabilities, `NoNewPrivs`, seccomp, `/proc/sys` read-only, own pid namespace (ORC-204) | `test/isolation/isolation-01-runtime.test.ts`; `test/isolation/isolation-02-kernel.test.ts`; `test/isolation/rootless.test.ts` |
| Exhaust the machine: fork bomb, memory hog | Per-container limits: 512 processes, 4 GiB without swap, 2 CPUs | `test/isolation/isolation-09-resources.test.ts` |
| Read another ticket's work, `/tmp`, home or Claude session | One container per run, mounts of its own ticket only | `test/isolation/isolation-10-leaks.test.ts` |
| Steal a credential: the Claude account's token, repository secrets, the factory's Linear or GitHub tokens | The run gets only its run variables, the variables the repository declares and a placeholder; the egress proxy sets the Claude token on the way out (ORC-211, ORC-337) | `test/isolation/isolation-07-secrets.test.ts`; `test/isolation/claude-token.test.ts`; `src/adapters/runner/claude-code.test.ts` « never with the env of the container (ORC-211) »; `test/isolation/isolation-07-layers.test.ts` |
| Use the Claude account for something else: the Files API, a server tool or a document fetched by URL on the factory's account | Only the calls Claude Code makes get through, model call bodies checked before they go on (ORC-337) | `src/network/proxy.test.ts` « refuses a model call that would make Anthropic »; `src/network/proxy.test.ts` « refuses a path Claude Code does not call, /v1/files first »; `test/isolation/claude-token.test.ts` |
| Send data out: own socket, DNS, metadata service, a tool that ignores the proxy, HTTP/2, a forged `Host` | `--network none`, one Unix socket to the egress proxy, levels per step, private addresses refused (ORC-213, ORC-219) | `test/isolation/isolation-03-sockets.test.ts`; `test/isolation/isolation-04-dns.test.ts`; `test/isolation/isolation-05-bypass.test.ts`; `src/network/proxy.test.ts` « never reaches a private address, even at full »; `src/network/levels.test.ts` |
| Write to an allowed host: `git push` to another repository, a gist, `npm publish`, a redirect off the list | Every tunnel decrypted, GET/HEAD/OPTIONS only (but the Claude API and `git fetch`) | `test/isolation/isolation-06-allowed-domain.test.ts`; `src/network/proxy.test.ts` « refuses a plain write to GitHub, and journals it » |
| Carry code out in reads of an allowed host: a download counter (npm, a release's `download_count`), a query string | **Open** (ORC-370): reads of a listed host are not limited to what the run needs, and the query is not journaled. `test/isolation/isolation-06-allowed-domain.test.ts` keeps it as an `it.todo` | none |
| Load its own Claude Code settings: hooks, MCP servers, skills, agents of the repository | `--setting-sources ""`, `--strict-mcp-config`, `.claude/` removed from the worktree (ORC-128, ORC-205, ORC-284) | `test/isolation/claude-settings.test.ts`; `src/adapters/workspace/git-workspaces.test.ts` « keeps .claude/CLAUDE.md on disk for readConventions » |
| Run a destructive command: `git push --force`, `rm -rf /`, a download piped to a shell | The pack's `deny` list and its `PreToolUse` hook on the parsed command: a guard against mistakes, not a barrier (the rows above are the barrier) | `src/pack-guard.test.ts` |
| Push or merge by itself | No GitHub token in the run, GitHub writes refused by the proxy; the factory pushes and opens the draft PR (ORC-125) | `src/adapters/runner/claude-code.test.ts` « gives no run on the host a GitHub token (ORC-125) »; `src/publish/publish.test.ts` « pushes the verified commit and opens a draft PR »; `test/isolation/isolation-06-allowed-domain.test.ts` |
| Smuggle a trap into its diff: a workflow, git hooks or attributes, `.npmrc`, a `package.json` script, a symbolic link out of the tree, a binary, a secret | Blocking diff check before the push, forbidden paths, gitleaks in a sandbox at `none` (ORC-125, ORC-151, ORC-338) | `test/isolation/isolation-08-diff.test.ts`; `src/checks/forbidden-paths.test.ts`; `src/publish/publish.test.ts` « a symbolic link out of the tree » |
| Leave a trap in its git repository for the host: hooks, `core.fsmonitor`, a config | A repository of its own per workspace; the host only reads `HEAD`, refs and objects as data (ORC-317, ORC-341) | `test/isolation/host-git.test.ts`; `src/adapters/workspace/host-git.test.ts`; `test/isolation/worktree-tree.test.ts` |
| Make `verify` run its code on the host, or with secrets | Bundle out of a container without network, fresh clone without the repository's config, commands in a fresh sandbox at `none` (ORC-151) | `test/isolation/verify-hostile.test.ts`; `src/core/clean-verify.test.ts` |
| Write insecure code, or add a dependency that does not exist or is not allowed | `factory/semgrep` on the added lines (ORC-333), `factory/dependances` against the registry and the allow list (ORC-371) | `src/checks/semgrep.test.ts`; `src/checks/deps.test.ts`; `src/network/egress-fetch.test.ts` |
| Read another ticket through the agent API | A run token per run, accepted while it runs, for its ticket only | `src/server/app.test.ts` « protects the agent API with the run token » |
| Persist through memory: a manipulated agent writes an instruction into the knowledge base, served to the next tickets | Writing memory is asleep (ORC-193): `learn` notes are published by nobody. `claims/**` and the factory's knowledge are forbidden paths of the agent's diff (ORC-151). **Open** until memory writes come back: writes only from signed human signals (ORC-247) and the adversarial fact set (ORC-259) do not exist yet | `src/checks/forbidden-paths.test.ts` |

## 2. Trapped repository or dependency

The project's repository is written by whoever can push to it, and its dependencies by their authors.

| Attack | Defense | Tests |
|---|---|---|
| Repository settings that drive the agent: `.claude/settings.json`, `.mcp.json`, skills, hooks | None of them loads (see threat 1); `CLAUDE.md` and `AGENTS.md` reach the prompt as data the factory outranks (ORC-205) | `test/isolation/claude-settings.test.ts`; `src/core/prompt.test.ts` « injects them as data the factory outranks, after the ticket » |
| Install scripts (`postinstall`) that read `setup`'s secrets or leave them behind | Sealed `setup` in a container of its own, destroyed before the agent's; install scripts cut, too-young versions refused, the secret purged from the worktree (ORC-211) | `src/core/sealed-setup.test.ts` « cuts the install scripts of npm, pnpm and Yarn »; `src/core/sealed-setup.test.ts` « destroys the container, then purges the disk »; `test/isolation/isolation-07-secrets.test.ts` |
| A secret used by `setup` sent to a host of the `limited` level in a GET | **Open**: the same class as ORC-370; only methods are restricted ([known limitations](interface-and-security.md#known-limitations)) | none |
| A repository git config that carries credentials, a push URL, `insteadOf` or a hooks path into the sandbox | Only an allow list of the config reaches the agent's repository (ORC-341) | `src/adapters/workspace/git-workspaces.test.ts` « gives the agent the remote URL without its credentials » |
| `.factory/config.yml` that loosens the baseline: forbidden paths, `full` network, a wider diff | The configuration only tightens, read on the default branch (ORC-209) | `src/config/repo-config.test.ts` |
| A CI that exposes secrets to the factory's branches | `factory doctor` refuses the repository unless an environment with required reviewers guards them (ORC-135) | `src/cli/doctor.test.ts` « refuses a CI with secrets on pull_request without human approval »; `test/isolation/isolation-12-ci-secrets.test.ts` |
| A trapped dependency that opens the network from `verify` or the services | Commands at network `none`; an attempt's Postgres in a network without route, joined by the attempt's containers (ORC-309) | `test/isolation/services.test.ts`; `test/isolation/verify-hostile.test.ts` |
| A dependency added by the agent from a git URL, an alias or another index | `factory/dependances` fails closed on those sources (ORC-371) | `src/checks/deps.test.ts` « blocks a git or URL source » |

## 3. Malicious ticket or comment

Anyone who can write in Linear or on the PR can write text the agent will read.

| Attack | Defense | Tests |
|---|---|---|
| A prompt injection in a ticket or a comment | It reaches an agent bounded by threat 1. Human messages are typed events, classified at their arrival and tainted; a message without a signed author is untrusted (ORC-160, ORC-180) | `src/adapters/tracker/linear/webhook.test.ts` « marks a reply without a signed user id untrusted »; `src/core/human-message.test.ts` |
| Someone outside the team triggers a run, answers a question or relaunches a blocked ticket | Authorization matrix checked on the webhook's signed actor, never on a name in the text (ORC-186) | `src/core/authz.test.ts`; `src/core/engine-authz.test.ts` « the signed actor counts, never a name quoted in the text » |
| A forged webhook | HMAC signature on the raw body, 60 s freshness for Linear; `X-Hub-Signature-256` for GitHub | `src/adapters/tracker/linear/webhook.test.ts` « accepts a valid HMAC and rejects others »; `src/adapters/forge/github-webhook.test.ts` « accepts the HMAC-SHA256 of the raw body »; `src/adapters/forge/github-webhook.test.ts` « answers 401 for an unsigned body » |
| A review or a diff comment on the PR that steers the agent | Mapped as untrusted; a review counts only from someone with write access (ORC-190) | `src/adapters/forge/github-webhook.test.ts` « maps a human review and a diff comment as untrusted pr.reviewed »; `src/core/authz.test.ts` « refuses a team member without write access, and anyone else » |
| An injection that makes the agent publish something in Linear or on GitHub | The factory composes what it publishes from the agent's capped result, through its `OutputPolicy` (ORC-214, ORC-288) | `src/publish/output-policy.test.ts` |
| Read the tickets in transit | **Open** with the smee relay: the channel is public, anyone with its URL reads it. Use `publicUrl` ([`linear.md`](linear.md#3-webhooks-smee-or-public-url)) | none |

## 4. Compromised member account

A member's account acts with that member's rights: the matrix cannot tell them from the member.

| Attack | Defense | Tests |
|---|---|---|
| Launch harmful work | The run is bounded like threat 1; its result is a draft PR, pushed by the factory with a lease, never a merge by the agent | `src/publish/publish.test.ts` « pushes the verified commit and opens a draft PR »; `src/publish/publish.test.ts` « asks git for a lease and never a plain force » |
| Approve their own spec | The run's initiator never validates its spec (ORC-186, ORC-212) | `src/core/authz.test.ts` « refuses the initiator sending /approve, even when designated validator » |
| Push a trap onto the ticket's branch, then let the factory carry it | A human push is untrusted: `verify` on a fresh clone, the base's `sensitive_paths` refused on an untrusted branch (ORC-159) | `src/publish/publish.test.ts` « an untrusted branch that touches one is refused »; `src/adapters/forge/github-webhook.test.ts` « maps a human push as untrusted push.human » |
| Run commands on the server by taking a run over | The take-over is a container without network, or a bundle checked like the agent's work (ORC-234) | `src/core/engine-take-over.test.ts`; `test/scenarios/take-over.test.ts` |
| Reach other repositories through the factory | The GitHub App's token is limited to the run's repository, for one hour at most (ORC-124) | `src/adapters/forge/github-app.test.ts` « requests a repo-scoped token and caches it for at most one hour »; `test/isolation/isolation-13-run-token.test.ts` |
| Merge a harmful PR | The factory merges only the reviewed head with green checks (ORC-148). Only GitHub's branch protection keeps a human from merging alone; **Open**: `doctor` does not check it ([`github.md`](github.md#branch-protection-strongly-recommended)) | `src/adapters/forge/github-app.test.ts` « refuses an unchecked head in a repository with an active Actions workflow » |

## 5. Server access

Whoever reaches the server, its interface or its disk.

| Attack | Defense | Tests |
|---|---|---|
| Reach the interface from the network | Listens on the loopback; refuses to start exposed without `RELAIS_UI_PASSWORD`; under a foreign `Host` (DNS rebinding) refused (ORC-349) | `src/server/app.test.ts` « requires Basic auth on the API, the UI and /oauth/start »; `src/server/app.test.ts` « refuses the interface, its reads and its writes, under a name that is not the loopback or the public URL » |
| A third-party page in the operator's browser pauses or stops runs | `Origin` checked on every write | `src/server/app.test.ts` « rejects a mutating API call from another origin » |
| Read a run token from the dashboard | Never served to the browser | `src/server/app.test.ts` « serves no run token to the browser » |
| Act from the dashboard under someone else's name | Every action journaled with the Basic auth user; **Open** (ORC-222): the name is not signed, every holder of the password is an operator | `src/server/app.test.ts` « names the author by the user of the HTTP Basic auth, behind the password » |
| Read the secrets on disk: `secrets.json`, the egress authority's key, transcripts | Files in `0600`; **Open** (ORC-222): no KMS, the secrets are in clear for the daemon's user | `src/config/instance.test.ts`; `src/network/ca.test.ts` |
| Runs on the host read the daemon's secrets and `/proc` | The daemon refuses to start without a container engine unless `FACTORY_ALLOW_HOST_RUNS=1` (ORC-349) | `src/app/bootstrap.test.ts` « refuses to start real runs without a container engine or FACTORY_ALLOW_HOST_RUNS=1 (ORC-349) » |
| A shell on the server, unnamed and unlogged | **Open** (ORC-222): named, logged access to the server is not built | none |

## History: limitations lifted

What [`interface-and-security.md`](interface-and-security.md#known-limitations) once listed as known limitations, kept here once lifted.

- **Sandbox: the Claude token is visible to the agent.** It was the runner's only credential, in its environment. Lifted by ORC-337: the sandbox holds a placeholder, the egress proxy sets the token on the way to `api.anthropic.com` (`test/isolation/claude-token.test.ts`).
- **Same system user, secrets passed to runs.** Every run used to execute on the host under the daemon's user, with its secrets. With sandboxes, a run gets only its variables (ORC-211), and the daemon no longer starts without a container engine unless `FACTORY_ALLOW_HOST_RUNS=1` asks for host runs (ORC-349). The host runs themselves keep the limitation.
- **Claude Code's refusals as the first barrier.** [`github.md`](github.md#branch-protection-strongly-recommended) once presented the pack's refusals as the first barrier against a push. They are a guard against mistakes; the barrier is the sandbox without a token and the factory's publication (ORC-125, ORC-349).

Still open, and still listed there: the smee channel is public (threat 3), only branch protection keeps a merge human (threat 4), the transcripts hold everything the agents read and wrote (threat 5, `RELAIS_HOME` to protect), and runs on the host, when chosen, share the daemon's user and secrets.
