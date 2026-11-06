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
| service compose `relais`, `relais-entrypoint`, `relais@localhost` | service `factoryd` (ORC-203), `factory-entrypoint`, `factory@localhost` |
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
| `src/core/agent-output.ts` | Schéma zod de la sortie de l'agent (`submit_result`), issues fermées `AttemptOutcome` et leur correspondance avec la fin du runner | garder | ORC-287 (fait), ORC-288 (MCP), ORC-289 (fait : lue par le moteur et le message posté) |
| `src/core/authz.ts` | Matrice d'autorisations action × rôle × canal, pure : `allowed(action, acteur, ticket, matrice, rôles)`, `DEFAULT_MATRIX` (six lignes du doc MVP), message de refus | garder | ORC-186 (fait), ORC-187 (la matrice par défaut passe dans le préréglage `factory/default`), ORC-212 (validation de spec branchée), ORC-131 (`/refreeze` branché), ORC-148 (Done → merge branché) |
| `src/core/engine.ts` | `decide(état, événement, wf)` pure : règles `on` du YAML et cas codés → `{events, effects, timers, trace}` ; résultat d'un effet `effect.done` (rien ; un doublon `deduplicated` tracé, ORC-162) ou `effect.failed` (ticket bloqué, ORC-150) ; `dead_letter.added` (ticket bloqué, message qui nomme l'événement) et `dead_letter.repaired` (bloc levé, événement rejoué ou non, ORC-175) | adapter | ORC-162 (fait : trace des doublons), ORC-133 (fait : signature, fencing, taint : refus des jobs `knowledge`, `sensitivePaths` sur `start_run`), ORC-269 (fait : taint des retours en attente, tout `start_run` passe par la règle de taint), ORC-270 (fait : relances sur CI rouge bornées par `limits.ci_fix_attempts`, provisoire), ORC-274 (fait : `sensitivePathsAtLaunch`, taint au lancement), ORC-134 (fait : `pr.closed` annule le travail, `pr.reviewed` et `pr.conflicted` tracés sans réaction), ORC-278 (fait : `default_branch.pushed` et `ci.run_completed` tracés sans réaction, pour les mesures), ORC-175 (fait : dead-letter et réparation), ORC-196 (commentaire de blocage standard), ORC-186 (fait : matrice vérifiée sur l'acteur signé et les rôles journalisés avec l'événement, avant le déclenchement, la réponse, la relance ; refus répondu par l'outbox), ORC-187 (préréglage), ORC-289 (fait : `run.finished` d'un job dev décidé sur son `attempt` : `needs_input` et `spec_impossible` bloquent avec la question ou la justification, `errored` bloque sur l'infrastructure sans run de correction ; un succès sans sortie reste un succès tant que le job n'est pas `structured_output`, provisoire jusqu'à ORC-191/ORC-192), ORC-169 (règles `on` retirées), ORC-123 (fait : contrôle `red` d'un job `red`, décidé sur `verify.passed`/`verify.failed` ; mode mesure tracé « aurait bloqué » sans bloquer, mode bloquant borné par le compteur `red`, panne bloquante sans relance ; `on_success.run` enchaîne `tests` puis `dev`), ORC-180 (fait : message classé gardé dans `humanInbox`, accusé, `/status` et `/stop`, regroupement sans relance, remise en fin de travail) |
| `src/core/reduce.ts` | `reduce(état, événement)` pure : seul endroit qui change l'état d'un ticket ; une réparation lève le bloc de son événement puis applique ses faits (ORC-175) | garder | ORC-133, ORC-149 (worker), ORC-173 (propriétés), ORC-175 (fait : `dead_letter.repaired`), ORC-180 (fait : `humanInbox`) |
| `src/core/dead-letter.ts` | Dead-letter (ORC-175) : raison de blocage qui nomme l'événement, événements `dead_letter.added` et `dead_letter.repaired` (ids `dead-letter:<id>:<n>`, `repair:<id>:<n>`), type `DeadLetter`, actions `replay`, `skip`, `force`, `effectiveEvent` (l'événement qu'une réparation rejoue ou force, lu par `planDecision`) ; `heldMessage` et la notice d'un événement refusé, adressée au projet qui tient le ticket (ORC-316) | garder | ORC-175, ORC-196 (gabarit du commentaire de blocage), ORC-316 |
| `src/core/upcast.ts` | `upcast` : relit un événement du journal écrit par une version antérieure (`schemaVersion`) ; `upcastTimer` : relit un timer d'avant ORC-161 (lié à un job) comme un `debounce` ; garde l'`actor` d'une ligne | garder | ORC-133, ORC-174 (fait : l'oracle de rejeu passe chaque ligne par `upcast`), ORC-161 (fait : version 3, `debounce.fired` devenu `timer.fired`), ORC-160 (fait : `actor` facultatif, sans changement de version) |
| `src/core/decision-plan.ts` | `planDecision` pure : ce qu'écrit la transaction de décision d'un événement (projection, effets, minuteries, `settle`), depuis la projection, l'événement, le workflow figé et l'horloge ; appelée par l'orchestrateur et par l'oracle de rejeu ; une réparation qui rejoue ou force un événement est planifiée comme lui (ORC-175) ; note de log d'un refus de la matrice (ORC-186) | garder | ORC-174 (fait : extraite de l'orchestrateur), ORC-175 (fait : `effectiveEvent`), ORC-150 (`settle` passe dans `decide`), ORC-187 (préréglage) |
| `src/core/orchestrator.ts` | Files, runs, vérifications, blocages, reprise ; `recover()` se rattache aux tentatives vivantes et relance les autres par `run.lost`, `supervise()` bat le cœur des tentatives (ORC-220) ; la borne des relances après une coupure est dans `decide` ; construit la transaction de décision du worker (son plan : `planDecision`, ORC-174), exécute les effets de l'outbox, change l'état par `reduce` (ORC-133) | retirer | ORC-133 (`reduce` extrait), ORC-147 (fait : `accept` écrit l'inbox, événements traités depuis l'inbox, rejeu au démarrage), ORC-149 (fait : chaîne en mémoire, `submit` et `idle` retirés au profit du worker), ORC-150 (fait : effets par l'exécuteur d'outbox, `failTicket` remplacé par `effect.failed` décidé ; reste : un exécuteur par port, `Scheduler` en limite de réclamation), ORC-274 (fait : chemins sensibles calculés au lancement sur les retours lus, commentaires de review non fiables, portés jusqu'au run et au runner), ORC-228 (fait : `poll`, un passage du worker pour une horloge simulée), ORC-162 (fait : effets clés par leur id et celui de l'installation, commentaire, activité et départ cherchés avant d'écrire quand la ligne est rejouée, départ marqué `effect:<clé>:started`, doublon rendu `deduplicated`), ORC-277 (fait : la marque nomme la tentative avant qu'elle soit écrite et avant `run.started`, un départ repris ou un élément de file ressorti qui la trouve ne relance pas une question coupée), ORC-186 (fait : rôles de l'acteur résolus avant la décision, refus journalisé), ORC-289 (fait : `attempt` et `output` de `run.finished` lus de `agent-output:<run>`, revalidés ; `post_output` composé depuis la sortie), ORC-220 (`recover`), retrait final ORC-169, ORC-123 (fait : tête de départ de l'étape `tests` retenue au lancement ; `run_verify` d'un job `red` lance le contrôle du rouge, dans un bac à sable sans réseau s'il y en a), ORC-279 (`fullReadPaths`, `fullReadEnv`), ORC-180 (fait : le lancement de l'agent qui implémente porte `humanInbox`) |
| `src/core/bus.ts` | Chaîne d'événements en mémoire (`EventBus`, aussi source du SSE) | retirer | ORC-169 (ORC-223 garde le flux SSE du dashboard) |
| `src/core/scheduler.ts` | Places `dev` et `questions` en mémoire ; un départ est tiré de la file `queue` sous bail jusqu'à l'écriture du run (ORC-150) | retirer | ORC-169 (ORC-182 garde un emplacement à part pour les questions) |
| `src/core/decision.ts` | Type `Decision` de `decide` : `Effect` (ex-`Command` côté externe), `Timer` générique `{kind, slot, ms, payload}` (ex-`set_debounce`, ORC-161) ; remplace `commands.ts` (ORC-133) ; `OutboxEffect` (un effet, ou `settle`) écrit dans l'outbox (ORC-149) | garder | ORC-133, ORC-161 (fait : timer générique), ORC-162 (effets idempotents), ORC-150 (`settle` passe dans `decide`) |
| `src/core/attempt-labels.ts` | Étiquettes d'une tentative à sa création : job, file, modèle, version et commit de l'usine, empreintes sha256 du prompt, des skills, du workflow et de la config ; champs sans source encore à `null` avec le ticket qui les remplira | garder | ORC-226 (fait), ORC-203 (fait, commit de l'usine), ORC-136 (fait : effort), ORC-204 (image), ORC-206 (risque), ORC-257 (registre, faits livrés), ORC-232 (index de connaissances) |
| `src/core/conditions.ts` | Mini-langage `when` | retirer | ORC-177 |
| `src/core/sealed-setup.ts` | `runSealedSetup` : le `setup` du dépôt dans un conteneur à lui, détruit, puis `sealSecrets` purge le worktree, avant le conteneur de l'agent ; `setupEnv` : scripts d'installation coupés, roues binaires, âge minimal des versions | garder | ORC-211 (fait), ORC-209 C (`setup` de `.factory/config.yml`), ORC-213 (`full` pour le `setup`, à trancher) |
| `src/core/verify.ts` | `runVerify` : commandes `bash -lc` dans un dossier, avec le `setup` sur l'hôte et `verify` sous `FACTORY_ALLOW_HOST_VERIFY=1` seulement ; sur un échec, empreinte du dossier (arbre git, garde « Boucle », ORC-187) ; environnement réduit au système et aux variables déclarées par le dépôt (ORC-211) | adapter | ORC-179 (retrait de l'hôte) |
| `src/core/clean-verify.ts` | `runCleanVerify` : `verify` hors du worktree et du démon. Bundle dans un sandbox sans réseau, clone neuf sans la config du dépôt, gitleaks puis checkout dans un sandbox à `none`, `setup` scellé à `limited`, commandes à `none` dans un sandbox neuf ; `.factory/config.yml` lu sur la branche par défaut de la forge, chemins interdits et gel lus dans le clone avant tout code de l'agent ; gitleaks de l'image sur les commits de la branche (`factory/secrets`) ; toute panne rejette, sans verdict, et donne `verify.errored` | garder | ORC-151 |
| `src/core/prompt.ts` | Prompt texte d'un run (skill, ticket, branche, PR, échecs de vérif) | adapter | ORC-136 (pistes d'`intake`), ORC-182 (entrées de l'agent de réponse), ORC-180 (fait : `withHumanInbox`) |
| `src/core/routing.ts` | Projet d'un ticket parmi ceux de son équipe Linear : le seul, celui qui le tient déjà (routage collant), ou celui que nomme son label `repo:<id>` ; sinon le premier, avec le choix à faire ; l'attente d'un dépôt (`awaitingRepo`), vide pour une équipe sans dépôt ; `claims` : ce qu'une décision ne peut écrire tant qu'un autre projet tient le ticket (ORC-316) | garder | ORC-291, ORC-316 |
| `src/core/session-plan.ts` | Plan de la session Linear : les sept étapes, leur avancée, l'étape d'un job | garder | ORC-171 (fait), ORC-206, ORC-210, ORC-212 (leurs étapes) |
| `src/core/pickup.ts` | Contrôles avant prise (description, branche poussée, critères) | adapter | ORC-206 (garde avant In Progress) ; reste en place jusque-là (ORC-169) |
| `src/core/naming.ts` | `slugify`, `branchName` (`factory/<id>-<slug>`) | adapter | ORC-167 (préfixe), ORC-136 et ORC-204 (`branchName` de Linear) |
| `src/core/clock.ts` | `Clock`, `SystemClock`, `FakeClock` | garder | ORC-225, ORC-161 |
| `src/core/duration.ts` | `parseDuration` (`3m`, `90m`…) | garder | ORC-177 (gardé si `factory.yml` garde des durées en texte) |
| `src/core/block-cause.ts` | Cause d'un blocage lue dans sa raison, pour le Flux | garder | ORC-297, ORC-300 (Pareto) |
| `src/core/human-message.ts` | Classement déterministe d'un message humain à son arrivée, sans modèle ; ce que l'agent lit de `humanInbox` à une frontière d'étape | garder | ORC-180 (fait), ORC-141 (règles définitives, petit modèle) |
| `src/core/measures.ts` | Mesures du doc MVP calculées depuis les faits de la base (journal, tentatives, outbox, accusés de réception), jamais depuis le texte d'un agent : tokens, premier essai, délais de signe de vie et de réponse, revert à 14 jours et coût de CI (durée des runs par PR puis par ticket) ; mesures sans source encore à `null` avec le ticket qui l'apportera | garder | ORC-235 (fait), ORC-278 (fait : reverts et coût de CI), ORC-223 (affichage), ORC-216 (limite d'usage), ORC-190 (relecture humaine), ORC-160/ORC-180 (accusé de réception en effet d'outbox), ORC-123 (fait : verdicts du contrôle `red`, hors reprises), ORC-180 (fait : le type de message vient du classement journalisé) |
| `src/core/types.ts` | `FactoryEvent` (`schemaVersion`, taint, `actor` signé), `TicketState`, 6 états logiques ; événements `effect.done` (avec `deduplicated` et `ref` d'un doublon, ORC-162) et `effect.failed` (ORC-150), `pr.reviewed` et `pr.conflicted` (ORC-134), `default_branch.pushed` et `ci.run_completed`, `mergeSha`, `headSha` et `mergedAt` facultatifs de `pr.merged` (ORC-278, sans changement de version), `dead_letter.added` et `dead_letter.repaired` (ORC-175) ; `timer.fired` et les sortes de timer `TimerPayloads` (ORC-161, schéma version 3) | adapter | ORC-162 (fait), ORC-133 (fait : `schemaVersion`, champ taint, renommages), ORC-161 (fait : `timer.fired`), ORC-269 (fait : taint de `FeedbackItem`), ORC-160 (fait : taint posé à l'ingestion Linear, `actor`), ORC-186 (fait : `roles` journalisés avec l'événement, `initiatorId` du ticket, `authorId` d'un retour), ORC-278 (fait : push de la branche par défaut, runs de CI), ORC-289 (fait : `attempt` et `output` facultatifs de `run.finished`, sans changement de version), ORC-180 (fait : `humanInbox`, ex-`pendingFeedback`, relu par `upcastTicket` ; `kind` et `masked` facultatifs des messages, sans changement de version), ORC-187 (états retirés), ORC-123 (fait : `red` facultatif de `verify.passed`/`verify.failed`, `redAttempts` du ticket, sans changement de version) |

### `src/runtime/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/runtime/worker.ts` | Worker de l'inbox : une tâche par ticket, transaction de décision du store par événement, effets de l'outbox confiés à l'exécuteur après le commit ; ligne dont la préparation ou la transaction échoue (tracker, base) retentée 5 fois (reprise telle que lue : une transaction validée dont la réponse s'est perdue libère les lignes derrière elle ; une réponse `waiting` les libère aussi, le store gardant l'ordre) puis gardée pour le démarrage suivant, et ne retenant que les lignes plus jeunes de son ticket, selon l'ordre de première lecture, qui est celui de l'inbox (une plus ancienne va au store, et prend la main si elle échoue à son tour), ligne dont la décision lève (`decide`, `reduce`, upcast) mise en dead-letter sans nouvel essai ; les lignes parquées d'un ticket repartent en tête de sa file, sans attendre le poll, quand ce worker y valide une décision ou y règle son dernier effet ouvert (autres cas, dont un effet remis en backoff ou réglé par un autre worker : au poll suivant) ; `poll` fait un passage de sa boucle, attendu | garder | ORC-149, ORC-150 (fait : exécuteur d'outbox), ORC-175 (fait : dead-letter), ORC-228 (fait : `poll` pour le harnais), ORC-163 (fait : reprise d'une ligne validée sans réponse), ORC-290 (fait : lignes parquées libérées quand un effet se règle), ORC-314, ORC-315 (fait : une ligne échouée ne retient plus de ligne plus ancienne) |
| `src/runtime/outbox.ts` | Exécuteur d'outbox : réclamation sous bail renouvelé et jeton, backoff `1 s × 2^(essai − 1)` plafonné à 5 min, ligne `dead` au 8e essai, résultat `effect:<id>` écrit dans l'inbox avec la ligne | garder | ORC-150, ORC-162 (fait : un effet rejoué trouvé déjà fait est réglé `deduplicated`, docs/idempotence.md), un exécuteur par port (Tracker, Forge, AgentRuntime…) à venir |
| `src/runtime/replay.ts` | Oracle de rejeu : export du journal d'un ticket avec ses décisions enregistrées, rejeu par les upcasters puis `planDecision`, comparaison bit à bit (régression) ou arrêt à la première divergence sur un autre workflow (what-if) | garder | ORC-174 (fait), ORC-231 (rejeu des tickets fermés avec l'agent), ORC-180 (fait : `upcastTicket` sur les tickets enregistrés) |
| `src/runtime/timers.ts` | `TimerService` : relève les timers échus de la table `timers` et les déclenche par `Store.fireTimer` (`timer:<clé>:<échéance>` dans l'inbox et timer supprimé, une transaction) ; une minuterie qui échoue ne retient pas les autres ; rien en mémoire, un redémarrage n'en perd aucun | garder | ORC-161 (fait), ORC-210 (relance `clarify` à 24 h, Bloqué à 72 h), ORC-215 (attente sur limite d'usage), ORC-185 (réconciliation planifiée par timer) |
| `src/runtime/workflow-version.ts` | Hash sha256 du workflow (JSON canonique, aussi la forme que compare le rejeu) : la version figée d'un ticket | garder | ORC-149, ORC-187 (préréglage en TypeScript) |
| `src/presets/preset.ts` | Types du préréglage (étapes typées, `next`, `onFailure` à compteur, `redCi`, `sameFailure`, `silentRun`) et `compilePreset` : invariants du socle vérifiés, hash sha256 du JSON canonique | garder | ORC-187 (fait : partie A ; partie B : le moteur prend ses bornes dans le préréglage via `loadWorkflow`), ORC-184 (tours de review sur `review_ci`), ORC-177 (bascule) |
| `src/presets/factory-default.ts` | Le préréglage `factory/default` : enchaînement du doc MVP, table des bornes, modèle, effort, tours et réseau par étape | garder | ORC-187, ORC-216 (plafonds en tokens) |

### `src/adapters/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/adapters/exec.ts` | `execCmd`, `mustExec` : sous-processus utilisé par git, `gh`, la base de connaissance, la CLI | garder | ORC-124 (son usage pour `gh` part avec la GitHub App ; git en garde besoin) |
| `src/adapters/read-capped.ts` | `readCapped` : lecture bornée d'un fichier ordinaire qu'un agent a pu remplacer, sans suivre de lien ni attendre sur une FIFO ; journal de sécurité et dépôt de l'agent | garder | ORC-296, ORC-317 |
| `src/adapters/roles/types.ts` | Ports des rôles (ORC-186) : `RoleResolver`, `TeamDirectory` (membres d'une équipe Linear), `RepoPermissions` (droit GitHub d'un utilisateur), `ProjectAuthz` (désignations de la configuration) | garder | ORC-186 (fait), ORC-209 (désignations lues de `.factory/config.yml`) |
| `src/adapters/roles/cached.ts` | `CachedRoleResolver` : membres Linear et droits GitHub relus après `ROLES_TTL_MS` (60 s), mainteneurs, valideurs et logins GitHub de la configuration ; un échec n'est pas gardé | garder | ORC-186 (fait), ORC-209 |
| `src/adapters/forge/types.ts` | Port `Forge` (`PrInfo` avec la tête et, mergée, le commit et l'heure du merge, ORC-278) ; `ForgeWriter`, ses écritures idempotentes (PR ouverte par branche, check run par `external_id`) | adapter | ORC-181 (port gardé, nouvelles opérations), ORC-124, ORC-162 (fait : `ForgeWriter`), ORC-186 (droit d'un utilisateur : port `RepoPermissions`, à part) |
| `src/adapters/forge/fake.ts` | `FakeForge`, aussi `ForgeWriter` (PR ouvertes, check runs) et `RepoPermissions` (`setRepoPermission`) | adapter | ORC-181, ORC-225, ORC-162 (fait), ORC-186 (fait) |
| `src/adapters/forge/gh-cli.ts` | Forge par la CLI `gh` ; droit d'un utilisateur sur le dépôt par `gh api` (ORC-186), `toRepoPermission` ; commit de merge d'une PR mergée (`mergeCommit`, ORC-278) | retirer | ORC-181 (après ORC-124, GitHub App) |
| `src/adapters/forge/github-app.ts` | Forge GitHub App : JWT RS256, jeton d'installation limité au dépôt, PR/checks/reviews en REST et GraphQL ; écritures idempotentes `ForgeWriter` (`ensurePr` en draft, `markPrReady`, `gitAccess` pour le push de l'usine, `upsertCheckRun` par `external_id`, pas encore appelée) ; droit d'un utilisateur sur le dépôt (`repoPermission`, ORC-186) ; commit de merge d'une PR mergée (`merge_commit_sha`, ORC-278) | garder | ORC-124 (remplace `gh-cli` après ORC-125), ORC-135 (authentification partagée), ORC-162 (fait : `ForgeWriter`), ORC-125 (Publisher, appelle `ensurePr`), ORC-183 (premier check run) |
| `src/adapters/forge/github-app-api.ts` | Lectures GitHub App de `factory doctor` : workflows et environnements protégés | garder | ORC-135 |
| `src/adapters/forge/pr-poller.ts` | Relevé des PR, passé par la réconciliation toutes les 5 min (30 s sans webhooks GitHub, ORC-185) ; verdict de CI nommé par la tête de la PR, comme le webhook ; `pr.merged` avec le commit de merge et la tête lus par la forge (ORC-278) | retirer | ORC-181, remplacé par ORC-134 (fait : webhooks, gardé à côté) et ORC-185 (réconciliation) |
| `src/adapters/forge/github-webhook.ts` | Webhook GitHub : signature `X-Hub-Signature-256`, `mapGithubWebhook` (PR mergée ou fermée, CI, conflit, push humain, review) par la branche du ticket, ids tirés du corps signé ; push de la branche par défaut (commit qui merge une PR du ticket, revert d'une PR mergée) et `workflow_run` terminé avec sa durée (ORC-278) | garder | ORC-134 (fait), ORC-278 (fait), ORC-146 (conflits), ORC-159 (`push.human`), ORC-190 (reviews), ORC-222 (durcissement) |
| `src/adapters/forge/github-ingest.ts` | Ingestion du webhook GitHub : inbox écrite avant la réponse (401 non signé, 500 écriture échouée) ; rattachement au ticket par branche et dépôt `origin` du projet, ou par numéro de PR et commit de merge journalisé pour la branche par défaut (ORC-278) | garder | ORC-134 (fait), ORC-278 (fait), ORC-221 (exposition derrière caddy) |
| `src/adapters/runner/types.ts` | Port `Runner`, `RunHandle`, `RunRequest` (`sensitivePaths` porté, pas encore appliqué, ORC-274) ; `RunResult.tokens`, usage rendu par le runtime (ORC-235) | garder | ORC-204 (port gardé, application des chemins sensibles), ORC-189 (devient AgentRuntime) |
| `src/adapters/runner/claude-code.ts` | `ClaudeCodeRunner` : `claude -p` en sous-processus sur l'hôte ou dans le sandbox, transcripts masqués à l'écriture ; sortie dans un fichier qui survit au démon, `attach` (ORC-220) ; environnement par liste blanche, le jeton du compte choisi seul identifiant en sandbox (ORC-211), `GH_TOKEN` et `ANTHROPIC_API_KEY` encore sur l'hôte ; `--effort`, tours par `message.id`, plafond en tokens, stagnation, fin sans ligne `result` = panne (ORC-136) | adapter | ORC-136 (fait), ORC-211 (fait), ORC-125 et ORC-179 (fin de la transition sur l'hôte), ORC-204 (dans le runner isolé), ORC-205 (réglages imposés), ORC-217 (session sur volume), ORC-194 (`--max-budget-usd`), ORC-167 |
| `src/adapters/runner/transcript.ts` | Masquage des secrets dans les transcripts, rétention de 30 jours et purge | garder | ORC-132 (suit les transcripts dans le runner isolé, ORC-204) |
| `src/adapters/runner/stream-parser.ts` | Lecture du stream-json de Claude Code ; `usage` de la ligne `result` en tokens (ORC-235) | adapter | ORC-235 (fait : usage en tokens), ORC-136, gardé par ORC-204 |
| `src/adapters/runner/stagnation.ts` | Détection de boucle : appels `Bash` en échec du flux, sortie normalisée, compte par empreinte, arbre du worktree lu sans toucher à l'index (ORC-136) | garder | ORC-136 (fait), ORC-204 (suit le port `Runner`) |
| `src/adapters/runner/channel.ts` | File asynchrone qui porte le flux d'un `RunHandle` | garder | ORC-204 (suit le port `Runner`) |
| `src/adapters/runner/fake.ts` | `FakeRunner` du harnais (`fail` : une fin de run qui casse, ORC-289 ; `attach`, `forget`, ORC-220 ; `submit` : le `submit_result` d'un build, `stagnation`, ORC-136) | garder | ORC-204, ORC-225 |
| `src/adapters/runner/fixtures/` | Données de test : faux `claude` et flux stream-json ; démon tué juste après un départ (ORC-220) | garder | ORC-136 (suivent le runner) |
| `src/adapters/tracker/types.ts` | Port `Tracker`, `ActivityInput` ; écritures clées par l'id d'effet (`findComment`, `findActivity`, `effectMarker`) ; clé d'écho d'un label ajouté ou retiré (`labelEchoKey`) | adapter | ORC-162 (fait : id d'effet), ORC-160 (fait : groupes exclusifs dans `setLabels`, écho des retraits), ORC-171 (fait : plan de la session, `setSessionPlan`) |
| `src/adapters/tracker/fake.ts` | `FakeTracker` ; idempotent comme l'adaptateur Linear (labels, liens, commentaires et activités d'un effet), groupes de labels exclusifs (`setLabelGroup`), membres d'une équipe (`setTeamMembers`) | garder | ORC-162 (fait), ORC-160 (fait : groupes exclusifs), ORC-186 (fait : `TeamDirectory`), ORC-225 |
| `src/adapters/tracker/activity-relay.ts` | Relaie la sortie d'un run en activités de la session Linear, avec un débit plafonné | adapter | ORC-171 |
| `src/adapters/tracker/linear/api.ts` | `LinearApi` : client GraphQL | garder | ORC-160 |
| `src/adapters/tracker/linear/queries.ts` | Documents GraphQL ; recherche du commentaire et de l'activité d'un effet, liens d'une session ; groupe (`parent`) des labels | adapter | ORC-162 (fait : marqueur de commentaire), ORC-160 (fait : groupe des labels), ORC-186 (fait : membres d'une équipe, `teamMembers`), ORC-171 (fait : le plan passe par `SessionUpdate`, déjà là) |
| `src/adapters/tracker/linear/tracker.ts` | `LinearTracker` (cache, `ensureSetup`) ; commentaires et activités d'un effet sous un id client et un marqueur, labels et liens écrits seulement s'ils manquent, labels d'un groupe Linear exclusifs ; membres actifs d'une équipe, toutes les pages (`teamMembers`, ORC-186) | adapter | ORC-162 (fait : commentaires, activités et labels idempotents), ORC-160 (fait : groupes exclusifs), ORC-186 (fait), ORC-201 (plus de « Ready to Merge » ni `agent:*`), ORC-170 |
| `src/adapters/tracker/linear/webhook.ts` | Signature, fraîcheur, `deliveryKey`, `mapLinearWebhook` ; acteur signé et taint (`signedActor`), retrait de label en `label.changed` ; demande d'accusé (`ack`), projet du ticket parmi ceux de son équipe, délégation sur une équipe sans dépôt (`noRepo`) | adapter | ORC-160 (fait : `status.changed`, `label.changed` ajout et retrait, taint, `actor`), ORC-147, ORC-171 (fait), ORC-186 (fait : autorisations vérifiées sur `actor`, dans `decide`), ORC-291 (fait : routage), ORC-180 (fait : message masqué et classé à son arrivée, accusé des réponses) |
| `src/adapters/tracker/linear/ingest.ts` | Ingestion : vérifie, écrit dans l'inbox (dédoublonnage par id en base), puis répond ; l'accusé est un effet de la décision | adapter | ORC-147 (fait : inbox écrite avant la réponse, 500 si l'écriture échoue), ORC-160 (fait : taint et acteur posés par `mapLinearWebhook`), ORC-171 (fait : ack en effet d'outbox) |
| `src/adapters/tracker/linear/reconcile.ts` | Réconciliation Linear, toutes les 5 min par la minuterie `reconcile` en base (ORC-185) ; délégation, déplacement, passage en terminé ou annulé et labels retrouvés marqués `untrusted` (pas d'acteur signé) ; une lecture par équipe, chaque rattrapage va au seul projet du ticket ; lève l'attente d'une équipe qui a trouvé un dépôt | adapter | ORC-185 (fait : 5 min, timer en base, inbox, terminé, annulé, labels), ORC-160 (fait : taint), ORC-171 (fait), ORC-291 (fait : routage) |
| `src/adapters/tracker/linear/labels.ts` | Labels d'un ticket tels que l'usine les a lus en dernier (méta en base), écrits par le webhook et la réconciliation : un changement n'est signalé qu'une fois | adapter | ORC-185 (fait) |
| `src/adapters/tracker/linear/oauth.ts` | OAuth Linear, jetons rafraîchis écrits dans `secrets.json` | adapter | ORC-222 (secrets scellés), ORC-199 (`secrets.json` retiré) |
| `src/adapters/tracker/linear/fixtures/` | Données de test : webhooks Linear | garder | ORC-160 (suivent `webhook.ts`) |
| `src/adapters/workspace/types.ts` | Port `WorkspaceManager` | adapter | ORC-189 (devient SandboxProvider), ORC-204, ORC-123 (fait : `stepDiff`, fichiers changés par les commits d'une étape et chemins à sa base ; `uncommitted`) |
| `src/adapters/workspace/git-workspaces.ts` | Espaces de travail par ticket sur l'hôte, un dépôt à lui pour chacun, `_trunk/<runId>`, `_kb`, ports, `setup` ; aucun git de l'hôte n'y tourne avec les sandboxes (tête lue comme données, objets par `GIT_ALTERNATE_OBJECT_DIRECTORIES`) | adapter | ORC-317 (fait), ORC-179 (base du miroir et des clones neufs, ou retiré), ORC-204 (`branchName`, `setup` dans le conteneur), ORC-193 (`_kb`), ORC-123 (fait : `stepDiff` lu sur le dépôt de l'usine, `uncommitted`, `parseStatus`) |
| `src/adapters/workspace/fake.ts` | `FakeWorkspaces` | adapter | ORC-189 (suit son port vers `SandboxProvider`, dont ORC-225 a posé le faux à côté), ORC-204, ORC-123 (fait : `steps`) |
| `src/adapters/sandbox/types.ts` | Port `SandboxProvider` (`reattach`, ORC-220), niveaux réseau | garder | ORC-225, ORC-189 |
| `src/adapters/sandbox/fake.ts` | `FakeSandboxProvider` du harnais | garder | ORC-225 |
| `src/adapters/sandbox/router.ts` | `SandboxRouter` : choisit le backend qui satisfait les exigences, refuse sinon ; `reattach` (ORC-220) | garder | ORC-204 |
| `src/adapters/sandbox/docker-rootless.ts` | Backend conteneur `L3` (CLI `docker` ou `podman`), un conteneur par tentative, toujours en `--network none` ; avec le proxy de sortie, le socket du run et le certificat de l'autorité de sortie montés, un relais en PID 1, les variables `HTTP(S)_PROXY` et d'autorité ; un conteneur dont le socket n'est pas de ce processus est refait ; l'environnement d'un `exec` transporté sous des noms neutres, jamais lu par le moteur (ORC-211) | garder | ORC-204, ORC-213 (fait : proxy de sortie), ORC-205 (`.git` monté) |
| `src/adapters/publisher/types.ts` | Port `Publisher` : pousse le sha vérifié, ouvre ou retrouve la PR ; `PublishRefused`, une réponse ; `prText`, le texte provisoire de la PR | garder | ORC-225, ORC-125, ORC-195 et ORC-214 (le texte) |
| `src/adapters/publisher/fake.ts` | `FakePublisher` du harnais, branché sur l'orchestrateur | garder | ORC-225, ORC-125 |
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
| `src/checks/red.ts` | Contrôle `red` de l'étape `tests` : fichiers hors tests refusés, seuls les tests ajoutés lancés avec la commande du job, sortie de vitest, jest ou pytest classée (assertion, module ou export absent à baseSha, paquet, compilation, erreur, aucun test, déjà verts) | garder | ORC-123, ORC-131 (gel après le rouge), ORC-172 (Python) |
| `src/checks/freeze.ts` | Gel des tests (`factory/tests-gelés`) : empreintes sha256 des tests de l'étape `tests` et du harnais (config vitest/jest, `tsconfig*`, script `test` de `package.json`, `conftest.py`, `pytest.ini`, section pytest de `pyproject.toml`), puis tout fichier gelé modifié ou supprimé, ou harnais ajouté, depuis le commit du gel ; branché dans la vérification de l'orchestrateur, `/refreeze` réservé au mainteneur | garder | ORC-131, ORC-151 (dans `verify` en clone neuf), ORC-125 (check publié sur la PR), ORC-261 (tests de propriétés) |
| `src/checks/forbidden-paths.ts` | Contrôle `factory/chemins-interdits` : le socle des chemins interdits à l'agent, `package.json#scripts`, liens symboliques sortants | garder | ORC-151 |
| `src/checks/log-excerpt.ts` | La sortie d'un contrôle en échec, coupée à son début, sa fin et ses lignes d'erreur, avant le journal et l'agent | garder | ORC-151 |
| `src/checks/markdown.ts` | `mdCode` : texte écrit par l'agent (chemin, ligne trouvée) cité en code dans le résumé d'un check, caractères de contrôle neutralisés | garder | ORC-145, ORC-158 |
| `src/checks/deps.ts` | Contrôle `factory/dependances` : dépendances ajoutées (npm, PyPI) lues dans le contenu avant et après des manifestes, existence au registre et liste autorisée, bloquant ; liste des ajouts pour le journal de sécurité | garder | ORC-165, ORC-151 (appelé par `verify`), ORC-209 (liste autorisée dans `.factory/config.yml`), ORC-223 (journal de sécurité) |
| `src/checks/registry.ts` | `PackageRegistry`, `HttpPackageRegistry` : registre npm et API JSON de PyPI, `fetch` et URL de base injectables | garder | ORC-165, ORC-213 (requêtes par le proxy de sortie) |
| `src/checks/fake-registry.ts` | `FakePackageRegistry` des tests | garder | ORC-165 |
| `src/checks/toml.ts` | Lecteur TOML minimal, pour `pyproject.toml` | garder | ORC-165, ORC-172 (Python) |

### `src/publish/`

Sortie du travail de l'agent : aucun outil de l'usine ne tourne sur un arbre écrit par l'agent.

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/publish/extract.ts` | `extractWork` : bundle git complet de la branche créé dans le sandbox (dossier monté à `BUNDLE_TARGET`), vérifié puis cloné sur l'hôte sans checkout, sans hook, fsmonitor ni configuration système ou globale ; tête du clone comparée au SHA lu dans le sandbox, aucun clone laissé sur un échec | garder | ORC-286, ORC-205, ORC-125 (diff lu dans le clone), ORC-151 |
| `src/publish/publish.ts` | `GitPublisher` : tête lue sur la forge, bundle dans un sandbox à `none` comparé au commit vérifié, contrôle bloquant du diff, push vers l'avant en `--force-with-lease`, PR draft | garder | ORC-125 |

### `src/network/`

Sortie réseau des sandboxes (ORC-213, [décision](decisions/ORC-213.md)).

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/network/levels.ts` | Niveaux de réseau (`none`, `claude-api`, `limited`, `full`), resserrement par étape, `full` refusé à l'agent ; listes (API Claude, renouvellement OAuth, hôtes `limited`) ; décision par hôte (`CONNECT`) puis par méthode et chemin (chaque requête) | garder | ORC-213, ORC-209 C (`network` du dépôt lu au lancement), ORC-219 (tests 3 à 6) |
| `src/network/proxy.ts` | `EgressProxy` : un socket Unix par run, chaque `CONNECT` déchiffré (HTTP/1.1 seulement) et chaque requête vérifiée puis renvoyée en TLS vérifié, HTTP en clair renvoyé en HTTPS, adresses privées refusées, API agent relayée, journal JSONL par run (`<home>/network/<run>.jsonl`), lu en base à la fin du run | garder | ORC-213, ORC-296 (fait : en base), ORC-300 (au tableau de bord) |
| `src/network/security-log.ts` | Journal de sécurité d'un run : journal du proxy et journal des refus du hook (non fiable : outil, règle et ticket vérifiés, taille plafonnée, ni lien ni FIFO) lus en base à la destruction du sandbox, lignes mal formées ou forgées comptées ; résumé des refus par règle et des hôtes refusés pour la session Linear, sans commande | garder | ORC-296, ORC-300 (journal de sécurité et Pareto au tableau de bord), ORC-279 (fait : outil `Read`, règle `full-read`) |
| `src/network/ca.ts` | Autorité de sortie de l'usine (`<home>/egress-ca/`, clé en `0600`) et certificats par hôte qu'elle signe (`node-forge`), en cache | garder | ORC-213 |
| `src/network/proxy-service.ts` | Le service `proxy` de compose : `EgressProxy` piloté par le démon sur un socket de contrôle (`open`, `close`), `EgressClient` côté démon, qui oublie ses runs quand le proxy s'arrête | garder | ORC-203 |

### `src/app/` et racine de `src/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/app/bootstrap.ts` | Câblage du démon (store, adaptateurs, orchestrateur, serveur, variables `FACTORY_*`) ; résolveur des rôles (ORC-186) | adapter | ORC-147 (fait : toutes les sources écrivent dans l'inbox, rejeu au démarrage), ORC-149 (fait : worker démarré avec relève toutes les secondes), ORC-167, ORC-179 (`PORT`), ORC-192, ORC-201, câblage restant retiré par ORC-169, ORC-279 (`read_guard.max_lines` dans l'environnement des runs, tests gelés lus en entier) |
| `src/app/repo-variables.ts` | Les variables du dépôt d'un projet à chaque lancement : son entrée de `factory.yml`, trouvée par `origin`, et les noms de `.factory/config.yml` lus sur la branche par défaut ; tout échec donne aucune variable et une ligne de journal | adapter | ORC-211 (fait), ORC-209 C (lecture entière de la configuration au lancement) |
| `src/app/sandbox-wiring.ts` | Sandboxes des vrais runs depuis `FACTORY_CONTAINER_CLI`, id d'instance tiré de `FACTORY_HOME` | garder | ORC-204 |
| `src/app/root.ts` | Trouve la racine du dépôt par le `package.json` nommé `factory` | adapter | ORC-167 (le renommage du paquet le casse, le ticket ne le nomme pas) |
| `src/app/tracker-switch.ts` | `Tracker` de substitution tant que Linear n'est pas connecté par OAuth | garder | ORC-208, ORC-162 (méthodes du port suivies) |
| `src/version.ts` | Version du paquet | garder | ORC-167 |
| `src/product.ts` | `PRODUCT_NAME`, seule source du nom affiché (ses lecteurs : « Nom affiché », plus haut) | garder | ORC-167 (nom définitif : voir « Nom affiché ») |

### `src/store/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/store/types.ts` | Port `Store` asynchrone, servi par `SqliteStore` et `PgStore` ; transaction de décision, outbox des décisions et versions de workflow (ORC-149) ; réclamation, nouvel essai, mort et résultat `effect:<id>` d'un effet (avec `deduplicated`, ORC-162), file `queue` sous bail (ORC-150) ; décision enregistrée dans sa transaction, `ticketJournal` (ORC-174) ; dead-letter d'une ligne, liste et réparation (`deadLetter`, `deadLetters`, `getDeadLetter`, `repairDeadLetter`, ORC-175) ; timer générique `TimerRecord`, `fireTimer` : événement (`timerEvent`) dans l'inbox et timer supprimé dans une transaction (ORC-161) ; faits des mesures (`measureFacts`) et heure d'accusé de réception (`markAcked`, ORC-235) ; marque de départ d'un élément de file (`QueueItem.startMark`, ORC-277) ; PR mergée d'un commit de merge ou de tête (`mergedPrOf`, ORC-278) ; `DecisionRequest.peers` et `TicketHeldError` : le refus d'une décision, sur les deux stores, `timerRowId` : les minuteries de chaque projet (ORC-316) | adapter | ORC-178 (`queue`, `echoes`, `costSince` retirés), ORC-277 (fait : `startMark`), ORC-316 |
| `src/store/open.ts` | Choix du store au démarrage : `PgStore` et migrations quand `FACTORY_DATABASE_URL` est défini, `SqliteStore` sinon | adapter | ORC-178 (plus que Postgres) |
| `src/store/sqlite-store.ts` | `SqliteStore` sur `node:sqlite`, derrière le port asynchrone ; table `dead_letter`, équivalent de celle de Postgres (ORC-175) ; `mergedPrOf` lu dans `events` (ORC-278) ; son horloge injectable vaut pour les baux, backoffs et lignes échues comme pour l'inbox, comme celle de `PgStore` (ORC-228) ; refuse une décision sur un ticket qu'un autre projet de l'équipe tient, comme `PgStore` (ORC-316) | retirer | retrait ORC-178, ORC-316 |
| `src/store/pg/schema.ts` | Schéma Drizzle des 12 tables du moteur ; `dead_letter` complétée (ticket, statut, échecs, auteur de la réparation : migration `0002_dead_letter_repair`, ORC-175) ; tokens des tentatives et `inbox.acked_at` (migration `0003_measures`, ORC-235) ; journal de sécurité des runs, `security_logs`, `egress_requests` et `refusals` (migration `0004_security_log`, ORC-296) ; `tickets` à clé `(project_id, id)` (migration `0005_tickets_project_key`, ORC-316) | garder | ORC-132, ORC-175, ORC-235, ORC-296, ORC-316 |
| `src/store/pg/types.ts` | `AsyncStore` (le port `Store` plus la réclamation brute d'une ligne de file, `claim`) et `DequeuedEffect` | garder | ORC-132, ORC-178 (`queue` retirée) |
| `src/store/pg/pg-store.ts` | `PgStore` sur Postgres, store du démon quand `FACTORY_DATABASE_URL` est défini ; `fireTimer` sous le verrou du ticket (ORC-161) ; la file départage deux éléments de même instant par leur arrivée (`created_at` à `clock_timestamp()`), pas par leur id (ORC-228) ; `mergedPrOf` lu dans `journal`, sans index ni migration (ORC-278) ; une copie du ticket par projet, le refus lu dans la transaction de décision (ORC-316) | garder | ORC-132, ORC-161 (fait), ORC-228 (fait), ORC-278 (fait), ORC-316 |
| `src/store/pg/migrate.ts` | Application des migrations Drizzle | garder | ORC-132 |

### `src/config/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/config/instance.ts` | `config.yaml` et `secrets.json` de l'instance (zod) ; `projects[].authz` : mainteneurs, valideurs, logins GitHub des utilisateurs Linear (ORC-186) | adapter | ORC-209 (`factory.yml`, où passent les désignations d'`authz`), ORC-199 (`config.yaml` et `secrets.json` retirés), ORC-194 (`perDayUsd`), ORC-167 (`RELAIS_HOME`) |
| `src/config/factory-yml.ts` | `factory.yml` du serveur (zod) : secrets en `env:NOM` résolus, clé fautive nommée ; appliqué à la lecture (`effectiveInstance`, `linearSettings`), jamais recopié ; jeton du compte actif, `env` et `secrets` d'un dépôt (ORC-211) ; effort et budgets par étape (`stepSettings`, ORC-136) | garder | ORC-209 (fait : partie B), ORC-211 (fait), ORC-136 (fait), ORC-215 (comptes Claude), ORC-216 (reste des budgets), ORC-204 (`repos` sans clone local), ORC-199 (retrait de `config.yaml`), ORC-279 (fait : `read_guard.max_lines`) |
| `src/config/repo-config.ts` | Schéma de `.factory/config.yml` (zod) fusionné sur le socle : clé inconnue, motif négatif, `max_diff` élargi et réseau `full` refusés ; chemins interdits du socle toujours gardés ; `env` et `setup_secrets`, des noms, réservés et noms de secret refusés (ORC-211) | garder | ORC-209 (fait : partie A ; B : `factory.yml` ; C : lecture sur la branche par défaut, `.factory/**` interdit à l'agent), ORC-211 (fait) |
| `src/config/repo-variables.ts` | Ce que le runner reçoit d'un dépôt : un nom déclaré par `.factory/config.yml` et une valeur donnée par `factory.yml`, les variables et les secrets du `setup` séparés | garder | ORC-211 (fait), ORC-208 (variable non déclarée au rapport de l'essai à blanc) |
| `src/config/github-app.ts` | Résolution de la GitHub App (PEM ou chemin, repli `GH_APP_*`) et du secret des webhooks GitHub (repli `GH_WEBHOOK_SECRET`, ORC-134) | garder | ORC-124 (cible `factory.yml`, ORC-209) |
| `src/config/load-workflow.ts` | Fusion pack + `.factory/workflow.yml` ; effort et tours d'un job tirés de l'étape du préréglage qu'il nomme (`step`, ORC-136) | retirer | ORC-177 (remplacé par ORC-187 et ORC-209) |
| `src/config/workflow-schema.ts` | Schéma zod de `workflow.yml` (`structured_output` d'un job, provisoire, ORC-289) | retirer | ORC-177, ORC-123 (`red` et `on_success.run` d'un job) |
| `src/config/run-settings.ts` | `run-settings.json` : refus de lecture sur `FACTORY_HOME` | retirer | ORC-179, ORC-199 |

### `src/server/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/server/app.ts` | API Hono : interface, SSE, webhook Linear, `/agent/*`, pause/resume, mot de passe, CSRF | adapter | ORC-147 (fait : webhook et commandes de l'interface attendent l'écriture de l'inbox), ORC-192 (`/agent/*` retiré), ORC-200 (pause/resume retirés), ORC-223 (API du dashboard ; fait : `GET /api/flow`, ORC-297), ORC-222 (authentification nominative), ORC-134 (fait : `POST /webhooks/github`) |
| `src/server/flow.ts` | Le Flux du dashboard : Needs you, Working, Done, champ par champ, sans jeton de run | garder | ORC-297, ORC-177 (l'étape du préréglage), ORC-212 (porte de spec) |
| `src/server/static.ts` | Sert l'interface construite | garder | ORC-223 |

### `src/api/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `src/api/mcp.ts` | MCP de l'usine (`POST /agent/mcp`, JSON-RPC) : `submit_result` range le résultat validé du run, `ask` | garder | ORC-288 (fait), ORC-188 (`kb_search`), ORC-192 (`ask` seul canal) |

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
| `src/cli/control.ts` | `factory status` (tickets, blocages, runs et leur bail) et `factory stop` par l'API du démon | adapter | ORC-220 (fait), ORC-223 (dashboard) |
| `src/cli/factory.ts` | CLI `factory` : `init`, `doctor`, `up`, `plan`, `status`, `pause`, `resume`, `stop`, `replay`, `run repair` | adapter | ORC-167 (`factory`), ORC-135 (`doctor`), ORC-174 (`replay`), ORC-175 (`run repair`), ORC-200 (`plan`, `pause`, `resume`, `--fake-runner` retirés), ORC-220 (`status`, `stop`) |
| `src/cli/doctor.ts` | `factory doctor` : refuse un dépôt dont la CI peut exposer des secrets aux branches `factory/*` sans approbation humaine | adapter | ORC-135, ORC-208 (intégration à `init`) |
| `src/cli/validate.ts` | `factory validate [repo]` : `.factory/config.yml` vérifié contre le socle, une ligne par violation | garder | ORC-209, ORC-216 (pire cas des budgets) |
| `src/cli/init.ts` | Assistant `init` (app OAuth, smee, base de connaissance, `.factory/workflow.yml`) | adapter | ORC-208 (GitHub App, `factory.yml`, détection), ORC-177, ORC-193, ORC-200 |
| `src/cli/replay.ts` | `factory replay` : rejoue des journaux exportés (régression bit à bit, `--what-if`), `--export` d'un ticket de l'instance | garder | ORC-174 (fait) |
| `src/cli/plan.ts` | `factory plan` : tickets délégués qui seraient pris | retirer | ORC-200 |
| `src/cli/repair.ts` | `factory run repair <ticket>` : liste les événements mis de côté d'un ticket, en rejoue, ignore ou force un, écrit dans le store (statut, événement `dead_letter.repaired` journalisé), sans démon | garder | ORC-175 |
| `src/cli/factory-proxy.ts` | Point d'entrée du service `proxy` de compose, sans aucun secret du démon | garder | ORC-203 |
| `src/cli/factory-agent.ts` | CLI de l'agent (`factory-agent`, nom temporaire) : `issue`, `search`, `kb search`, `ask` | retirer | ORC-192 (MCP de l'usine) |

### `web/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `web/src/App.tsx`, `web/src/Flow.tsx` | Interface : en-tête (places, file, coût du jour), Flux (ORC-297), session en direct, journal | adapter | ORC-223 (Détail d'un run, Vue d'ensemble), ORC-194 (coût en tokens) |
| `web/src/state.ts` | Reducer de l'état de l'interface | adapter | ORC-223 |
| `web/src/api.ts`, `web/src/types.ts` | Appels à `/api/*` et SSE, types des vues (6 états, coût en USD) | adapter | ORC-223 (API lues depuis Postgres), ORC-194 |
| `web/src/main.tsx`, `web/src/styles.css`, `web/src/vite-env.d.ts`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json` | Point d'entrée, styles, build Vite | garder | ORC-223 |

### `packs/standard/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `packs/standard/workflow.yml` | 6 états, règles `on`, jobs, limites | retirer | ORC-177 (remplacé par ORC-187), ORC-193 (`learn`, `remember`), ORC-194 (`usd`), ORC-123 (job `tests`, contrôle `red` en mode mesure, inactif tant qu'aucune règle ne le lance) |
| `packs/standard/settings.json` | Réglages Claude Code des runs (`acceptEdits`, `gh` en lecture ; tout push et les écritures `gh` refusés) | adapter | ORC-191, ORC-205 (deny-list imposée), ORC-125, ORC-181 |
| `packs/standard/.claude-plugin/plugin.json` | Plugin `factory` | adapter | ORC-167 (nom), ORC-191 |
| `packs/standard/hooks/hooks.json`, `packs/standard/hooks/session-start.mjs` | Hook de démarrage : règles, méthode, index de la base | adapter | ORC-191 (plus de `FACTORY_*` ni `factory-agent`), ORC-232 (index injecté par le `systemPrompt`), ORC-205 |
| `packs/standard/hooks/pre-tool-use.mjs` | Hook `PreToolUse` : refus des commandes interdites et des lectures complètes de gros fichiers, journal des refus, tout push et les écritures `gh` refusés | garder | ORC-285, ORC-125 (fait : le drapeau `FACTORY_DENY_PUSH` retiré, le refus est permanent), ORC-279 (fait ; la liste des fichiers lus en entier attend ORC-131 et ORC-212) |
| `packs/standard/skills/{dev,feedback,review,ask}/` | Skills de job | adapter | ORC-191 (une consigne par étape, fin par `submit_result`), ORC-187 |
| `packs/standard/skills/{fix-ci,learn}/` | Skills de job sans équivalent au MVP | retirer | ORC-191, ORC-193 (`learn`) |
| `packs/standard/skills/tests/` | Skill de l'étape `tests` : seulement les tests des critères d'acceptation, commités, ou `spec_impossible` | garder | ORC-123, ORC-191 |
| `packs/standard/skills/{tdd,debugging,verification,code-review,receiving-review}/` | Skills de méthode | garder | ORC-191 (relus pour retirer push et CI) |
| `packs/standard/NOTICE.md` | Mention de licence (superpowers, MIT) | garder | ORC-191 |

### `test/`

| Module | Rôle | Statut | Ticket cible |
|---|---|---|---|
| `test/helpers/harness.ts` | `createHarness` : faux adaptateurs, `FakeClock` lue aussi par le store, une base par harnais (SQLite en mémoire, Postgres dans `scenarios-pg`) ou le store passé, `wrapStore`, `send`, `advance` (minuteries en base, passage du worker), `restart` propre ou brutal (`mortal`, store et adaptateurs coupés), `faults` (points de coupure) ; `send` avec acteur signé, `authz` : rôles résolus par les faux de chaque vie, matrice vérifiée (ORC-186) | adapter | ORC-225 (nouveaux faux, préréglage de test), ORC-228 (fait : Postgres, worker, outbox, minuteries en base, redémarrage brutal), ORC-149 (fait : `drained()`, inbox et outbox vides, remplace `idle`), ORC-163 (fait : points de coupure, adaptateurs d'un processus mort coupés) |
| `test/helpers/pg-harness.ts` | Setup du projet `scenarios-pg` : une base Postgres par harnais, clonée d'un modèle migré, supprimée après chaque test | garder | ORC-228 |
| `test/scenarios/restart.test.ts` | Redémarrage brutal en plein traitement, sur les deux stores | garder | ORC-228, ORC-163 |
| `test/helpers/faults.ts`, `test/scenarios/faults.test.ts` | Points de coupure le long de la chaîne (store, faux tracker, faux runner), registre des appels visibles par ligne d'outbox, vérificateur `checkChain` (aucune perte, aucun doublon visible, journal rejoué par l'oracle) ; un test par point, en `throw` et en `kill` | garder | ORC-163, ORC-162 (fait : le `it.fails` du `post_output` refait passe en `it`), ORC-277 (fait : question coupée lancée une fois, par l'outbox ou la file, points `run.write` et `run.written`, tout run lancé deux fois pour une ligne est une violation) |
| `test/chaos/` | Chaos : un vrai démon tué par SIGKILL au hasard pendant 500 événements, sur Postgres (job CI `chaos`) ; un événement sur sept signé hors de l'équipe, refusé par la matrice (ORC-186) | garder | ORC-163, ORC-162 (fait : strict par défaut, faux tracker qui garde les écritures des vies précédentes), ORC-277 (fait : la question relancée fait échouer, plus de cas à part) |
| `test/scenarios/workflow.test.ts` | Scénarios de bout en bout sur le harnais (22 `it` au départ) | adapter | ORC-169 (chaque scénario réécrit ou marqué abandonné), ORC-225, ORC-228, ORC-187 |
| `test/replay/` | Journaux enregistrés (`journals/`, format de `factory replay --export`) que la CI rejoue, scénarios du harnais qui les produisent (`npm run replay:record`) ; `authz-refused-then-allowed` : rôles journalisés, un refus et une action autorisée (ORC-186) | garder | ORC-174, ORC-186 (fait) (fait : journaux tirés des scénarios), journaux réels exportés d'une instance à ajouter dès qu'une instance tourne sur le moteur (ORC-233) |
| `test/isolation/network.test.ts` | Proxy de sortie sur un vrai moteur : registre npm et doc passent et sont journalisés, hôte hors liste et écriture GitHub refusés, ni DNS ni TCP ni UDP direct, rien en `none` | garder | ORC-213, ORC-219 |
| `test/e2e/pack.e2e.test.ts` | Test du pack avec le vrai `claude` (live, voir plus haut) | adapter | ORC-191 (renommé, `git push` refusé) |

## À trancher

Modules dont aucun ticket MVP ne règle le sort ; le statut ou le ticket est à décider avant le ticket qui les touche en premier :

aucun.
