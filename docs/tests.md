# Tests et harnais

Relais se teste sans vrais services : un **harnais** monte l'orchestrateur (son worker, ses exécuteurs d'outbox, ses minuteries en base) sur une horloge simulée, une base de test (SQLite en mémoire, ou Postgres dans le projet `scenarios-pg`) et un faux adaptateur par port. Cette page explique comment écrire un scénario avec lui.

- Tests unitaires : à côté du code (`*.test.ts`).
- Scénarios : `test/scenarios/` (le harnais, `test/helpers/harness.ts`).
- Bout en bout : `test/e2e/`.
- Intégration : `test/integration/` (Postgres).
- Isolation : `test/isolation/` (moteur de conteneurs rootless).
- Propriétés de `decide` : `test/properties/` (fast-check).
- Rejeu des journaux enregistrés : `test/replay/` (ORC-174).
- Injection de pannes : `test/scenarios/faults.test.ts` ; chaos `kill -9` : `test/chaos/` (ORC-163).

Pendant le travail, lancez seulement les tests des fichiers touchés : `npx vitest run test/scenarios/harness.test.ts`.

## Les projets Vitest

`vitest.config.ts` déclare cinq projets, pour que la CI rapide reste rapide :

| Projet | Commande | Ce qu'il couvre |
|---|---|---|
| `unit` | `npm test` | unitaires, scénarios et bout en bout (sauté sans `FACTORY_E2E=1`) |
| `integration` | `npm run test:integration` | `test/integration/`, avec `DATABASE_URL` (Postgres) |
| `scenarios-pg` | `npm run test:integration` | les scénarios de `test/scenarios/` une seconde fois, chaque harnais sur une base Postgres à lui (ORC-228), avec `DATABASE_URL` |
| `isolation` | `npm run test:isolation` | `test/isolation/`, avec `FACTORY_ISOLATION=1` et un moteur rootless |
| `chaos` | `npm run test:chaos` | `test/chaos/` : un vrai démon tué par SIGKILL au hasard (ORC-163), sur Postgres avec `DATABASE_URL`, sur un fichier SQLite sinon |

`npm run test:all` lance les cinq. Sans `DATABASE_URL`, les tests d'intégration et `scenarios-pg` se sautent ; sans `FACTORY_ISOLATION=1`, les tests d'isolation se sautent. La CI (`.github/workflows/ci.yml`) lance le projet `unit` avec typecheck et lint, les tests de propriétés sur 10 000 séquences (job `properties`), le rejeu des journaux enregistrés (`npm run test:replay` dans le job `test`, voir plus bas), puis Postgres en service pour `integration` et `scenarios-pg` (même job, `npm run test:integration`) et pour le chaos sur 500 événements (job `chaos`, voir plus bas), et Podman rootless pour `isolation`. Aucun secret n'est défini dans les workflows.

**Les scénarios sur Postgres (ORC-228).** Le projet `scenarios-pg` reprend les fichiers de `test/scenarios/` avec `test/helpers/pg-harness.ts` en fichier de setup : chaque `createHarness()` y reçoit sa propre base, clonée (`create database … template`) d'une base migrée une fois par fichier, et supprimée à la fin du test. Les deux stores passent ainsi les mêmes scénarios sans changer une ligne de ceux-ci. Ils tournent dans le job `integration`, qui a déjà Postgres, plutôt que dans `test` : le job rapide garde SQLite (quelques secondes), le second passage coûte environ 30 s de plus au job `integration`. Les quelques scénarios écrits pour un fichier SQLite tué par SIGKILL (`harnessStoreKind() === 'postgres'` les saute) ont leur équivalent Postgres dans `test/integration/`.

## Les faux adaptateurs

Un faux par port, tous montés par `createHarness()` :

