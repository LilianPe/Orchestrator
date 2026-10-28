# Transition : point de départ de Relais

Cette page fige l'état de Relais d'où part le MVP de l'usine, et dit, pour chaque module, ce qu'il devient et quel ticket le touche. Elle sert de référence pour comparer et pour revenir en arrière ; les tickets cibles la font vivre (un ticket qui retire ou transforme un module met à jour sa ligne).

## Commit de référence

| | |
|---|---|
| Commit | `ebc405d` (`ebc405d5f3e3f5a69a4bd2e1b71e5e0d3eb1caaf`), merge de la PR #27, tête de `main` au 21/10 |
| CI sur ce commit | workflow `ci` (`npm ci`, `npm run typecheck`, `npm run lint`, `npm test`) vert : run [38868662643](https://github.com/LilianPe/relais/actions/runs/38868662643) |
| Tag | `relais-v1-final`, annoté, sur ce commit, poussé sur GitHub le 21/10 (commande ci-dessous) |
| Taille de départ | 65 fichiers non test dans `src/`, dont 4 487 lignes de TypeScript |

Commande qui a posé le tag (une fois, par un mainteneur ; ne pas la rejouer) :

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

L'usine évolue à partir de `main`, sans branche longue : chaque incrément est un ticket ORC, sur une branche nommée d'après lui, et arrive par PR vers `main`, jamais par un push direct sur `main`. Le tag `relais-v1-final` garde l'état de départ.

## Données

Aucune migration : `relais.db`, `transcripts/`, `workspaces/` et le dépôt de connaissance repartent de zéro (ORC-178 archive puis supprime les anciens). Depuis ORC-167, l'instance vit dans `~/.factory` (base `factory.db`) : rien n'est relu de `~/.relais`.

## Renommage (ORC-167)

Relais a été renommé d'un bloc, sans changement de comportement : seuls les noms changent.

| Avant | Après |
|---|---|
| paquet `relais`, CLI `relais` (`bin/relais`, `src/cli/relais.ts`) | paquet `factory`, CLI `factory` (`bin/factory`, `src/cli/factory.ts`) ; le démon, lancé par `factory up`, signe ses journaux `[factoryd]` |
| `relais-agent` (`bin/relais-agent`, `src/cli/relais-agent.ts`) | `factory-agent`, nom temporaire jusqu'à son retrait par ORC-192 |
| variables `RELAIS_*` (`RELAIS_HOME`, `RELAIS_UI_PASSWORD`, `RELAIS_API`, `RELAIS_RUN_TOKEN`, `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT`, `RELAIS_E2E`, `RELAIS_ISOLATION`) | `FACTORY_*`, même suffixe ; les anciennes ne sont plus lues, mais restent retirées de l'environnement des runs, pour qu'un secret oublié dans le shell du démon n'atteigne pas les agents (filtre de transition, à retirer) |
| `~/.relais`, `relais.db` | `~/.factory`, `factory.db` (pas de migration, voir « Données ») |
| `.relais/workflow.yml` dans le dépôt | `.factory/workflow.yml` |
| plugin `relais`, skills `relais:<nom>` | plugin `factory`, skills `factory:<nom>` |
| branches `relais/<id>-<slug>` | branches `factory/<id>-<slug>` |
| type `RelaisEvent`, `startRelais`, `relaisHome` | `FactoryEvent`, `startFactory`, `factoryHome` |
| service compose `relais`, `relais-entrypoint`, `relais@localhost` | service `factory`, `factory-entrypoint`, `factory@localhost` |
| dépôt de connaissance créé par `init` : `relais-knowledge` | `factory-knowledge` |

**Nom affiché.** Ce qu'un humain lit (aide et messages de la CLI, titre et en-tête de l'interface, messages publiés dans Linear, realm du mot de passe, nom de l'identité git des commits) vient d'une seule constante, `PRODUCT_NAME` dans `src/product.ts`, aujourd'hui `Orchestrator` (nom de bêta). Le jour du nom définitif, on change cette constante, le nom du dépôt GitHub et les docs ; sur une instance déjà configurée, ce qui a été écrit sous l'ancien nom ne suit pas et se renomme à la main : l'application OAuth Linear, que `init` fait créer sous ce nom et qu'on mentionne avec @, et le titre de l'`INDEX.md` de la base de connaissance. La constante est lue par :

- `src/cli/factory.ts`, `src/cli/init.ts`, `src/cli/factory-agent.ts` (aide, questions et messages, titre de l'`INDEX.md` créé par `init`) ;
- `src/app/bootstrap.ts` (journaux du démon), `src/core/orchestrator.ts` (messages Linear), `src/server/app.ts` (realm HTTP Basic) ;
- `web/src/App.tsx` (en-tête) et `web/vite.config.ts`, qui remplace `%PRODUCT_NAME%` dans le titre de `web/index.html` au build et en dev ;
- le `Dockerfile`, qui écrit l'identité git de l'image depuis `dist/src/product.js` après le build ; `compose.yaml` passe `GIT_AUTHOR_NAME` et `GIT_COMMITTER_NAME` telles quelles depuis le shell, sans défaut : absentes, elles ne sont pas définies dans le conteneur et ce nom s'applique, `docker compose exec` compris. Le committer ne reprend plus `GIT_AUTHOR_NAME` : définissez les deux pour un autre nom. Ne les définissez jamais vides (`GIT_AUTHOR_NAME=` dans `.env` ou le shell) : la valeur vide passe telle quelle et git refuse alors tout commit (« empty ident name ») ; retirez la ligne pour garder le nom de l'image.

Les textes du pack (`packs/standard/`, skills et hook) ne peuvent pas importer la constante : ils disent « l'usine », sans nom propre.

**Occurrences de `relais` qui restent.** Dans les fichiers suivis par git hors de `docs/` et du `README.md` (recherche sans casse), les lignes ci-dessous, vérifiées par `src/product.test.ts` ; les lignes de transition portent la marque « transition, à retirer », que le test accepte :

| Où | Pourquoi |
|---|---|
| `src/product.test.ts` | le motif `/relais/i` que le test cherche dans ces fichiers ; il échoue si l'ancien nom revient ailleurs sur une ligne sans la marque |
| `src/adapters/runner/claude-code.ts` (`DAEMON_ONLY`) et son test | le préfixe `RELAIS_` encore filtré de l'environnement des runs ; transition, à retirer quand plus aucune instance n'a d'ancienne variable |

Dans `docs/` et le `README.md`, l'ancien nom reste là où il est juste : les URL du dépôt GitHub `LilianPe/relais` (non renommé), le tag `relais-v1-final` et l'état de départ décrit sur cette page, et les autres pages de `docs/` et le `README.md`, qui décrivent encore l'état de départ et sont réécrites ticket par ticket (ORC-202).

## Tests live, hors CI

Quatre tests parlent à de vrais services. Ils sont dans le glob de `vitest.config.ts`, mais se sautent eux-mêmes quand leur variable manque, et la CI (`.github/workflows/ci.yml`) n'en définit aucune :

| Test | Condition qui le lance | Sinon |
|---|---|---|
| `src/adapters/tracker/linear/queries.live.test.ts` | `LINEAR_API_KEY` définie (`describe.skipIf(!key)`) | sauté |
| `src/adapters/tracker/linear/tracker.live.test.ts` | `FACTORY_LIVE_LINEAR_TOKEN` et `FACTORY_LIVE_LINEAR_ISSUE` définies (ORC-189, suite de conformité Tracker, lecture seule) | sauté |
| `src/adapters/forge/gh-cli.live.test.ts` | `FACTORY_LIVE_GH_REPO`, `FACTORY_LIVE_GH_BRANCH` et `FACTORY_LIVE_GH_PR` définies (ORC-189, suite de conformité Forge, lecture seule) | sauté |
| `test/e2e/pack.e2e.test.ts` | `FACTORY_E2E=1` (`describe.skipIf(process.env['FACTORY_E2E'] !== '1')`, `RELAIS_E2E` avant ORC-167) | sauté |

Sur le run de référence, avant ORC-189, le journal de la CI montre `queries.live.test.ts` et `pack.e2e.test.ts` « 1 skipped » (40 fichiers passés, 2 sautés, 250 tests passés, 2 sautés). Un ticket qui ajoute un test live suit la même règle : une variable d'environnement le lance, la CI ne la définit pas.

## Inventaire des modules

Statuts de départ :

- **garder** : le module reste tel quel ou presque ; le ticket cité s'appuie dessus.
- **adapter** : le module reste, mais le ticket cité le transforme.
- **retirer** : le module disparaît ; le ticket cité le remplace ou le retire.
- **à trancher** : aucun ticket ne règle clairement son sort (voir la dernière section).

Le premier ticket cité est celui qui touche le module en premier ou le plus ; les suivants le touchent aussi. `src/docs-transition.test.ts` vérifie que chaque fichier non test de `src/` a une ligne, que chaque ligne (dans `src/` ou non) a un des quatre statuts, que chaque chemin cité existe et n'est cité qu'une fois, et que la section « À trancher » liste exactement les lignes de ce statut.

### `src/core/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/core/engine.ts` | `decide(état, événement, wf)` pure : règles `on` du YAML et cas codés → `{events, effects, timers, trace}` ; résultat d'un effet `effect.done` (rien) ou `effect.failed` (ticket bloqué, ORC-150) ; `dead_letter.added` (ticket bloqué, message qui nomme l'événement) et `dead_letter.repaired` (bloc levé, événement rejoué ou non, ORC-175) | adapter | ORC-133 (fait : signature, fencing, taint : refus des jobs `knowledge`, `sensitivePaths` sur `start_run`), ORC-269 (fait : taint des retours en attente, tout `start_run` passe par la règle de taint), ORC-270 (fait : relances sur CI rouge bornées par `limits.ci_fix_attempts`, provisoire), ORC-274 (fait : `sensitivePathsAtLaunch`, taint au lancement), ORC-134 (fait : `pr.closed` annule le travail, `pr.reviewed` et `pr.conflicted` tracés sans réaction), ORC-175 (fait : dead-letter et réparation), ORC-196 (commentaire de blocage standard), ORC-187 (préréglage), ORC-169 (règles `on` retirées) |
| `src/core/reduce.ts` | `reduce(état, événement)` pure : seul endroit qui change l'état d'un ticket ; une réparation lève le bloc de son événement puis applique ses faits (ORC-175) | garder | ORC-133, ORC-149 (worker), ORC-173 (propriétés), ORC-175 (fait : `dead_letter.repaired`) |
| `src/core/dead-letter.ts` | Dead-letter (ORC-175) : raison de blocage qui nomme l'événement, événements `dead_letter.added` et `dead_letter.repaired` (ids `dead-letter:<id>:<n>`, `repair:<id>:<n>`), type `DeadLetter`, actions `replay`, `skip`, `force`, `effectiveEvent` (l'événement qu'une réparation rejoue ou force, lu par `planDecision`) | garder | ORC-175, ORC-196 (gabarit du commentaire de blocage) |
| `src/core/upcast.ts` | `upcast` : relit un événement du journal écrit par une version antérieure (`schemaVersion`) ; `upcastTimer` : relit un timer d'avant ORC-161 (lié à un job) comme un `debounce` | garder | ORC-133, ORC-174 (fait : l'oracle de rejeu passe chaque ligne par `upcast`), ORC-161 (fait : version 3, `debounce.fired` devenu `timer.fired`) |
| `src/core/decision-plan.ts` | `planDecision` pure : ce qu'écrit la transaction de décision d'un événement (projection, effets, minuteries, `settle`), depuis la projection, l'événement, le workflow figé et l'horloge ; appelée par l'orchestrateur et par l'oracle de rejeu ; une réparation qui rejoue ou force un événement est planifiée comme lui (ORC-175) | garder | ORC-174 (fait : extraite de l'orchestrateur), ORC-175 (fait : `effectiveEvent`), ORC-150 (`settle` passe dans `decide`), ORC-187 (préréglage) |
| `src/core/orchestrator.ts` | Files, runs, vérifications, blocages, reprise ; construit la transaction de décision du worker (son plan : `planDecision`, ORC-174), exécute les effets de l'outbox, change l'état par `reduce` (ORC-133) | retirer | ORC-133 (`reduce` extrait), ORC-147 (fait : `accept` écrit l'inbox, événements traités depuis l'inbox, rejeu au démarrage), ORC-149 (fait : chaîne en mémoire, `submit` et `idle` retirés au profit du worker), ORC-150 (fait : effets par l'exécuteur d'outbox, `failTicket` remplacé par `effect.failed` décidé ; reste : un exécuteur par port, `Scheduler` en limite de réclamation), ORC-274 (fait : chemins sensibles calculés au lancement sur les retours lus, commentaires de review non fiables, portés jusqu'au run et au runner), ORC-228 (fait : `poll`, un passage du worker pour une horloge simulée), ORC-220 (`recover`), retrait final ORC-169 |
| `src/core/bus.ts` | Chaîne d'événements en mémoire (`EventBus`, aussi source du SSE) | retirer | ORC-169 (ORC-223 garde le flux SSE du dashboard) |
| `src/core/scheduler.ts` | Places `dev` et `questions` en mémoire ; un départ est tiré de la file `queue` sous bail jusqu'à l'écriture du run (ORC-150) | retirer | ORC-169 (ORC-182 garde un emplacement à part pour les questions) |
| `src/core/decision.ts` | Type `Decision` de `decide` : `Effect` (ex-`Command` côté externe), `Timer` générique `{kind, slot, ms, payload}` (ex-`set_debounce`, ORC-161) ; remplace `commands.ts` (ORC-133) ; `OutboxEffect` (un effet, ou `settle`) écrit dans l'outbox (ORC-149) | garder | ORC-133, ORC-161 (fait : timer générique), ORC-162 (effets idempotents), ORC-150 (`settle` passe dans `decide`) |
| `src/core/attempt-labels.ts` | Étiquettes d'une tentative à sa création : job, file, modèle, version et commit de l'usine, empreintes sha256 du prompt, des skills, du workflow et de la config ; champs sans source encore à `null` avec le ticket qui les remplira | garder | ORC-226 (fait), ORC-203 (commit de l'usine), ORC-136/ORC-187 (effort), ORC-204 (image), ORC-206 (risque), ORC-257 (registre, faits livrés), ORC-232 (index de connaissances) |
| `src/core/conditions.ts` | Mini-langage `when` | retirer | ORC-177 |
| `src/core/verify.ts` | `runVerify` : commandes `bash -lc` dans le worktree de l'agent | adapter | ORC-151 (sandbox neuf, SHA figé), ORC-179 (plus dans le worktree) |
| `src/core/prompt.ts` | Prompt texte d'un run (skill, ticket, branche, PR, échecs de vérif) | adapter | ORC-136 (pistes d'`intake`), ORC-151 (logs tronqués), ORC-182 (entrées de l'agent de réponse) |
| `src/core/pickup.ts` | Contrôles avant prise (description, branche poussée, critères) | adapter | ORC-206 (garde avant In Progress) ; reste en place jusque-là (ORC-169) |
| `src/core/naming.ts` | `slugify`, `branchName` (`factory/<id>-<slug>`) | adapter | ORC-167 (préfixe), ORC-136 et ORC-204 (`branchName` de Linear) |
| `src/core/clock.ts` | `Clock`, `SystemClock`, `FakeClock` | garder | ORC-225, ORC-161 |
| `src/core/duration.ts` | `parseDuration` (`3m`, `90m`…) | garder | ORC-177 (gardé si `factory.yml` garde des durées en texte) |
| `src/core/measures.ts` | Mesures du doc MVP calculées depuis les faits de la base (journal, tentatives, outbox, accusés de réception), jamais depuis le texte d'un agent : tokens, premier essai, délais de signe de vie et de réponse ; mesures sans source encore à `null` avec le ticket qui l'apportera | garder | ORC-235 (fait), ORC-223 (affichage), ORC-216 (limite d'usage), ORC-190 (relecture humaine ; reverts et coût de CI sans ticket encore), ORC-160/ORC-180 (accusé de réception en effet d'outbox) |
| `src/core/types.ts` | `FactoryEvent` (`schemaVersion`, taint), `TicketState`, 6 états logiques ; événements `effect.done` et `effect.failed` (ORC-150), `pr.reviewed` et `pr.conflicted` (ORC-134), `dead_letter.added` et `dead_letter.repaired` (ORC-175) ; `timer.fired` et les sortes de timer `TimerPayloads` (ORC-161, schéma version 3) | adapter | ORC-133 (fait : `schemaVersion`, champ taint, renommages), ORC-161 (fait : `timer.fired`), ORC-269 (fait : taint de `FeedbackItem`), ORC-160 (taint posé à l'ingestion, acteur), ORC-180 (`humanInbox`), ORC-187 (états retirés) |

### `src/runtime/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/runtime/worker.ts` | Worker de l'inbox : une tâche par ticket, transaction de décision du store par événement, effets de l'outbox confiés à l'exécuteur après le commit ; ligne dont la préparation ou la transaction échoue (tracker, base) retentée 5 fois (reprise telle que lue : une transaction validée dont la réponse s'est perdue libère les lignes derrière elle) puis gardée pour le démarrage suivant, ligne dont la décision lève (`decide`, `reduce`, upcast) mise en dead-letter sans nouvel essai ; `poll` fait un passage de sa boucle, attendu | garder | ORC-149, ORC-150 (fait : exécuteur d'outbox), ORC-175 (fait : dead-letter), ORC-228 (fait : `poll` pour le harnais), ORC-163 (fait : reprise d'une ligne validée sans réponse) |
| `src/runtime/outbox.ts` | Exécuteur d'outbox : réclamation sous bail renouvelé et jeton, backoff `1 s × 2^(essai − 1)` plafonné à 5 min, ligne `dead` au 8e essai, résultat `effect:<id>` écrit dans l'inbox avec la ligne | garder | ORC-150, ORC-162 (idempotence par effet), un exécuteur par port (Tracker, Forge, AgentRuntime…) à venir |
| `src/runtime/replay.ts` | Oracle de rejeu : export du journal d'un ticket avec ses décisions enregistrées, rejeu par les upcasters puis `planDecision`, comparaison bit à bit (régression) ou arrêt à la première divergence sur un autre workflow (what-if) | garder | ORC-174 (fait), ORC-231 (rejeu des tickets fermés avec l'agent) |
| `src/runtime/timers.ts` | `TimerService` : relève les timers échus de la table `timers` et les déclenche par `Store.fireTimer` (`timer:<clé>:<échéance>` dans l'inbox et timer supprimé, une transaction) ; une minuterie qui échoue ne retient pas les autres ; rien en mémoire, un redémarrage n'en perd aucun | garder | ORC-161 (fait), ORC-210 (relance `clarify` à 24 h, Bloqué à 72 h), ORC-215 (attente sur limite d'usage), ORC-185 (réconciliation planifiée par timer) |
| `src/runtime/workflow-version.ts` | Hash sha256 du workflow (JSON canonique, aussi la forme que compare le rejeu) : la version figée d'un ticket | garder | ORC-149, ORC-187 (préréglage en TypeScript) |

### `src/adapters/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/adapters/exec.ts` | `execCmd`, `mustExec` : sous-processus utilisé par git, `gh`, la base de connaissance, la CLI | garder | ORC-124 (son usage pour `gh` part avec la GitHub App ; git en garde besoin) |
| `src/adapters/forge/types.ts` | Port `Forge` | adapter | ORC-181 (port gardé, nouvelles opérations), ORC-124 |
| `src/adapters/forge/fake.ts` | `FakeForge` | adapter | ORC-181, ORC-225 |
| `src/adapters/forge/gh-cli.ts` | Forge par la CLI `gh` | retirer | ORC-181 (après ORC-124, GitHub App) |
| `src/adapters/forge/github-app.ts` | Forge GitHub App : JWT RS256, jeton d'installation limité au dépôt, PR/checks/reviews en REST et GraphQL | garder | ORC-124 (remplace `gh-cli` après ORC-125), ORC-135 (authentification partagée) |
| `src/adapters/forge/github-app-api.ts` | Lectures GitHub App de `factory doctor` : workflows et environnements protégés | garder | ORC-135 |
| `src/adapters/forge/pr-poller.ts` | Relevé des PR toutes les 30 s ; verdict de CI nommé par la tête de la PR, comme le webhook | retirer | ORC-181, remplacé par ORC-134 (fait : webhooks, gardé à côté) et ORC-185 (réconciliation) |
| `src/adapters/forge/github-webhook.ts` | Webhook GitHub : signature `X-Hub-Signature-256`, `mapGithubWebhook` (PR mergée ou fermée, CI, conflit, push humain, review) par la branche du ticket, ids tirés du corps signé | garder | ORC-134 (fait), ORC-146 (conflits), ORC-159 (`push.human`), ORC-190 (reviews), ORC-222 (durcissement) |
| `src/adapters/forge/github-ingest.ts` | Ingestion du webhook GitHub : inbox écrite avant la réponse (401 non signé, 500 écriture échouée) ; rattachement au ticket par branche et dépôt `origin` du projet | garder | ORC-134 (fait), ORC-221 (exposition derrière caddy) |
| `src/adapters/runner/types.ts` | Port `Runner`, `RunHandle`, `RunRequest` (`sensitivePaths` porté, pas encore appliqué, ORC-274) ; `RunResult.tokens`, usage rendu par le runtime (ORC-235) | garder | ORC-204 (port gardé, application des chemins sensibles), ORC-189 (devient AgentRuntime) |
| `src/adapters/runner/claude-code.ts` | `ClaudeCodeRunner` : `claude -p` en sous-processus sur l'hôte, transcripts masqués à l'écriture | adapter | ORC-136, ORC-204 (dans le runner isolé), ORC-205 (réglages imposés), ORC-217 (session sur volume), ORC-194 (`--max-budget-usd`), ORC-167 |
| `src/adapters/runner/transcript.ts` | Masquage des secrets dans les transcripts, rétention de 30 jours et purge | garder | ORC-132 (suit les transcripts dans le runner isolé, ORC-204) |
| `src/adapters/runner/stream-parser.ts` | Lecture du stream-json de Claude Code ; `usage` de la ligne `result` en tokens (ORC-235) | adapter | ORC-235 (fait : usage en tokens), ORC-136, gardé par ORC-204 |
| `src/adapters/runner/channel.ts` | File asynchrone qui porte le flux d'un `RunHandle` | garder | ORC-204 (suit le port `Runner`) |
| `src/adapters/runner/fake.ts` | `FakeRunner` du harnais | garder | ORC-204, ORC-225 |
| `src/adapters/runner/fixtures/` | Données de test : faux `claude` et flux stream-json | garder | ORC-136 (suivent le runner) |
| `src/adapters/tracker/types.ts` | Port `Tracker`, `ActivityInput` | adapter | ORC-160 (id d'effet), ORC-171 (plan dans la session) |
| `src/adapters/tracker/fake.ts` | `FakeTracker` | garder | ORC-160, ORC-225 |
| `src/adapters/tracker/activity-relay.ts` | Relaie la sortie d'un run en activités de la session Linear, avec un débit plafonné | adapter | ORC-171 |
| `src/adapters/tracker/linear/api.ts` | `LinearApi` : client GraphQL | garder | ORC-160 |
| `src/adapters/tracker/linear/queries.ts` | Documents GraphQL | adapter | ORC-160 (marqueur de commentaire), ORC-171 (`agentSessionUpdate` avec plan) |
| `src/adapters/tracker/linear/tracker.ts` | `LinearTracker` (cache, `ensureSetup`) | adapter | ORC-160 (commentaires et labels idempotents), ORC-201 (plus de « Ready to Merge » ni `agent:*`), ORC-170 |
| `src/adapters/tracker/linear/webhook.ts` | Signature, fraîcheur, `deliveryKey`, `mapLinearWebhook` | adapter | ORC-160 (`status.changed`, `label.changed`, taint), ORC-147, ORC-171 |
| `src/adapters/tracker/linear/ingest.ts` | Ingestion : vérifie, écrit dans l'inbox (dédoublonnage par id en base), ack (son heure enregistrée sur la ligne d'inbox, ORC-235), puis répond | adapter | ORC-147 (fait : inbox écrite avant la réponse, 500 si l'écriture échoue), ORC-235 (fait : heure de l'ack), ORC-160 (ack en effet d'outbox, taint) |
| `src/adapters/tracker/linear/reconcile.ts` | Réconciliation Linear toutes les 30 s | adapter | ORC-185 (5 min, timer en base, inbox) |
| `src/adapters/tracker/linear/oauth.ts` | OAuth Linear, jetons rafraîchis écrits dans `secrets.json` | adapter | ORC-222 (secrets scellés), ORC-199 (`secrets.json` retiré) |
| `src/adapters/tracker/linear/fixtures/` | Données de test : webhooks Linear | garder | ORC-160 (suivent `webhook.ts`) |
| `src/adapters/workspace/types.ts` | Port `WorkspaceManager` | adapter | ORC-189 (devient SandboxProvider), ORC-204 |
| `src/adapters/workspace/git-workspaces.ts` | Worktrees par ticket sur l'hôte, `_trunk`, `_kb`, ports, `setup` | adapter | ORC-179 (base du miroir et des clones neufs, ou retiré), ORC-204 (`branchName`, `setup` dans le conteneur), ORC-193 (`_kb`) |
| `src/adapters/workspace/fake.ts` | `FakeWorkspaces` | adapter | ORC-189 (suit son port vers `SandboxProvider`, dont ORC-225 a posé le faux à côté), ORC-204 |
| `src/adapters/sandbox/types.ts` | Port `SandboxProvider`, niveaux réseau | garder | ORC-225, ORC-189 |
| `src/adapters/sandbox/fake.ts` | `FakeSandboxProvider` du harnais | garder | ORC-225 |
| `src/adapters/publisher/types.ts` | Port `Publisher` : pousse le sha vérifié, ouvre ou met à jour la PR | garder | ORC-225 |
| `src/adapters/publisher/fake.ts` | `FakePublisher` du harnais | garder | ORC-225 |
| `src/adapters/checks/types.ts` | Port `CheckRunner` : vérifications hors de l'agent | garder | ORC-225, ORC-151 |
| `src/adapters/checks/fake.ts` | `FakeCheckRunner` du harnais | garder | ORC-225 |

### `src/checks/`

Contrôles déterministes de `verify`, purs : ils lisent le diff `baseSha..SHA` (ou le contenu des manifestes avant et après) et rendent le résultat d'un check `factory/...`. Ils ne sont pas encore branchés : `verify` en clone neuf sur SHA figé arrive avec ORC-151.

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/checks/types.ts` | `CheckResult` : nom du check (`check`), succès ou échec, résumé publié sur la PR | garder | ORC-158, ORC-151 (publication des checks), ORC-145, ORC-131 |
| `src/checks/diff.ts` | `parseDiff` : fichiers du diff unifié, lignes ajoutées numérotées, lignes retirées comptées | garder | ORC-158, ORC-145 (taille du diff), ORC-123 (tests ajoutés), ORC-131 |
| `src/checks/test-files.ts` | Règle unique « fichier de test » (TS/JS et Python) et fichiers du harnais de test | garder | ORC-158, ORC-145 (lignes hors tests), ORC-123 (étape `tests`), ORC-131 (gel) |
| `src/checks/anti-cheat.ts` | Scan des lignes ajoutées contre les quatre formes de triche, check `factory/anti-triche` | garder | ORC-158, ORC-151 (branché dans `verify`), ORC-131 (empreintes des tests gelés), ORC-225 (scénario « `.skip` ajouté ») |
| `src/checks/diff-size.ts` | Contrôle `factory/taille-du-diff` : fichiers et lignes ajoutées + retirées hors tests et hors fichiers générés (verrouillage, instantanés drizzle-kit), comparés à `max_diff` (socle 15 fichiers, 400 lignes ; la configuration du dépôt ne peut que resserrer) ; au-delà, bloquant, avec une proposition de découpage et une question | garder | ORC-145, ORC-151 (appelé par `verify`), ORC-125 (pas de `publish` au-delà), ORC-209 (`max_diff` lu dans `.factory/config.yml`), ORC-196 (commentaire de blocage), ORC-142 (seuils mesurés) |
| `src/checks/markdown.ts` | `mdCode` : texte écrit par l'agent (chemin, ligne trouvée) cité en code dans le résumé d'un check, caractères de contrôle neutralisés | garder | ORC-145, ORC-158 |
| `src/checks/deps.ts` | Contrôle `factory/dependances` : dépendances ajoutées (npm, PyPI) lues dans le contenu avant et après des manifestes, existence au registre et liste autorisée, bloquant ; liste des ajouts pour le journal de sécurité | garder | ORC-165, ORC-151 (appelé par `verify`), ORC-209 (liste autorisée dans `.factory/config.yml`), ORC-223 (journal de sécurité) |
| `src/checks/registry.ts` | `PackageRegistry`, `HttpPackageRegistry` : registre npm et API JSON de PyPI, `fetch` et URL de base injectables | garder | ORC-165, ORC-213 (requêtes par le proxy de sortie) |
| `src/checks/fake-registry.ts` | `FakePackageRegistry` des tests | garder | ORC-165 |
| `src/checks/toml.ts` | Lecteur TOML minimal, pour `pyproject.toml` | garder | ORC-165, ORC-172 (Python) |

### `src/app/` et racine de `src/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/app/bootstrap.ts` | Câblage du démon (store, adaptateurs, orchestrateur, serveur, variables `FACTORY_*`) | adapter | ORC-147 (fait : toutes les sources écrivent dans l'inbox, rejeu au démarrage), ORC-149 (fait : worker démarré avec relève toutes les secondes), ORC-167, ORC-179 (`PORT`), ORC-192, ORC-201, câblage restant retiré par ORC-169 |
| `src/app/root.ts` | Trouve la racine du dépôt par le `package.json` nommé `factory` | adapter | ORC-167 (le renommage du paquet le casse, le ticket ne le nomme pas) |
| `src/app/tracker-switch.ts` | `Tracker` de substitution tant que Linear n'est pas connecté par OAuth | garder | ORC-208 |
| `src/version.ts` | Version du paquet | garder | ORC-167 |
| `src/product.ts` | `PRODUCT_NAME`, seule source du nom affiché (ses lecteurs : « Nom affiché », plus haut) | garder | ORC-167 (nom définitif : voir « Nom affiché ») |

### `src/store/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/store/types.ts` | Port `Store` asynchrone, servi par `SqliteStore` et `PgStore` ; transaction de décision, outbox des décisions et versions de workflow (ORC-149) ; réclamation, nouvel essai, mort et résultat `effect:<id>` d'un effet, file `queue` sous bail (ORC-150) ; décision enregistrée dans sa transaction, `ticketJournal` (ORC-174) ; dead-letter d'une ligne, liste et réparation (`deadLetter`, `deadLetters`, `getDeadLetter`, `repairDeadLetter`, ORC-175) ; timer générique `TimerRecord`, `fireTimer` : événement (`timerEvent`) dans l'inbox et timer supprimé dans une transaction (ORC-161) ; faits des mesures (`measureFacts`) et heure d'accusé de réception (`markAcked`, ORC-235) | adapter | ORC-178 (`queue`, `echoes`, `costSince` retirés) |
| `src/store/open.ts` | Choix du store au démarrage : `PgStore` et migrations quand `FACTORY_DATABASE_URL` est défini, `SqliteStore` sinon | adapter | ORC-178 (plus que Postgres) |
| `src/store/sqlite-store.ts` | `SqliteStore` sur `node:sqlite`, derrière le port asynchrone ; table `dead_letter`, équivalent de celle de Postgres (ORC-175) ; son horloge injectable vaut pour les baux, backoffs et lignes échues comme pour l'inbox, comme celle de `PgStore` (ORC-228) | retirer | retrait ORC-178 |
| `src/store/pg/schema.ts` | Schéma Drizzle des 12 tables du moteur ; `dead_letter` complétée (ticket, statut, échecs, auteur de la réparation : migration `0002_dead_letter_repair`, ORC-175) ; tokens des tentatives et `inbox.acked_at` (migration `0003_measures`, ORC-235) | garder | ORC-132, ORC-175, ORC-235 |
| `src/store/pg/types.ts` | `AsyncStore` (le port `Store` plus la réclamation brute d'une ligne de file, `claim`) et `DequeuedEffect` | garder | ORC-132, ORC-178 (`queue` retirée) |
| `src/store/pg/pg-store.ts` | `PgStore` sur Postgres, store du démon quand `FACTORY_DATABASE_URL` est défini ; `fireTimer` sous le verrou du ticket (ORC-161) ; la file départage deux éléments de même instant par leur arrivée (`created_at` à `clock_timestamp()`), pas par leur id (ORC-228) | garder | ORC-132, ORC-161 (fait), ORC-228 (fait) |
| `src/store/pg/migrate.ts` | Application des migrations Drizzle | garder | ORC-132 |

### `src/config/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/config/instance.ts` | `config.yaml` et `secrets.json` de l'instance (zod) | adapter | ORC-209 (`factory.yml`), ORC-199 (`config.yaml` et `secrets.json` retirés), ORC-194 (`perDayUsd`), ORC-167 (`RELAIS_HOME`) |
| `src/config/github-app.ts` | Résolution de la GitHub App (PEM ou chemin, repli `GH_APP_*`) et du secret des webhooks GitHub (repli `GH_WEBHOOK_SECRET`, ORC-134) | garder | ORC-124 (cible `factory.yml`, ORC-209) |
| `src/config/load-workflow.ts` | Fusion pack + `.factory/workflow.yml` | retirer | ORC-177 (remplacé par ORC-187 et ORC-209) |
| `src/config/workflow-schema.ts` | Schéma zod de `workflow.yml` | retirer | ORC-177 |
| `src/config/run-settings.ts` | `run-settings.json` : refus de lecture sur `FACTORY_HOME` | retirer | ORC-179, ORC-199 |

### `src/server/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/server/app.ts` | API Hono : interface, SSE, webhook Linear, `/agent/*`, pause/resume, mot de passe, CSRF | adapter | ORC-147 (fait : webhook et commandes de l'interface attendent l'écriture de l'inbox), ORC-192 (`/agent/*` retiré), ORC-200 (pause/resume retirés), ORC-223 (API du dashboard), ORC-222 (authentification nominative), ORC-134 (fait : `POST /webhooks/github`) |
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
| `src/cli/factory.ts` | CLI `factory` : `init`, `doctor`, `up`, `plan`, `status`, `pause`, `resume`, `stop`, `replay`, `run repair` | adapter | ORC-167 (`factory`), ORC-135 (`doctor`), ORC-174 (`replay`), ORC-175 (`run repair`), ORC-200 (`plan`, `pause`, `resume`, `--fake-runner` retirés), ORC-220 (`status`, `stop`) |
| `src/cli/doctor.ts` | `factory doctor` : refuse un dépôt dont la CI peut exposer des secrets aux branches `factory/*` sans approbation humaine | adapter | ORC-135, ORC-208 (intégration à `init`) |
| `src/cli/init.ts` | Assistant `init` (app OAuth, smee, base de connaissance, `.factory/workflow.yml`) | adapter | ORC-208 (GitHub App, `factory.yml`, détection), ORC-177, ORC-193, ORC-200 |
| `src/cli/replay.ts` | `factory replay` : rejoue des journaux exportés (régression bit à bit, `--what-if`), `--export` d'un ticket de l'instance | garder | ORC-174 (fait) |
| `src/cli/plan.ts` | `factory plan` : tickets délégués qui seraient pris | retirer | ORC-200 |
| `src/cli/repair.ts` | `factory run repair <ticket>` : liste les événements mis de côté d'un ticket, en rejoue, ignore ou force un, écrit dans le store (statut, événement `dead_letter.repaired` journalisé), sans démon | garder | ORC-175 |
| `src/cli/factory-agent.ts` | CLI de l'agent (`factory-agent`, nom temporaire) : `issue`, `search`, `kb search`, `ask` | retirer | ORC-192 (MCP de l'usine) |

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
| `packs/standard/.claude-plugin/plugin.json` | Plugin `factory` | adapter | ORC-167 (nom), ORC-191 |
| `packs/standard/hooks/hooks.json`, `packs/standard/hooks/session-start.mjs` | Hook de démarrage : règles, méthode, index de la base | adapter | ORC-191 (plus de `FACTORY_*` ni `factory-agent`), ORC-232 (index injecté par le `systemPrompt`), ORC-205 |
| `packs/standard/skills/{dev,feedback,review,ask}/` | Skills de job | adapter | ORC-191 (une consigne par étape, fin par `submit_result`), ORC-187 |
| `packs/standard/skills/{fix-ci,learn}/` | Skills de job sans équivalent au MVP | retirer | ORC-191, ORC-193 (`learn`) |
| `packs/standard/skills/{tdd,debugging,verification,code-review,receiving-review}/` | Skills de méthode | garder | ORC-191 (relus pour retirer push et CI) |
| `packs/standard/NOTICE.md` | Mention de licence (superpowers, MIT) | garder | ORC-191 |

### `test/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `test/helpers/harness.ts` | `createHarness` : faux adaptateurs, `FakeClock` lue aussi par le store, une base par harnais (SQLite en mémoire, Postgres dans `scenarios-pg`) ou le store passé, `wrapStore`, `send`, `advance` (minuteries en base, passage du worker), `restart` propre ou brutal (`mortal`, store et adaptateurs coupés), `faults` (points de coupure) | adapter | ORC-225 (nouveaux faux, préréglage de test), ORC-228 (fait : Postgres, worker, outbox, minuteries en base, redémarrage brutal), ORC-149 (fait : `drained()`, inbox et outbox vides, remplace `idle`), ORC-163 (fait : points de coupure, adaptateurs d'un processus mort coupés) |
| `test/helpers/pg-harness.ts` | Setup du projet `scenarios-pg` : une base Postgres par harnais, clonée d'un modèle migré, supprimée après chaque test | garder | ORC-228 |
| `test/scenarios/restart.test.ts` | Redémarrage brutal en plein traitement, sur les deux stores | garder | ORC-228, ORC-163 |
| `test/helpers/faults.ts`, `test/scenarios/faults.test.ts` | Points de coupure le long de la chaîne (store, faux tracker, faux runner), registre des appels visibles par ligne d'outbox, vérificateur `checkChain` (aucune perte, aucun doublon visible, journal rejoué par l'oracle) ; un test par point, en `throw` et en `kill` | garder | ORC-163, ORC-162 (le `it.fails` du `post_output` refait passe en `it`) |
| `test/chaos/` | Chaos : un vrai démon tué par SIGKILL au hasard pendant 500 événements, sur Postgres (job CI `chaos`) | garder | ORC-163, ORC-162 (`CHAOS_STRICT_EFFECTS=1` par défaut une fois les effets idempotents) |
| `test/scenarios/workflow.test.ts` | Scénarios de bout en bout sur le harnais (22 `it` au départ) | adapter | ORC-169 (chaque scénario réécrit ou marqué abandonné), ORC-225, ORC-228, ORC-187 |
| `test/replay/` | Journaux enregistrés (`journals/`, format de `factory replay --export`) que la CI rejoue, scénarios du harnais qui les produisent (`npm run replay:record`) | garder | ORC-174 (fait : journaux tirés des scénarios), journaux réels exportés d'une instance à ajouter dès qu'une instance tourne sur le moteur (ORC-233) |
| `test/e2e/pack.e2e.test.ts` | Test du pack avec le vrai `claude` (live, voir plus haut) | adapter | ORC-191 (renommé, `git push` refusé) |

## À trancher

Modules dont aucun ticket MVP ne règle le sort ; le statut ou le ticket est à décider avant le ticket qui les touche en premier :

aucun.
