# Idempotence des effets externes

L'exécuteur d'outbox (`src/runtime/outbox.ts`, ORC-150) exécute chaque effet **au moins une fois** : un effet qui a agi puis a été coupé avant d'être réglé (crash, bail perdu) est exécuté de nouveau par la réclamation suivante. Chaque effet externe est donc idempotent : exécuté deux fois, il ne laisse qu'**un seul effet visible**. Cette page est la table d'ORC-162, avec la colonne « comportement en doublon » tranchée par [ORC-138](decisions/ORC-138.md#la-table-didempotence) ; chaque ligne a son test.

## La règle commune

- **La clé est l'id de l'effet**, `ticket:seq:i` (l'id de la ligne d'outbox), ou l'id de tentative pour ce qui en dépend : stable d'une exécution à l'autre, jamais tiré de l'horloge.
- **Un doublon détecté est un succès** (ORC-138, option B3) : l'exécution qui trouve l'effet déjà fait n'écrit rien, et son résultat `effect:<id>` (`effect.done`) porte `deduplicated: true` et, quand l'adaptateur la donne, la référence de l'objet trouvé (`ref` : id du commentaire, de l'activité…). `decide` n'en tire rien, mais le note dans sa trace (`effect <id> deduplicated`), et le démon l'écrit au journal : `effect <id> (<type>) already made (<ref>): not written again`.
- **Un effet « état final »** (labels, statut, lien) n'a rien à chercher : il réécrit le même état, et l'adaptateur n'écrit rien quand l'état y est déjà. L'outbox exécute les effets d'un ticket dans l'ordre de `seq` : un ancien effet rejoué ne passe pas après un plus récent.
- **La seule exception** est le push dont la branche a bougé vers un autre SHA : un conflit, jamais rejoué, rendu à `decide`.

## La table

Tests : `test/scenarios/idempotency.test.ts`, un par ligne, sur les faux adaptateurs (le nom du test commence par la ligne). Les lignes que l'usine exécute aujourd'hui y sont rejouées **par l'outbox elle-même** : la première exécution agit puis perd son bail avant de régler sa ligne, qui est réclamée et exécutée de nouveau à l'expiration du bail.

| Effet | Clé | Déduplication | Comportement en doublon | Où | Test |
|---|---|---|---|---|---|
| **Commentaire** (`comment`) | l'id de l'effet : marqueur `<!-- factory:effect=<id> -->` dans le corps, et id client du commentaire dérivé de l'id de l'effet | `Tracker.findComment(ticket, id)` avant d'écrire : un commentaire du ticket avec cet id **ou** ce marqueur | trouvé : **aucune écriture**, `effect:<id>` succès `deduplicated`, `ref` = id du commentaire | `Orchestrator.exec`, `LinearTracker.comment`/`findComment`, `FakeTracker` | « Commentaire: a replayed comment… » |
| **Activité de session** (`activity`, `post_output`), rattachée au Commentaire | l'id de l'effet : id client de l'activité dérivé de l'id de l'effet (pas de marqueur, voir plus bas) | `Tracker.findActivity(session, id)` avant d'écrire | trouvée : **aucune écriture**, `effect:<id>` succès `deduplicated` | `Orchestrator.activityOnce`, `LinearTracker.activity`/`findActivity`, `FakeTracker` | « Commentaire (activité de session)… » |
| **Labels** (`labels`) | le groupe exclusif : la règle du workflow ajoute la cible et retire les autres membres (`labels: { add, remove }`) | aucune : état final ; `setLabels` relit les labels du ticket et n'écrit que ce qui diffère | même état final : **aucune écriture** au second passage ; l'écho de la première est filtré par `isEcho` | `LinearTracker.setLabels`, `FakeTracker.setLabels` | « Labels: a replayed label change… », « Labels: the final state of the group… » |
| **Push** — en attente du Publisher (**ORC-125**) | `--force-with-lease=<branche>:<sha attendu>` | aucune : git compare lui-même la tête distante | tête = SHA poussé : sortie 0 (`Everything up-to-date`), **naturellement idempotent** ; tête = SHA attendu : push ; autre SHA : refus `(stale info)`, **conflit** non rejoué | aucun code de l'usine aujourd'hui : l'agent pousse | « Push (pending ORC-125)… » : vérifie sur un dépôt nu le comportement de git sur lequel la ligne s'appuie |
| **PR** — appelée par le Publisher (**ORC-125**) | la branche (tête → base) | `ForgeWriter.ensurePr` : cherche la PR **ouverte** de la branche avant de créer ; course perdue (GitHub répond 422) : relit la PR ouverte | une PR ouverte existe : **aucune création**, `deduplicated: true` avec son numéro ; une PR fermée ou mergée n'est pas réutilisée, une nouvelle est ouverte (ORC-138, point 7) | `GitHubAppForge.ensurePr`, `FakeForge.ensurePr` ; pas encore appelée (l'agent ouvre la PR) | « PR: a replayed opening… » |
| **Check run** — l'usine n'en publie aucun aujourd'hui (premier prévu : `factory/review`, **ORC-183**) | `external_id` = id de l'effet qui **crée** le check, repris par ses mises à jour (ORC-138, point 5) | `ForgeWriter.upsertCheckRun` : liste les check runs du SHA de ce nom (`filter=all`) et cherche `external_id` | trouvé : **mise à jour** (`PATCH`) au lieu d'une création, `deduplicated: true` | `GitHubAppForge.upsertCheckRun`, `FakeForge.upsertCheckRun` ; pas encore appelée | « Check run: a replayed check run… » |
| **Conteneur** — en attente du vrai fournisseur (**ORC-204**) | l'id de tentative (`runId`) : label `factory.attempt=<id>` et nom du conteneur | recherche par label avant création | trouvé : **aucun second conteneur** (rattachement) | `FakeSandboxProvider.create` seulement ; l'usine n'a aucun conteneur par tentative aujourd'hui | « Conteneur (pending ORC-204)… » : le faux du port |
| **Appel au modèle** (`start_run`) | l'id de l'effet, puis l'id de tentative | la marque `effect:<id>:started` du store, posée une fois le départ traité (lancé, mis en attente ou en file) ; ensuite le fencing (I11) | marque trouvée : **aucun second départ** (ni lancement, ni départ mis en attente derrière la tentative en cours), `deduplicated` ; un résultat tardif d'une tentative remplacée est **ignoré par `decide`** (fencing, ORC-133) | `Orchestrator.exec` ; fencing dans `decide` | « Appel au modèle: a replayed start… » ; fencing : `engine.test.ts` (`fenced:`), propriété I11 de `test/properties/decide.prop.test.ts` |

