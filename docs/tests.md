# Tests et harnais

Relais se teste sans vrais services : un **harnais** monte l'orchestrateur sur une horloge simulée, un store SQLite en mémoire et un faux adaptateur par port. Cette page explique comment écrire un scénario avec lui.

- Tests unitaires : à côté du code (`*.test.ts`).
- Scénarios : `test/scenarios/` (le harnais, `test/helpers/harness.ts`).
- Bout en bout : `test/e2e/`.
- Intégration : `test/integration/` (Postgres).
- Isolation : `test/isolation/` (moteur de conteneurs rootless).
- Propriétés de `decide` : `test/properties/` (fast-check).

Pendant le travail, lancez seulement les tests des fichiers touchés : `npx vitest run test/scenarios/harness.test.ts`.

## Les trois projets Vitest

`vitest.config.ts` déclare trois projets, pour que la CI rapide reste rapide :

| Projet | Commande | Ce qu'il couvre |
|---|---|---|
| `unit` | `npm test` | unitaires, scénarios et bout en bout (sauté sans `FACTORY_E2E=1`) |
| `integration` | `npm run test:integration` | `test/integration/`, avec `DATABASE_URL` (Postgres) |
| `isolation` | `npm run test:isolation` | `test/isolation/`, avec `FACTORY_ISOLATION=1` et un moteur rootless |

`npm run test:all` lance les trois. Sans `DATABASE_URL`, les tests d'intégration se sautent ; sans `FACTORY_ISOLATION=1`, les tests d'isolation se sautent. La CI (`.github/workflows/ci.yml`) lance le projet `unit` avec typecheck et lint, les tests de propriétés sur 10 000 séquences (job `properties`), puis Postgres en service pour `integration` et Podman rootless pour `isolation`. Aucun secret n'est défini dans les workflows.

## Les faux adaptateurs

Un faux par port, tous montés par `createHarness()` :

| Port (doc MVP) | Interface | Faux | Ce qu'il offre au scénario |
|---|---|---|---|
| Tracker | `Tracker` (`src/adapters/tracker/types.ts`) | `h.tracker` (`FakeTracker`) | `addIssue`, `calls`, `activities(sessionId)`, `setStates(teamKey, statuts)` (catalogue par équipe, par défaut les statuts du workflow chargé ; un statut hors catalogue est refusé) |
| Forge | `Forge` (`src/adapters/forge/types.ts`) | `h.forge` (`FakeForge`) | `setPr`, `setReviewComments` |
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

Ces interfaces sont **minimales** : elles portent ce dont les faux ont besoin. Leur contrat (méthodes, idempotence, erreurs, fencing) est dans [`docs/ports/`](ports/README.md), une fiche par port ; chaque faux passe la suite de conformité de son port (`test/contracts/`), et un faux qu'on modifie doit continuer à la passer.

## L'horloge simulée

