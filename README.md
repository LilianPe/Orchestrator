> **Orchestrator** (the factory's beta name): these docs describe the starting state (Relais); they are being rewritten ticket by ticket. The code already uses the new names (CLI `factory`, variables `FACTORY_*`, `~/.factory`, `.factory/`): the mapping is in [`docs/transition.md`, "Renaming"](docs/transition.md#renaming-orc-167).

# Relais

Coding agent orchestrator: a Linear ticket delegated to the agent becomes a PR, reviewed by a human and then by an AI review loop, ready to merge. Public prototype, under the [Elastic 2.0 license](#license).

- Relais runs as a daemon (`relais up`) connected to **Linear** (OAuth agent application + webhooks) and to **GitHub** (`gh` CLI).
- Each delegated ticket gets its own git worktree and a headless **Claude Code** session, resumed from run to run (feedback, CI, review).
- Behavior (events, jobs, models, limits, checks) is described in YAML per repository (`.relais/workflow.yml`); the agents' instructions live in a skills pack, not in the core.
- Humans stay in control: only they merge, the agent asks its questions in Linear, and a shared knowledge base grows through reviewed PRs.

## Prerequisites

Node.js 24+, git, GitHub CLI `gh` logged in, Claude Code CLI `claude` logged in, a Linear workspace you are an admin of, and a GitHub repository cloned locally. Details: [`docs/installation.md`](docs/installation.md).

## Quick start

From zero to a first processed ticket:

```bash
# 1. Install
git clone https://github.com/LilianPe/relais.git && cd relais
npm ci && npm run build && npm link

# 2. Configure the repository to hand over to Relais
cd <your repository>
relais init          # Linear team, OAuth application, knowledge base, .relais/workflow.yml

# 3. Start
relais up            # http://localhost:4100, then « Connecter Linear »
```

4. In Linear, create a clear ticket (at least 30 characters of description) and **delegate it to `@relais`**. Within 10 s: the comment « Bien reçu. » and the plan in the session, then status *In Progress*, live output in the interface, then the PR opened, status *Human Review* and a summary in the Linear session.
5. Reply in the session to request changes, move the ticket to *AI Review* for the AI review, merge the PR on GitHub: the ticket moves to *Done*.

Without tokens, to try the interface: `relais up --fake-runner`.

## Documentation

### Install
- [Installation](docs/installation.md): prerequisites, installation, the daemon's home directory.
- [Linear](docs/linear.md): OAuth application, agent connection, webhooks, delegation, statuses and labels.
- [GitHub](docs/github.md): account and permissions, PR polling, branches, branch protection, CI.
- [Deployment](docs/deploiement.md): Docker, long-running service, clean shutdown and updates.

### Configure
- [Daemon configuration](docs/configuration.md): environment variables, `config.yaml`, `secrets.json`, `factory.yml` (secrets as `env:`), daily budget, ports, secrets.
- [Customizing `workflow.yml`](docs/workflow.md): events, jobs, models, limits, checks, acceptance runs.
- [Repository configuration (`.factory/config.yml`)](docs/configuration-depot.md): keys, what a configuration cannot remove from the baseline, `factory validate`.
- [The `factory/default` preset](docs/preset.md): typed steps, loop bounds, single counter for review + red CI, models and network per step, invariants checked at compile time, hash.
- [Projects, worktrees and knowledge base](docs/projets-et-workspaces.md): multiple repositories, worktrees per ticket, `workspace.setup`, ports, cleanup, knowledge repository.
- [Pack and skills](docs/pack-et-skills.md): job skills and method skills (TDD, debugging, verification, tiered review), always-on rules, permissions, customizing or creating a skill.

### Use
- [Command line](docs/cli.md): `relais init|up|plan|status|pause|resume|stop` and `relais-agent`.
- [Web interface and security](docs/interface-et-securite.md): interface, exposed routes, password, CSRF, known limitations.

### Operate
- [Operations](docs/exploitation.md): limits reached, blocked tickets, pause, logs and transcripts, restarts, troubleshooting.
- [Acceptance testing](docs/recette.md): end-to-end verification on a test Linear.

### Transition to the factory
- [Starting point](docs/transition.md): reference commit and tag (`relais-v1-final`), live tests outside CI, module inventory with their status and the ticket that touches them.

### Testing
- [Tests and harness](docs/tests.md): writing a scenario with the fake adapters, the simulated clock and the test preset.
- [Idempotency of external effects](docs/idempotence.md): the table of the 7 effects (key, deduplication, behavior on duplicates), one test per row, what Linear, GitHub and Docker allow.
- [Port contracts](docs/ports/README.md): one sheet per port (methods, idempotency, errors, fencing) and its conformance suite, which every new adapter must pass.

### Decisions
Pages for decision tickets: question, options, evidence, recommendation, then the dev's decision, also written in the ticket.
- [ORC-128 — `claude -p` options](docs/decisions/ORC-128.md): ignoring the repository's settings, disabling the built-in web tools, resuming a ticket's session.
- [ORC-129: in-house inbox + outbox or DBOS Transact](docs/decisions/ORC-129.md): decision (in-house option), `kill -9` spike and replay on both options, impact on the engine tickets.
- [ORC-138 — `decide` invariants and effect duplicates](docs/decisions/ORC-138.md): decided on 2026-10-22, all recommendations adopted. The 12 property-testable invariants and the idempotency table of the 7 external effects.

### Contributing

```bash
npm test                  # unit tests and scenarios (vitest project `unit`)
npm run test:all          # all vitest projects
npm run test:integration  # Postgres (DATABASE_URL required)
npm run test:isolation    # rootless engine (FACTORY_ISOLATION=1)
npm run test:chaos        # daemon killed by kill -9 at random (CHAOS_EVENTS=500 and DATABASE_URL like the CI)
NUM_RUNS=10000 npm run test:properties  # decide invariants over 10,000 sequences, like the CI
npm run typecheck         # daemon and interface types
npm run lint
npm run dev               # CLI from source (tsx): npm run dev -- up
npm run dev:web           # interface with a proxy to :4100
```

Rules:

- **Every new feature ships its docs**: a page in `docs/` (installation, configuration, usage) or a section of an existing page, and its link from this README. A feature without docs is not finished.
- The YAML examples in [`docs/workflow.md`](docs/workflow.md) are loaded by a test (`src/docs-workflow.test.ts`): keep them valid.
- Everything in English: code, file names, commit messages (`feat(core): …`, `docs: …`), and text meant for humans (docs, pack skills, Linear messages).
- The CI (`.github/workflows/ci.yml`) runs typecheck, lint and unit tests on every PR, plus the separate Postgres and rootless jobs.

## License

The code is published under the [Elastic License 2.0](LICENSE) (ELv2): anyone can use it, modify it, redistribute it and use it in a company, but not offer it to third parties as a hosted or managed service, circumvent a license key, or remove the license notices. Parts taken from other projects keep their license, cited in [`packs/standard/NOTICE.md`](packs/standard/NOTICE.md).
