# Transition : point de départ de Relais

Cette page fige l'état de Relais d'où part le MVP de l'usine, et dit, pour chaque module, ce qu'il devient et quel ticket le touche. Elle sert de référence pour comparer et pour revenir en arrière ; les tickets cibles la font vivre (un ticket qui retire ou transforme un module met à jour sa ligne).

## Commit de référence

| | |
|---|---|
| Commit | `ebc405d` (`ebc405d5f3e3f5a69a4bd2e1b71e5e0d3eb1caaf`), merge de la PR #27, tête de `main` au 21/10 |
| CI sur ce commit | workflow `ci` (`npm ci`, `npm run typecheck`, `npm run lint`, `npm test`) vert : run [38868662643](https://github.com/LilianPe/relais/actions/runs/38868662643) |
| Tag | `relais-v1-final`, annoté, sur ce commit (posé par un mainteneur, commande ci-dessous) |
| Taille de départ | 65 fichiers non test dans `src/`, dont 4 487 lignes de TypeScript |

Poser le tag (une fois, par un mainteneur) :

```bash
git tag -a relais-v1-final ebc405d5f3e3f5a69a4bd2e1b71e5e0d3eb1caaf -m "Relais V1 : point de départ du MVP de l'usine"
git push origin refs/tags/relais-v1-final
```

Vérifier qu'il pointe sur le bon commit (un tag annoté est un objet à part : on suit son `object.sha` jusqu'au commit) :

```bash
tag=$(gh api repos/LilianPe/relais/git/ref/tags/relais-v1-final --jq .object.sha)
gh api repos/LilianPe/relais/git/tags/$tag --jq .object.sha   # doit afficher ebc405d5f3e3f5a69a4bd2e1b71e5e0d3eb1caaf
```

Revenir à l'état de départ pour comparer : `git diff relais-v1-final -- <chemin>`, ou `git switch --detach relais-v1-final`.

## Branche de travail

L'usine évolue sur `main` directement, sans branche longue : chaque incrément est un ticket ORC, sur une branche nommée d'après lui, et arrive par PR vers `main` (règle du dépôt, `AGENTS.md`). Le tag `relais-v1-final` garde l'état de départ.

## Données

Aucune migration : `relais.db`, `transcripts/`, `workspaces/` et le dépôt de connaissance repartent de zéro (ORC-178 archive puis supprime les anciens).

## Tests live, hors CI

Deux tests parlent à de vrais services. Ils sont dans le glob de `vitest.config.ts`, mais se sautent eux-mêmes quand leur variable manque, et la CI (`.github/workflows/ci.yml`) n'en définit aucune :

| Test | Condition qui le lance | Sinon |
|---|---|---|
| `src/adapters/tracker/linear/queries.live.test.ts` | `LINEAR_API_KEY` définie (`describe.skipIf(!key)`) | sauté |
| `test/e2e/pack.e2e.test.ts` | `RELAIS_E2E=1` (`describe.skipIf(process.env['RELAIS_E2E'] !== '1')`) | sauté |

Sur le run de référence, le journal de la CI montre les deux fichiers « 1 skipped » (40 fichiers passés, 2 sautés, 250 tests passés, 2 sautés). Un ticket qui ajoute un test live suit la même règle : une variable d'environnement le lance, la CI ne la définit pas.

## Inventaire des modules

Statuts de départ :

- **garder** : le module reste tel quel ou presque ; le ticket cité s'appuie dessus.
- **adapter** : le module reste, mais le ticket cité le transforme.
- **retirer** : le module disparaît ; le ticket cité le remplace ou le retire.
- **à trancher** : aucun ticket ne règle clairement son sort (voir la dernière section).

Le premier ticket cité est celui qui touche le module en premier ou le plus ; les suivants le touchent aussi. `src/docs-transition.test.ts` vérifie que chaque fichier non test de `src/` a une ligne avec un statut.