`h.clock` est une `FakeClock`. `await h.advance(ms)` avance l'horloge, termine en `limit` les runs tenus dont le plafond de durée est atteint, déclenche les minuteries échues (aujourd'hui le seul minuteur est le debounce) et attend que l'orchestrateur ait tout traité. Aucun scénario n'attend de vrai délai.

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
    expect(h.ticket()).toMatchObject({ logical: 'dev' });
  });
});
```

- `h.tracker.addIssue({ identifier, title })` pose une description par défaut assez longue. Une description passée au faux doit faire au moins 30 caractères : sinon le contrôle de prise en charge du pack standard (`has_description`) bloque le ticket et aucun run ne démarre.
- `h.send(type, payload, ticketId?)` soumet un événement (ticket `REL-1` par défaut) et attend la fin de son traitement.
- `h.ticket()` lit l'état du ticket dans le store.
- `h.restart()` arrête proprement l'orchestrateur et en relance un neuf sur le même store, comme `relais up` au redémarrage.
- `h.checks.holdNext()` garde le prochain contrôle en cours et rend la fonction qui le termine (vert par défaut, ou le résultat passé). `h.send` et `h.advance` attendent la fin des contrôles en cours : n'attendez l'envoi qu'après avoir relâché le contrôle, et observez l'état intermédiaire avec `vi.waitFor` (exemple dans `test/scenarios/harness.test.ts`).
- `createHarness({ projectYaml })` surcharge le `workflow.yml` du pack standard, comme le fichier `.relais/workflow.yml` d'un projet.

## Le préréglage de test

`testPreset()` (`test/helpers/test-preset.ts`) décrit un enchaînement minimal fait d'étapes factices, avec ses bornes en clair, pour les scénarios et les futurs tests de propriétés (ORC-173) :

- `build` : une étape d'agent (le job `dev`) ;
- `verify` : une étape de contrôle (`fake:check`, exécutée par `h.checks`), bornée par `bounds.verifyAttempts`.

`build` couvre aussi les jobs qui étendent `dev` (`dev-feedback`, `fix-ci`) : ils héritent de son `verify`, comme dans le moteur. Chaque run d'agent, retour humain ou CI rouge compris, est donc suivi d'un contrôle qui consomme la file de `h.checks` et le même compteur.

Avec `verifyAttempts: N`, chaque échec de `verify` relance l'agent sur la même session, et le **N-ième échec bloque le ticket**. Un contrôle vert remet le compteur à zéro.

```ts
const preset = testPreset({ verifyAttempts: 3 });
const h = createHarness({ preset });
for (let i = 0; i < preset.bounds.verifyAttempts; i++) h.checks.failNext('1 test en échec');
// … délégation : 3 runs, 3 contrôles, puis le ticket est bloqué
expect(h.ticket()).toMatchObject({ blocked: true });
```

Un test de propriétés lit ses bornes dans `preset.bounds` au lieu de les recopier. `verifyAttempts` vaut au moins 1 : le schéma de `workflow.yml` accepte 0, que le moteur traite comme 1, et le préréglage refuse cette ambiguïté. Le préréglage se superpose au pack standard ; `projectYaml` et `preset` ne se combinent pas.

Le préréglage de production, `factory/default`, et ses autres compteurs (review, CI rouge) arrivent avec ORC-187. Le scénario d'exemple qui utilise chaque nouveau faux et le préréglage est `test/scenarios/harness.test.ts`.

## Les tests de propriétés de `decide`

`test/properties/decide.prop.test.ts` vérifie les invariants de `decide` tranchés par [ORC-138](decisions/ORC-138.md) (I1 à I12) sur des séquences d'événements générées par fast-check (ORC-173) :

- `events.ts` génère la boîte de réception d'un ticket : des événements de `src/core/types.ts` (un générateur par type, un type ajouté sans générateur ne compile pas) mêlés aux faits que l'orchestrateur enregistre autour de ses effets (`run.started`, `pending.set`…), avec des fragments qui enchaînent un run, sa vérification, la boucle `verify`, la CI rouge, une réponse suivie de son debounce. La séquence est ensuite **désordonnée** (échanges voisins, un mélange complet une fois sur huit) puis reçoit des **doublons** de même id. Les événements isolés et les messages humains venus de l'extérieur sont non fiables une fois sur cinq ; les fragments enchaînés (tentative, boucle `verify`, CI rouge, rapports de la forge) restent fiables, tout comme les événements que l'usine produit elle-même (`run.finished`, `verify.*`, `debounce.fired`, `control.*`), que leurs producteurs marquent fiables.
- `fold.ts` replie la séquence par le pas d'ORC-138, comme `Orchestrator.handle` : un id déjà vu est ignoré, un événement pour un ticket non suivi est journalisé sans décision, sinon `decide` puis `reduce`. Il reprend aussi ce qui, autour de `decide`, change les runs qui démarrent : les faits de `move` et `cleanup`, le job mis en attente (`pending.set`) quand un démarrage dev tombe pendant un run ou une vérification, et le démarrage de ce job par `settle` après un résultat de run. Le lancement lui-même (`run.started`), les minuteurs et la file du scheduler ne sont pas modélisés : le générateur insère leurs faits. Chaque état, événement, décision et le workflow sont gelés en profondeur : un `decide` ou un `reduce` qui écrit dans son entrée échoue.

Une propriété par invariant, sur ce que `decide` porte aujourd'hui. La part d'un invariant dont le mécanisme n'existe pas encore (SHA, portes, gel, risque, `humanInbox`…) est un `it.todo` qui nomme le ticket qui l'apporte. Un invariant que le code viole aujourd'hui est un `it.fails` par contre-exemple minimal, qui rejoue ce contre-exemple : il échoue à chaque exécution, quelle que soit la graine, et seulement sur l'assertion attendue (une autre erreur le fait passer au rouge) ; le jour où le code est corrigé, il passe au rouge, pour qu'on le change en `it` qui lance la propriété avec le contre-exemple dans `examples`. I10 dédoublonne par `Store.recordEvent` (SQLite en mémoire), comme l'orchestrateur. « Projection = rejeu » est vérifiée en mémoire, sur le journal du repli : elle montre que chaque changement appliqué est journalisé et que `reduce` ne lit rien d'autre ; le rejeu d'un journal durable, enregistré hors du repli, attend le harnais Postgres d'ORC-228.

| Variable | Défaut | Rôle |
|---|---|---|
| `NUM_RUNS` | 200 | séquences par propriété ; la CI en lance 10 000 |
| `PROP_SEED` | aléatoire | rejoue la graine qu'affiche fast-check en cas d'échec |

```bash
npm test                                   # propriétés comprises, 200 séquences
NUM_RUNS=10000 npm run test:properties     # comme le job `properties` de la CI
PROP_SEED=149083903 npm run test:properties
```

## Les sept scénarios obligatoires

Chaque scénario est livré par le ticket qui livre le comportement qu'il teste, avec les faux et l'horloge ci-dessus :

| Scénario | Ticket | Faux à piloter |
|---|---|---|
| CI rouge 3 fois | ORC-184 | `h.forge` (checks en échec), `h.runner` |
| `.skip` ajouté | ORC-158 | `h.checks`, puis `h.publisher` quand l'usine poussera |
| Config de tests modifiée | ORC-131 | `h.checks`, puis `h.publisher` quand l'usine poussera |
| Réponse humaine pendant un run | ORC-180 | `h.runner` (`hold`), `h.advance` |
| Redémarrage pendant un contrôle | ORC-220 | `h.store` (contrôle en cours posé à la main), `h.restart()` |
| Budget épuisé | ORC-216 | `h.runner` (`turns`, `costUsd`, `outcome: 'limit'`) |
| Délégation retirée | ORC-227 | `h.tracker`, `h.runner` (`hold`), `h.sandboxes` |

`h.restart()` est un arrêt propre : il attend la fin des contrôles en cours. Un redémarrage **pendant** un contrôle s'écrit donc aujourd'hui en posant l'état du contrôle dans `h.store` avant `h.restart()` ; le redémarrage brutal du harnais arrive avec ORC-228.