| Port (doc MVP) | Interface | Faux | Ce qu'il offre au scénario |
|---|---|---|---|
| Tracker | `Tracker` (`src/adapters/tracker/types.ts`) | `h.tracker` (`FakeTracker`) | `addIssue`, `calls`, `activities(sessionId)`, `comments(identifier)`, `agentSessions(identifier)`, `externalUrls(sessionId)`, `written()` (ces lectures, pour la suite de conformité), `setStates(teamKey, statuts)` (catalogue par équipe, par défaut les statuts du workflow chargé ; un statut hors catalogue est refusé) |
| Forge | `Forge` (`src/adapters/forge/types.ts`) | `h.forge` (`FakeForge`) | `setPr`, `setReviewComments`, `offline` (vrai : chaque lecture rejette, comme une forge injoignable) |
| AgentRuntime | `Runner` (`src/adapters/runner/types.ts`) | `h.runner` (`FakeRunner`) | `enqueue({ events, outcome, turns, hold })`, `release(runId)`, `requests` ; plafonds tenus : `turns` au-delà de `limits.turns`, ou un run tenu quand `h.advance(ms)` porte `h.clock` à `limits.durationMs` depuis son départ, finit en `limit` (avancer `h.clock` seule ne le termine pas) |
| SandboxProvider | `SandboxProvider` (`src/adapters/sandbox/types.ts`) | `h.sandboxes` (`FakeSandboxProvider`) | `create`, `destroy`, `active()`, `created`, `destroyed` |
| CheckRunner | `CheckRunner` (`src/adapters/checks/types.ts`) | `h.checks` (`FakeCheckRunner`) | `failNext(output)`, `enqueue(result)`, `holdNext()`, `calls` |
| Publisher | `Publisher` (`src/adapters/publisher/types.ts`) | `h.publisher` (`FakePublisher`) | `publish`, `published` ; la PR publiée apparaît dans `h.forge`, ouverte, checks en attente |

Les worktrees ont aussi leur faux, `h.workspaces` (`FakeWorkspaces`).

L'**AgentRuntime** du doc MVP est le `Runner` actuel : son faux est `FakeRunner`, il n'est pas renommé tant que le port ne change pas de forme.

Ce qui est branché sur le moteur aujourd'hui :