### `src/core/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/core/engine.ts` | `decide(event, ticket, ctx)` : règles `on` du YAML et cas codés → commandes | adapter | ORC-133 (`decide` pure, `{events, effects, timers, trace}`), ORC-187 (préréglage), ORC-169 (règles `on` retirées) |
| `src/core/orchestrator.ts` | Files, runs, vérifications, blocages, reprise ; mute l'état hors de `decide` | retirer | ORC-133 (`reduce` extrait), ORC-149 (worker), ORC-150 (exécuteurs), ORC-220 (`recover`), retrait final ORC-169 |
| `src/core/bus.ts` | Chaîne d'événements en mémoire (`EventBus`, aussi source du SSE) | retirer | ORC-169 (ORC-223 garde le flux SSE du dashboard) |
| `src/core/scheduler.ts` | Places `dev` et `questions` en mémoire | retirer | ORC-169 (ORC-182 garde un emplacement à part pour les questions) |
| `src/core/timers.ts` | `TimerService` : debounce en mémoire, `debounce.fired` | retirer | ORC-161 (timers en base via l'inbox), retrait ORC-169 |
| `src/core/commands.ts` | Type `Command` (effets externes et changements d'état mêlés) | retirer | ORC-133 (découpé en effets, timers, événements), retrait ORC-169 |
| `src/core/conditions.ts` | Mini-langage `when` | retirer | ORC-177 |
| `src/core/verify.ts` | `runVerify` : commandes `bash -lc` dans le worktree de l'agent | adapter | ORC-151 (sandbox neuf, SHA figé), ORC-179 (plus dans le worktree) |
| `src/core/prompt.ts` | Prompt texte d'un run (skill, ticket, branche, PR, échecs de vérif) | adapter | ORC-136 (pistes d'`intake`), ORC-151 (logs tronqués), ORC-182 (entrées de l'agent de réponse) |
| `src/core/pickup.ts` | Contrôles avant prise (description, branche poussée, critères) | adapter | ORC-206 (garde avant In Progress) ; reste en place jusque-là (ORC-169) |
| `src/core/naming.ts` | `slugify`, `branchName` (`relais/<id>-<slug>`) | adapter | ORC-167 (préfixe), ORC-136 et ORC-204 (`branchName` de Linear) |
| `src/core/clock.ts` | `Clock`, `SystemClock`, `FakeClock` | garder | ORC-225, ORC-161 |
| `src/core/duration.ts` | `parseDuration` (`3m`, `90m`…) | garder | ORC-177 (gardé si `factory.yml` garde des durées en texte) |
| `src/core/types.ts` | `RelaisEvent`, `TicketState`, 6 états logiques | adapter | ORC-133 (`schemaVersion`, renommages), ORC-160 (taint, acteur), ORC-180 (`humanInbox`), ORC-187 (états retirés) |

### `src/adapters/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/adapters/exec.ts` | `execCmd`, `mustExec` : sous-processus utilisé par git, `gh`, la base de connaissance, la CLI | à trancher | aucun ticket ne le nomme |
| `src/adapters/forge/types.ts` | Port `Forge` | adapter | ORC-181 (port gardé, nouvelles opérations), ORC-124 |
| `src/adapters/forge/fake.ts` | `FakeForge` | adapter | ORC-181, ORC-225 |
| `src/adapters/forge/gh-cli.ts` | Forge par la CLI `gh` | retirer | ORC-181 (après ORC-124, GitHub App) |
| `src/adapters/forge/pr-poller.ts` | Relevé des PR toutes les 30 s | retirer | ORC-181, remplacé par ORC-134 (webhooks) et ORC-185 (réconciliation) |
| `src/adapters/runner/types.ts` | Port `Runner`, `RunHandle`, `RunRequest` | garder | ORC-204 (port gardé), ORC-189 (devient AgentRuntime) |
| `src/adapters/runner/claude-code.ts` | `ClaudeCodeRunner` : `claude -p` en sous-processus sur l'hôte, transcripts | adapter | ORC-136, ORC-204 (dans le runner isolé), ORC-205 (réglages imposés), ORC-217 (session sur volume), ORC-194 (`--max-budget-usd`), ORC-167 |
| `src/adapters/runner/stream-parser.ts` | Lecture du stream-json de Claude Code | adapter | ORC-136 (usage en tokens), gardé par ORC-204 |
| `src/adapters/runner/channel.ts` | File asynchrone qui porte le flux d'un `RunHandle` | à trancher | aucun ticket ne le nomme ; suit le port `Runner` (ORC-204) |
| `src/adapters/runner/fake.ts` | `FakeRunner` du harnais | garder | ORC-204, ORC-225 |
| `src/adapters/runner/fixtures/` | Données de test : faux `claude` et flux stream-json | garder | ORC-136 (suivent le runner) |
| `src/adapters/tracker/types.ts` | Port `Tracker`, `ActivityInput` | adapter | ORC-160 (id d'effet), ORC-171 (plan dans la session) |
| `src/adapters/tracker/fake.ts` | `FakeTracker` | garder | ORC-160, ORC-225 |
| `src/adapters/tracker/activity-relay.ts` | Relaie la sortie d'un run en activités de la session Linear, avec un débit plafonné | à trancher | aucun ticket ne le nomme |
| `src/adapters/tracker/linear/api.ts` | `LinearApi` : client GraphQL | garder | ORC-160 |
| `src/adapters/tracker/linear/queries.ts` | Documents GraphQL | adapter | ORC-160 (marqueur de commentaire), ORC-171 (`agentSessionUpdate` avec plan) |
| `src/adapters/tracker/linear/tracker.ts` | `LinearTracker` (cache, `ensureSetup`) | adapter | ORC-160 (commentaires et labels idempotents), ORC-201 (plus de « Ready to Merge » ni `agent:*`), ORC-170 |
| `src/adapters/tracker/linear/webhook.ts` | Signature, fraîcheur, `deliveryKey`, `mapLinearWebhook` | adapter | ORC-160 (`status.changed`, `label.changed`, taint), ORC-147, ORC-171 |
| `src/adapters/tracker/linear/ingest.ts` | Ingestion : vérifie, dédoublonne en mémoire, ack, `submit` | adapter | ORC-147 (inbox écrite avant la réponse), ORC-160 |
| `src/adapters/tracker/linear/reconcile.ts` | Réconciliation Linear toutes les 30 s | adapter | ORC-185 (5 min, timer en base, inbox) |
| `src/adapters/tracker/linear/oauth.ts` | OAuth Linear, jetons rafraîchis écrits dans `secrets.json` | adapter | ORC-222 (secrets scellés), ORC-199 (`secrets.json` retiré) |
| `src/adapters/tracker/linear/fixtures/` | Données de test : webhooks Linear | garder | ORC-160 (suivent `webhook.ts`) |
| `src/adapters/workspace/types.ts` | Port `WorkspaceManager` | adapter | ORC-189 (devient SandboxProvider), ORC-204 |
| `src/adapters/workspace/git-workspaces.ts` | Worktrees par ticket sur l'hôte, `_trunk`, `_kb`, ports, `setup` | adapter | ORC-179 (base du miroir et des clones neufs, ou retiré), ORC-204 (`branchName`, `setup` dans le conteneur), ORC-193 (`_kb`) |
| `src/adapters/workspace/fake.ts` | `FakeWorkspaces` | adapter | ORC-225 (`FakeSandboxProvider`), ORC-204 |

### `src/app/` et racine de `src/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/app/bootstrap.ts` | Câblage du démon (store, adaptateurs, orchestrateur, serveur, variables `RELAIS_*`) | adapter | ORC-147 (`submit` → inbox), ORC-149, ORC-167, ORC-179 (`PORT`), ORC-192, ORC-201, câblage restant retiré par ORC-169 |
| `src/app/root.ts` | Trouve la racine du dépôt par le `package.json` nommé `relais` | adapter | ORC-167 (le renommage du paquet le casse, le ticket ne le nomme pas) |
| `src/app/tracker-switch.ts` | `Tracker` de substitution tant que Linear n'est pas connecté par OAuth | à trancher | aucun ticket ne le nomme |
| `src/version.ts` | Version du paquet | garder | ORC-167 |

### `src/store/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/store/types.ts` | Port `Store` synchrone | adapter | ORC-132 (async, puis `PgStore`), ORC-178 (`queue`, `echoes`, `costSince` retirés) |
| `src/store/sqlite-store.ts` | `SqliteStore` sur `node:sqlite` | retirer | ORC-132 (Postgres), retrait ORC-178 |

### `src/config/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/config/instance.ts` | `config.yaml` et `secrets.json` de l'instance (zod) | adapter | ORC-209 (`factory.yml`), ORC-199 (`config.yaml` et `secrets.json` retirés), ORC-194 (`perDayUsd`), ORC-167 (`RELAIS_HOME`) |
| `src/config/load-workflow.ts` | Fusion pack + `.relais/workflow.yml` | retirer | ORC-177 (remplacé par ORC-187 et ORC-209) |
| `src/config/workflow-schema.ts` | Schéma zod de `workflow.yml` | retirer | ORC-177 |
| `src/config/run-settings.ts` | `run-settings.json` : refus de lecture sur `RELAIS_HOME` | retirer | ORC-179, ORC-199 |

### `src/server/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/server/app.ts` | API Hono : interface, SSE, webhook Linear, `/agent/*`, pause/resume, mot de passe, CSRF | adapter | ORC-147 (webhook attendu), ORC-192 (`/agent/*` retiré), ORC-200 (pause/resume retirés), ORC-223 (API du dashboard), ORC-222 (authentification nominative), ORC-134 (webhook GitHub) |
| `src/server/static.ts` | Sert l'interface construite | garder | ORC-223 |

### `src/relay/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/relay/smee.ts` | Relais Smee des webhooks vers l'instance locale | garder | ORC-221 (option de développement seulement) |

### `src/knowledge/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/knowledge/kb.ts` | `KnowledgeBase` : pull, index, recherche par termes | adapter | ORC-232 (lecture seule, `kb_search`, troncature signalée), ORC-193 (écriture retirée) |

### `src/cli/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/cli/relais.ts` | CLI `relais` : `init`, `up`, `plan`, `status`, `pause`, `resume`, `stop` | adapter | ORC-167 (`factory`), ORC-200 (`plan`, `pause`, `resume`, `--fake-runner` retirés), ORC-220 (`status`, `stop`) |
| `src/cli/init.ts` | Assistant `init` (app OAuth, smee, base de connaissance, `.relais/workflow.yml`) | adapter | ORC-208 (GitHub App, `factory.yml`, détection), ORC-177, ORC-193, ORC-200 |
| `src/cli/plan.ts` | `relais plan` : tickets délégués qui seraient pris | retirer | ORC-200 |
| `src/cli/relais-agent.ts` | CLI de l'agent : `issue`, `search`, `kb search`, `ask` | retirer | ORC-192 (MCP de l'usine) |

### `web/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `web/src/App.tsx` | Interface : en-tête (places, file, coût du jour), tickets, session en direct, journal | adapter | ORC-223 (Flux, Détail d'un run, Vue d'ensemble), ORC-194 (coût en tokens) |
| `web/src/state.ts` | Reducer de l'état de l'interface | adapter | ORC-223 |
| `web/src/api.ts`, `web/src/types.ts` | Appels à `/api/*` et SSE, types des vues (6 états, coût en USD) | adapter | ORC-223 (API lues depuis Postgres), ORC-194 |
| `web/src/main.tsx`, `web/src/styles.css`, `web/src/vite-env.d.ts`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json` | Point d'entrée, styles, build Vite | garder | ORC-223 |

### `packs/standard/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `packs/standard/workflow.yml` | 6 états, règles `on`, jobs, limites | retirer | ORC-177 (remplacé par ORC-187), ORC-193 (`learn`, `remember`), ORC-194 (`usd`) |
| `packs/standard/settings.json` | Réglages Claude Code des runs (`acceptEdits`, `git push`, `gh`…) | adapter | ORC-191, ORC-205 (deny-list imposée), ORC-181 |
| `packs/standard/.claude-plugin/plugin.json` | Plugin `relais` | adapter | ORC-167 (nom), ORC-191 |
| `packs/standard/hooks/hooks.json`, `packs/standard/hooks/session-start.mjs` | Hook de démarrage : règles, méthode, index de la base | adapter | ORC-191 (plus de `RELAIS_*` ni `relais-agent`), ORC-232 (index injecté par le `systemPrompt`), ORC-205 |
| `packs/standard/skills/{dev,feedback,review,ask}/` | Skills de job | adapter | ORC-191 (une consigne par étape, fin par `submit_result`), ORC-187 |
| `packs/standard/skills/{fix-ci,learn}/` | Skills de job sans équivalent au MVP | retirer | ORC-191, ORC-193 (`learn`) |
| `packs/standard/skills/{tdd,debugging,verification,code-review,receiving-review}/` | Skills de méthode | garder | ORC-191 (relus pour retirer push et CI) |
| `packs/standard/NOTICE.md` | Mention de licence (superpowers, MIT) | garder | ORC-191 |

### `test/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `test/helpers/harness.ts` | `createHarness` : faux adaptateurs, `FakeClock`, `SqliteStore(':memory:')`, `send`, `advance`, `restart` | adapter | ORC-225 (nouveaux faux, préréglage de test), ORC-228 (Postgres, worker, outbox), ORC-132 (store async), ORC-149 (`idle` remplacé) |
| `test/scenarios/workflow.test.ts` | Scénarios de bout en bout sur le harnais (22 `it` au départ) | adapter | ORC-169 (chaque scénario réécrit ou marqué abandonné), ORC-225, ORC-228, ORC-187 |
| `test/e2e/pack.e2e.test.ts` | Test du pack avec le vrai `claude` (live, voir plus haut) | adapter | ORC-191 (renommé, `git push` refusé) |

## À trancher

Modules dont aucun ticket MVP ne règle le sort ; le statut ou le ticket est à décider avant le ticket qui les touche en premier :

- `src/adapters/exec.ts` : utilitaire gardé, mais sans ticket cible ; ses appelants changent (ORC-181 retire `gh-cli.ts`, ORC-204 déplace `setup` dans le conteneur).
- `src/adapters/runner/channel.ts` : file du flux d'un `RunHandle` ; gardé tant que le port `Runner` l'est (ORC-204), sans ticket qui le nomme.
- `src/adapters/tracker/activity-relay.ts` : relais de la sortie du run vers la session Linear ; aucun ticket ne dit s'il reste (fil d'activité en direct) ou s'il cède la place au plan de session (ORC-171) et au dashboard (ORC-223).
- `src/app/tracker-switch.ts` : tracker de substitution avant la connexion OAuth ; aucun ticket ne dit s'il survit à la nouvelle mise en route (ORC-208, ORC-222).