Les autres effets de `decide`, rattachés comme ORC-138 le propose (point 6) :

| Effet | Comportement en doublon |
|---|---|
| `move` (statut) | état final, naturellement idempotent ; écho filtré |
| `link_pr` (`addExternalUrl`) | état final : l'adaptateur Linear relit les liens de la session et n'ajoute pas une URL déjà là (le faux aussi) |
| `stop_run`, `cleanup` | naturellement idempotents : arrêter ce qui est arrêté, supprimer ce qui n'existe plus ne fait rien |
| `run_verify` | son verdict revient en `check:<run>` : l'inbox dédoublonne par id, et un verdict d'une vérification remplacée est fencé |

## Ce que Linear permet

- **Commentaires** : `commentCreate` accepte un `id` client (UUID v4) et `comments(filter:)` filtre par `id` et par `body: { contains }`. L'adaptateur écrit les deux clés : le marqueur que le ticket demande, et un id dérivé de l'id de l'effet (sha256, aux bits de version et de variante d'un UUID v4). La recherche prend l'un **ou** l'autre : si Linear ne gardait pas le commentaire HTML dans le corps, l'id suffit.
- **Activités de session** : `agentActivityCreate` accepte aussi un `id` client, mais `AgentActivityFilter` ne filtre pas sur le contenu (seulement `id`, `type`, dates, session) : la clé d'une activité est donc son id, pas un marqueur, qui de plus s'afficherait dans le fil de l'agent.
- **Non vérifié en direct** (le test live du Tracker est en lecture seule) : que Linear garde `<!-- … -->` dans le corps d'un commentaire, et qu'il accepte un id client sur ces deux créations pour une app. Le schéma GraphQL public les décrit (« The identifier in UUID v4 format. If none is provided, the backend will generate one. »).

## Ce que GitHub et Docker permettent

- **Check run** : seule une GitHub App peut créer ou modifier un check run (« OAuth apps and authenticated users are not able to create them ») : `ForgeWriter` n'est implémenté que par l'adaptateur GitHub App, pas par `gh`. L'API ne filtre pas sur `external_id` (paramètres : `check_name`, `status`, `filter`, `app_id`), mais le renvoie : la recherche se fait côté usine, sur les check runs du SHA qui portent le nom demandé (`per_page=100`).
- **PR** : la doc de `POST /pulls` ne dit que « 422 : Validation failed » ; que GitHub refuse une seconde PR ouverte pour la même branche n'est **pas vérifié en direct**. `ensurePr` ne s'y fie pas : après un 422, il relit la PR ouverte, et rejette l'erreur s'il n'y en a pas.
- **Conteneur** (vérifié avec Docker 28.2.2) : une seconde création sous le même nom est refusée (`Conflict. The container name "…" is already in use`), et `docker ps -a --filter label=factory.attempt=<id>` retrouve le conteneur, même seulement créé.

## Limites

- **Bail perdu sous un exécuteur vivant** : deux exécutions peuvent lire « absent » puis écrire chacune (ORC-138). Le doublon reste rare et visible : deux commentaires avec le même marqueur.
- **La marque `effect:<id>:started`** de l'appel au modèle est locale (table `meta`), posée après le départ. Un crash entre les deux tue aussi la tentative : au démarrage suivant, `recover()` bloque le ticket et le départ rejoué est refusé. Une marque par `start_run` reste dans `meta`.
- **Un journal repris à zéro** (base neuve sur le même espace Linear) redonne les mêmes ids d'effets aux mêmes tickets : un commentaire d'une vie antérieure de la base passerait pour déjà écrit. La clé suppose un journal qui ne repart pas de zéro.
- **Lignes en attente** : Push et PR attendent le Publisher (ORC-125), qui fera pousser et ouvrir la PR par l'usine au lieu de l'agent (`--force-with-lease` est aujourd'hui interdit à l'agent dans `packs/standard/settings.json`) ; Check run attend le premier check publié par l'usine (`factory/review`, ORC-183) ; Conteneur attend le vrai `SandboxProvider` (ORC-204). Ces tickets branchent `ForgeWriter` et le port `SandboxProvider` sans changer la table.