- `h.checks` exécute les vérifications des jobs (`verify` d'un job). Un scénario peut passer son propre `verify` à `createHarness({ verify })` : il répond à la place du vert par défaut, une fois vide la file de `h.checks` (`failNext`, `enqueue`, `holdNext`), et `h.checks.calls` enregistre toujours chaque appel.
- `h.sandboxes` et `h.publisher` ne sont pas encore appelés par l'orchestrateur : l'agent travaille dans son worktree et pousse lui-même. Le scénario les appelle à la place de l'étape qui les utilisera, et vérifie ce que le moteur en fait (par exemple un `pr.opened` construit depuis la publication).

`FakePublisher` numérote ses PR lui-même, dans l'ordre où il les ouvre (1, 2…) : ne mélangez pas dans un même scénario une PR posée à la main par `h.forge.setPr` et une publication, elles pourraient partager un numéro. Republier une branche met à jour sa PR, checks en attente ; si `h.forge` montre cette PR mergée ou fermée, la publication en ouvre une nouvelle, comme sur GitHub.

Ces interfaces sont **minimales** : elles portent ce dont les faux ont besoin. Leur contrat (méthodes, idempotence, erreurs, fencing) est dans [`docs/ports/`](ports/README.md), une fiche par port ; chaque faux passe la suite de conformité de son port (`test/contracts/`), et un faux qu'on modifie doit continuer à la passer. Les cas d'erreur et d'effet ont aussi leurs contrôles négatifs (`test/contracts/negative-controls.test.ts`, [détail](ports/README.md#contrôles-négatifs)).

## L'horloge simulée

`h.clock` est une `FakeClock`, que le store lit aussi : baux de l'outbox et de la file, backoffs, lignes échues. `await h.advance(ms)` avance l'horloge, termine en `limit` les runs tenus dont le plafond de durée est atteint, déclenche les minuteries échues de la table `timers` (`TimerService.tick`, qui écrit `timer.fired` dans l'inbox ; aujourd'hui seul le debounce en pose par une règle), fait passer le worker comme sa boucle le ferait (`orch.poll()` : effets dont le backoff ou le bail a expiré, lignes qui les attendaient) et attend que l'orchestrateur ait tout traité. Aucun scénario n'attend de vrai délai : un backoff de 20 ms se passe par `h.advance(20)`.

## Écrire un scénario

```ts
import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';

describe('mon comportement', () => {
  it('un run tenu ouvert garde le ticket en dev', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ hold: true }); // le run reste ouvert jusqu'à h.runner.release(runId)
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(180_000);
    expect(await h.ticket()).toMatchObject({ logical: 'dev' });
  });
});
```

- `h.tracker.addIssue({ identifier, title })` pose une description par défaut assez longue. Une description passée au faux doit faire au moins 30 caractères : sinon le contrôle de prise en charge du pack standard (`has_description`) bloque le ticket et aucun run ne démarre.
- `h.send(type, payload, ticketId?)` soumet un événement (ticket `REL-1` par défaut) et attend la fin de son traitement.
- `await h.ticket()` lit l'état du ticket dans le store (asynchrone, comme tout le store). `createHarness({ store })` fait tourner le harnais sur un store donné plutôt que sur sa base (le fichier SQLite qu'un processus tué a laissé) ; ce store garde sa propre horloge, `advance` n'en fait donc expirer ni bail ni backoff. `createHarness({ wrapStore })` enveloppe le store de la base, quelle qu'elle soit (un store qui échoue exprès) : c'est la forme à préférer, le scénario passe alors sur les deux stores.
- `h.restart()` arrête proprement l'orchestrateur et en relance un neuf sur la même base, comme `relais up` au redémarrage. `h.restart({ mode: 'brutal' })` jette le processus comme un `kill -9` : ni arrêt, ni attente, ni nettoyage. Son store est coupé (`mortal` dans `harness.ts`) : ses appels non partis ne partent jamais, ceux en cours finissent en base sans que personne n'en reçoive le résultat ; ses promesses et ses minuteries restent figées. Ses adaptateurs le sont aussi (`gate`, ORC-163) : un processus mort ne commente plus, ne poste plus d'activité, ne lance plus de run. Un autre processus repart sur la même base ; les effets que le mort avait réclamés y restent `running` jusqu'à l'expiration de leur bail, qui se passe par `h.advance`. `h.store` et `h.orch` sont toujours ceux du processus vivant. Exemple : `test/scenarios/restart.test.ts` (événement dans l'inbox non décidé, effet réclamé à moitié fait, minuterie échue, puis rien de perdu ni de doublon visible).
- `h.checks.holdNext()` garde le prochain contrôle en cours et rend la fonction qui le termine (vert par défaut, ou le résultat passé). `h.send` et `h.advance` attendent la fin des contrôles en cours : n'attendez l'envoi qu'après avoir relâché le contrôle, et observez l'état intermédiaire avec `vi.waitFor` (exemple dans `test/scenarios/harness.test.ts`).
- `createHarness({ projectYaml })` surcharge le `workflow.yml` du pack standard, comme le fichier `.relais/workflow.yml` d'un projet.

## Le préréglage de test

`testPreset()` (`test/helpers/test-preset.ts`) décrit un enchaînement minimal fait d'étapes factices, avec ses bornes en clair, pour les scénarios et les futurs tests de propriétés (ORC-173) :

- `build` : une étape d'agent (le job `dev`) ;
- `verify` : une étape de contrôle (`fake:check`, exécutée par `h.checks`), bornée par `bounds.verifyAttempts`.

`bounds.ciFixAttempts` (défaut 2, `limits.ci_fix_attempts`) borne la boucle de CI rouge : `fix-ci` lancé au plus N fois, puis la CI rouge suivante bloque le ticket. Il accepte 0, qui a un sens propre (bloquer dès la première CI rouge).

`build` couvre aussi les jobs qui étendent `dev` (`dev-feedback`, `fix-ci`) : ils héritent de son `verify`, comme dans le moteur. Chaque run d'agent, retour humain ou CI rouge compris, est donc suivi d'un contrôle qui consomme la file de `h.checks` et le même compteur.

Avec `verifyAttempts: N`, chaque échec de `verify` relance l'agent sur la même session, et le **N-ième échec bloque le ticket**. Un contrôle vert remet le compteur à zéro.

```ts
const preset = testPreset({ verifyAttempts: 3 });
const h = createHarness({ preset });
for (let i = 0; i < preset.bounds.verifyAttempts; i++) h.checks.failNext('1 test en échec');
// … délégation : 3 runs, 3 contrôles, puis le ticket est bloqué
expect(await h.ticket()).toMatchObject({ blocked: true });
```

Un test de propriétés lit ses bornes dans `preset.bounds` au lieu de les recopier. `verifyAttempts` vaut au moins 1 : le schéma de `workflow.yml` accepte 0, que le moteur traite comme 1, et le préréglage refuse cette ambiguïté. Le préréglage se superpose au pack standard ; `projectYaml` et `preset` ne se combinent pas.

Le préréglage de production, `factory/default`, et ses autres compteurs (review, CI rouge) arrivent avec ORC-187. Le scénario d'exemple qui utilise chaque nouveau faux et le préréglage est `test/scenarios/harness.test.ts`.

## Les tests de propriétés de `decide`

`test/properties/decide.prop.test.ts` vérifie les invariants de `decide` tranchés par [ORC-138](decisions/ORC-138.md) (I1 à I12) sur des séquences d'événements générées par fast-check (ORC-173) :

- `events.ts` génère la boîte de réception d'un ticket : des événements de `src/core/types.ts` (un générateur par type, un type ajouté sans générateur ne compile pas) mêlés aux faits que l'orchestrateur enregistre autour de ses effets (`run.started`, `pending.set`…), avec des fragments qui enchaînent un run, sa vérification, la boucle `verify`, la CI rouge, les rapports de la forge (CI, merge, PR fermée sans merge), une réponse suivie de son debounce. La séquence est ensuite **désordonnée** (échanges voisins, un mélange complet une fois sur huit) puis reçoit des **doublons** de même id. Les événements isolés et les messages humains venus de l'extérieur sont non fiables une fois sur cinq ; les fragments enchaînés (tentative, boucle `verify`, CI rouge, rapports de la forge) restent fiables, tout comme les événements que l'usine produit elle-même (`run.finished`, `verify.*`, `timer.fired`, `control.*`), que leurs producteurs marquent fiables. Un message humain sur trois porte un acteur signé et les rôles résolus pour lui (ORC-186 : membre qui écrit et merge, membre sans droit GitHub, écrivain GitHub hors équipe, personne sans rôle, ou aucun acteur pour un événement non fiable), et la délégation d'ouverture est signée une fois sur quatre ; les autres ne portent pas de rôles, comme les lignes journalisées avant ORC-186, et `decide` ne vérifie rien sur eux.
- `fold.ts` replie la séquence par le pas d'ORC-138, comme `Orchestrator.handle` : un id déjà vu est ignoré, un événement pour un ticket non suivi est journalisé sans décision, sinon `decide` puis `reduce`. Il reprend aussi ce qui, autour de `decide`, change les runs qui démarrent : les faits de `move` et `cleanup`, le job mis en attente (`pending.set`) quand un démarrage dev tombe pendant un run ou une vérification, le démarrage de ce job par `settle` après un résultat de run, les refus de `startRun` (ticket fusionné, non délégué ou bloqué) et les chemins sensibles que `launch` donne au run selon les retours qu'il lit (`launches` d'un pas, ORC-274 ; les commentaires de review de la forge ne sont pas modélisés). Les faits du lancement (`run.started`), les minuteurs et la file du scheduler ne sont pas modélisés : le générateur insère leurs faits. Chaque état, événement, décision et le workflow sont gelés en profondeur : un `decide` ou un `reduce` qui écrit dans son entrée échoue.

Une propriété par invariant, sur ce que `decide` porte aujourd'hui. La part d'un invariant dont le mécanisme n'existe pas encore (SHA, portes, gel, risque, `humanInbox`…) est un `it.todo` qui nomme le ticket qui l'apporte. Un invariant que le code viole aujourd'hui est un `it.fails` par contre-exemple minimal, qui rejoue ce contre-exemple : il échoue à chaque exécution, quelle que soit la graine, et seulement sur l'assertion attendue (une autre erreur le fait passer au rouge) ; le jour où le code est corrigé, il passe au rouge, pour qu'on le change en `it` qui lance la propriété avec le contre-exemple dans `examples`. I10 dédoublonne par `Store.recordEvent` (SQLite en mémoire), comme l'orchestrateur. « Projection = rejeu » est vérifiée en mémoire, sur le journal du repli : elle montre que chaque changement appliqué est journalisé et que `reduce` ne lit rien d'autre ; le rejeu d'un journal durable, enregistré par le store, est l'oracle de rejeu ci-dessous (ORC-174). Pour la matrice d'autorisations (ORC-186) : un événement refusé ne change rien au travail (ni run, ni minuteur, ni retour gardé, ni déblocage) et n'a qu'une réponse, aucune sans acteur signé ni session ; seuls les événements que `mayCheck` désigne sont refusés ; un événement autorisé est décidé comme sans matrice ; sans acteur signé, rien qui lancerait, relancerait ou nourrirait un run ne passe. Une réponse refusée compte comme traitée pour I6 : son auteur reçoit le refus dans la session. Le journal enregistré `authz-refused-then-allowed` (rejeu) garde les rôles de chaque événement humain, un refus et une action autorisée ; le chaos signe un événement sur sept par quelqu'un hors de l'équipe, dont le refus passe par l'outbox comme tout effet.

| Variable | Défaut | Rôle |
|---|---|---|
| `NUM_RUNS` | 200 | séquences par propriété ; la CI en lance 10 000 |
| `PROP_SEED` | aléatoire | rejoue la graine qu'affiche fast-check en cas d'échec |

```bash
npm test                                   # propriétés comprises, 200 séquences
NUM_RUNS=10000 npm run test:properties     # comme le job `properties` de la CI
PROP_SEED=149083903 npm run test:properties
```

## L'oracle de rejeu

`decide` étant pure, rejouer le journal d'un ticket doit redonner les mêmes décisions (ORC-174). Ce qu'il faut pour les refaire est enregistré dans la transaction de décision elle-même, à côté de la ligne du journal : table `decision_trace` (une ligne par décision, clé l'id de l'événement ; sur Postgres, la table du schéma initial, colonne `decision`), avec le numéro de la ligne dans le journal du ticket, l'horloge de la décision (`at`), le hash du workflow sur lequel le ticket est figé, la projection lue sous le verrou (`before`), puis ce que la décision a écrit : nouvelle projection, effets de l'outbox, minuteries, remise à zéro des minuteries, et la `trace` de `decide` (gardée pour lecture, pas comparée). `Store.ticketJournal` relit le journal d'un ticket avec ses décisions.

`src/runtime/replay.ts` refait chaque décision par `planDecision` (`src/core/decision-plan.ts`), la fonction pure qu'appelle aussi la transaction de décision de l'orchestrateur, après les upcasters. Chaque décision repart de **sa** projection enregistrée, pas de la sortie de la précédente : entre deux décisions, l'orchestrateur change aussi la projection hors décision (`apply` : run lancé, worktree préparé, statut déplacé), et ces changements ne sont pas des décisions. Les lignes de journal sans décision enregistrée (écrites avant ORC-174, ou par `recordEvent`) sont comptées et lues, pas comparées.

**Journaux enregistrés.** `test/replay/journals/` contient des journaux exportés au format de `factory replay --export` (`format: 1`, `projectId`, `ticketId`, `workflows` par hash, `entries` : `{ event, decision }`). Faute de journaux réels pour l'instant, ils sont enregistrés à partir de scénarios du harnais (`test/replay/scenarios.ts`) ; `review-merge-done.v1.json` est le même journal que `review-merge-done.json` avec son `status.changed` écrit comme avant la version 2 du schéma (`ticket.moved`, sans version ni taint), pour que le rejeu passe par l'upcaster ; `check-failed-then-feedback.v2.json` est ce journal tel que l'enregistrait le moteur d'avant ORC-161 (schéma version 2 : `debounce.fired`, minuteries liées à un job), gardé tel quel (`npm run replay:record` ne le réécrit pas) pour que le rejeu d'un ancien journal reste vert ; `dead-letter-then-repair.json` contient un événement mis de côté puis réparé (`dead_letter.added`, `dead_letter.repaired`, ORC-175) ; `signed-actor-then-untrusted.json` passe une délégation par l'ingestion Linear (acteur signé, `trusted`), puis une réponse et un `retiens` non fiables, sans acteur : le retour porte sa taint au run `dev-feedback` (chemins sensibles) et `remember` est refusé (ORC-160) ; `merge-revert-ci.json` passe par l'ingestion GitHub deux essais d'un run de CI, le merge avec son commit de merge, ce commit poussé sur la branche par défaut puis son revert trois jours plus tard : `ci.run_completed` et `default_branch.pushed` sont tracés sans rien décider (ORC-278). Ils sont rejoués à chaque PR, par `npm test` (`test/replay/replay.test.ts`) et par l'étape `npm run test:replay` du job `test` de la CI (`factory replay test/replay/journals`, qui échoue aussi sur un journal illisible ou sans décision).

Le rejeu en régression refait chaque décision sur la version du workflow sur laquelle le ticket était figé, gardée dans le journal : il garde le **moteur** (`decide`, `reduce`, `planDecision`, les upcasters). Un changement du **préréglage** ou du pack ne s'y voit pas, puisque le ticket reste sur son ancienne version ; `test/replay/replay.test.ts` rejoue donc aussi chaque journal enregistré en what-if sur le workflow d'aujourd'hui de son scénario (pack standard et préréglage de `scenarios.ts`) : une modification du pack qui change une de leurs décisions passe au rouge, sur l'événement exact.

**Un changement qui doit changer une décision.** Le rejeu passe au rouge et nomme l'événement. Si le changement est voulu, réenregistrez les journaux des scénarios (`npm run replay:record`) et relisez leur diff dans la PR ; un journal réel ne se réenregistre pas, il se remplace par un nouvel export. Pour voir l'effet d'un nouveau préréglage avant de le déployer : `factory replay test/replay/journals --what-if <workflow.yml>`.

**Ajouter des journaux réels.** Sur une instance : `factory replay --export <ID> --out test/replay/journals/<id>.json` (avec `FACTORY_HOME` et, en Postgres, `FACTORY_DATABASE_URL` de l'instance). Un journal contient le texte des événements (titre du ticket, réponses dans le fil, commentaires) : relisez-le avant de le committer, ou ne gardez que des tickets sans contenu sensible. Un journal réel est rejoué en régression ; son what-if contre le préréglage de son projet se lance à la main (`factory replay <journal> --what-if <.factory/workflow.yml du projet>`). Seules les décisions prises depuis ORC-174 sont enregistrées : d'un ticket plus ancien, seules les dernières décisions sont comparées.

## L'injection de pannes et le chaos `kill -9`

ORC-163 coupe la chaîne à chacun de ses maillons et vérifie qu'après la coupure, puis la reprise, **aucun événement n'est perdu** et **aucun effet n'est fait deux fois de façon visible**.

**Les points de coupure** (`test/helpers/faults.ts`). Rien n'est ajouté au code de production : chaque point est une enveloppe d'un port que le harnais donne à l'orchestrateur (le store, le faux tracker, le faux runner), posée par `createHarness({ faults })`. Un `Faults` porte au plus une panne prévue, `{ point, mode, match?, nth? }` : au n-ième passage du point (filtré par `match`, sur l'événement ou l'effet), elle lève une `FaultError` (`throw`) ou tue le processus (`kill` : le `mortal` de sa vie meurt, comme sous `kill -9`, et l'appel ne répond jamais). Les points, dans l'ordre de la chaîne :

| Point | Où |
|---|---|
| `webhook.accept` | avant l'écriture dans l'inbox d'un événement venu de l'extérieur : le producteur n'a pas de réponse |
| `inbox.write` | après l'écriture d'une ligne d'inbox, avant que son auteur l'apprenne : la réponse est perdue |
| `decide.before` | transaction de décision, avant `decide` |
| `decide.after` | dans la transaction, après `decide`, avant le COMMIT : annulée (un `kill` y lève aussi, pour que la base annule, comme pour un vrai processus tué) |
| `decide.commit` | après le COMMIT, avant que le worker l'apprenne |
| `outbox.claim` | après la réclamation d'une ligne d'outbox (son bail validé) |
| `effect.before`, `effect.after` | autour de l'appel externe d'un effet (faux tracker ou runner), attribué à la ligne d'outbox en cours |
| `effect.complete` | après la validation de la fin de la ligne (son résultat `effect:<id>` dans l'inbox) |
| `timer.fire`, `timer.fired` | avant la transaction qui déclenche une minuterie échue, après son COMMIT |
| `run.result` | avant l'écriture dans l'inbox du résultat d'un run ou d'un contrôle |
| `run.write`, `run.written` | à un lancement, avant et après la première écriture de sa tentative (sa marque de départ la nomme déjà, ORC-277), avant que le runner la démarre |

`test/scenarios/faults.test.ts` joue un scénario (délégation, run, réponse en revue humaine, son debounce, le run de retour) sous chaque point, en `throw` puis en `kill`, sur SQLite et, dans `scenarios-pg`, sur Postgres. Le pilote se comporte en producteur : un événement sans réponse est renvoyé avec le même id, comme Linear renvoie un webhook ; un processus tué est remplacé par un autre sur la même base (`restart({ mode: 'brutal' })`), puis l'horloge passe les baux et les backoffs.

**Le vérificateur** (`checkChain`). Une fois tout retombé : chaque événement acquitté est journalisé exactement une fois ; l'inbox, l'outbox (ni `pending`, ni `running`, ni `dead`) et les dead letters sont vides ; le journal de chaque ticket, exporté, est rejoué bit pour bit par l'oracle (ORC-174), chaque ligne avec sa décision ; aucun appel visible (commentaire, activité, lien, lancement de run) n'est fait deux fois pour la même ligne d'outbox. Les appels au faux tracker et au faux runner sont attribués à la ligne d'outbox que le processus exécutait (le registre de `Faults`) ; déplacer un ticket ou poser une étiquette est idempotent et n'est pas compté. Un run lancé deux fois pour une même ligne d'outbox, de dev ou de question, est une violation : la marque de départ nomme la tentative avant qu'elle soit écrite, et le départ repris qui la trouve ne relance rien (ORC-277) ; `recover()` règle la tentative coupée (ticket bloqué, question à reposer). Un autre effet visible refait est classé à part (`atLeastOnce`) : c'est l'« au moins une fois » de l'outbox, qu'ORC-162 referme en rendant chaque effet idempotent. Depuis ORC-162, le cas de `post_output` coupé après son appel externe est un `it` : le rejeu retrouve l'activité déjà postée. Depuis ORC-277, le run d'une question coupé après son lancement est un `it` (lancé une fois, seul message : « Reposez la question »), le point `run.write` coupe un lancement avant l'écriture de sa tentative (question : rejouée, lancée une fois, aucune invitation à reposer ; dev : ticket bloqué par `recover()`, rien de lancé), et le point `run.written` après, avant le runner, y compris pour une question tirée de la file par `drain` (ressortie après son bail, pas relancée). Un lancement par `drain` n'a pas de ligne d'outbox : le vérificateur ne lui attribue pas ses appels, et ce test compte les lancements du faux runner. Dans le chaos, le faux tracker de chaque vie du démon repart des écritures des vies précédentes (commentaires, activités, liens, labels, statuts, relus dans le fichier des appels), comme Linear les garde quand le démon redémarre : sans cela, un effet rejoué ne pourrait rien retrouver.

**Le chaos** (`test/chaos/`). `daemon.ts` est un vrai processus : l'orchestrateur, son worker, ses exécuteurs d'outbox et ses minuteries sur Postgres (ou un fichier SQLite), avec les faux adaptateurs, démarré comme `factory up` (`recover`, avis de reprise, minuteries, `tick`, boucle du worker). Ses runs durent quelques dizaines de millisecondes, pour que des coupures tombent pendant. Le pilote (`chaos.test.ts`) lui envoie par IPC des événements Linear sur 20 tickets (délégations, réponses, questions, `agent:stop`, `agent:reprendre`, passage en revue IA), plus vite qu'il ne les traite, et le tue par `SIGKILL` à un moment tiré au hasard après chaque démarrage (`TerminateProcess` sous Windows), puis en relance un sur la même base, l'horloge simulée avancée au-delà du bail des réclamations du mort. Un événement est acquitté après son écriture dans l'inbox ; un événement sans réponse est renvoyé au démon suivant. Chaque appel visible est ajouté, au moment où il agit, à un fichier qui survit aux processus. À la fin, sans plus de coupure, le dernier démon finit le travail, puis `checkChain` vérifie la même chose que pour les points de coupure. Contrairement au `mortal` du harnais, la coupure est celle du noyau : une transaction en cours est annulée par la base.

| Variable | Défaut | Rôle |
|---|---|---|
| `CHAOS_EVENTS` | 100 | événements envoyés ; une coupure tous les dix, au moins trois |
| `CHAOS_SEED` | aléatoire | graine des événements et des délais de coupure, affichée à chaque passage |
| `CHAOS_TICKETS` | 20 | tickets sur lesquels les événements se répartissent |
| `CHAOS_STRICT_EFFECTS` | strict | un effet visible refait (`atLeastOnce`) fait échouer (ORC-162) ; `0` : il est seulement affiché. Un run lancé deux fois pour une même ligne d'outbox, question comprise (ORC-277), échoue toujours |

```bash
npm run test:chaos                                              # 100 événements, sur un fichier SQLite
DATABASE_URL=postgres://… CHAOS_EVENTS=500 npm run test:chaos   # comme le job `chaos` de la CI
DATABASE_URL=postgres://… CHAOS_SEED=4242 npm run test:chaos    # rejoue une graine
```

**Pourquoi un job CI à lui, à 500 événements.** Le critère d'ORC-163 est 500 événements sur Postgres, dans un job dédié. 500 événements, c'est une cinquantaine de coupures et autant de démarrages d'un processus `tsx` : environ une minute et demie sur un poste, trop pour le job `test`, qui reste sur SQLite et en quelques secondes. Le job `chaos` tourne en parallèle des autres, avec son propre Postgres : il n'allonge pas la PR au-delà du job le plus lent, et chaque PR passe le critère entier plutôt qu'une version réduite. La graine change à chaque passage, pour explorer d'autres moments de coupure, et s'affiche dans le message d'échec. Les moments exacts où tombent les coupures dépendent de la machine : rejouer une graine redonne les mêmes événements et les mêmes délais, pas forcément le même entrelacement. En local, le défaut de 100 événements tourne en une vingtaine de secondes.

## Les sept scénarios obligatoires

Chaque scénario est livré par le ticket qui livre le comportement qu'il teste, avec les faux et l'horloge ci-dessus :

| Scénario | Ticket | Faux à piloter |
|---|---|---|
| CI rouge 3 fois | ORC-184 | `h.forge` (checks en échec), `h.runner` |
| `.skip` ajouté | ORC-158 | `h.checks`, puis `h.publisher` quand l'usine poussera |
| Config de tests modifiée | ORC-131 | `h.checks`, puis `h.publisher` quand l'usine poussera |
| Réponse humaine pendant un run | ORC-180 | `h.runner` (`hold`), `h.advance` |
| Redémarrage pendant un contrôle | ORC-220 | `h.checks.holdNext()`, `h.restart({ mode: 'brutal' })` |
| Budget épuisé | ORC-216 | `h.runner` (`turns`, `costUsd`, `outcome: 'limit'`) |
| Délégation retirée | ORC-227 | `h.tracker`, `h.runner` (`hold`), `h.sandboxes` |

`h.restart()` est un arrêt propre : il attend la fin des contrôles en cours. Un redémarrage **pendant** un contrôle s'écrit avec `h.restart({ mode: 'brutal' })` (ORC-228), le contrôle tenu par `h.checks.holdNext()`. Les points de coupure injectables à chaque étape de la chaîne et le chaos `kill -9` sur 500 événements (ORC-163) sont décrits plus haut.
