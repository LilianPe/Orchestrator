# Tests et harnais

Relais se teste sans vrais services : un **harnais** monte l'orchestrateur sur une horloge simulée, un store SQLite en mémoire et un faux adaptateur par port. Cette page explique comment écrire un scénario avec lui.

- Tests unitaires : à côté du code (`*.test.ts`).
- Scénarios : `test/scenarios/` (le harnais, `test/helpers/harness.ts`).
- Bout en bout : `test/e2e/`.

Pendant le travail, lancez seulement les tests des fichiers touchés : `npx vitest run test/scenarios/harness.test.ts`.

## Les faux adaptateurs

Un faux par port, tous montés par `createHarness()` :

| Port (doc MVP) | Interface | Faux | Ce qu'il offre au scénario |
|---|---|---|---|
| Tracker | `Tracker` (`src/adapters/tracker/types.ts`) | `h.tracker` (`FakeTracker`) | `addIssue`, `calls`, `activities(sessionId)` |
| Forge | `Forge` (`src/adapters/forge/types.ts`) | `h.forge` (`FakeForge`) | `setPr`, `setReviewComments` |
| AgentRuntime | `Runner` (`src/adapters/runner/types.ts`) | `h.runner` (`FakeRunner`) | `enqueue({ events, outcome, hold })`, `release(runId)`, `requests` |
| SandboxProvider | `SandboxProvider` (`src/adapters/sandbox/types.ts`) | `h.sandboxes` (`FakeSandboxProvider`) | `create`, `destroy`, `active()`, `created`, `destroyed` |
| CheckRunner | `CheckRunner` (`src/adapters/checks/types.ts`) | `h.checks` (`FakeCheckRunner`) | `failNext(output)`, `enqueue(result)`, `holdNext()`, `calls` |
| Publisher | `Publisher` (`src/adapters/publisher/types.ts`) | `h.publisher` (`FakePublisher`) | `publish`, `published` ; la PR publiée apparaît dans `h.forge`, ouverte, checks en attente |

Les worktrees ont aussi leur faux, `h.workspaces` (`FakeWorkspaces`).

L'**AgentRuntime** du doc MVP est le `Runner` actuel : son faux est `FakeRunner`, il n'est pas renommé tant que le port ne change pas de forme.

Ce qui est branché sur le moteur aujourd'hui :

- `h.checks` exécute les vérifications des jobs (`verify` d'un job). Un scénario peut passer son propre `verify` à `createHarness({ verify })` : il répond à la place du vert par défaut, une fois vide la file de `h.checks` (`failNext`, `enqueue`, `holdNext`), et `h.checks.calls` enregistre toujours chaque appel.
- `h.sandboxes` et `h.publisher` ne sont pas encore appelés par l'orchestrateur : l'agent travaille dans son worktree et pousse lui-même. Le scénario les appelle à la place de l'étape qui les utilisera, et vérifie ce que le moteur en fait (par exemple un `pr.opened` construit depuis la publication).

`FakePublisher` numérote ses PR lui-même (1, 2… par branche) : ne mélangez pas dans un même scénario une PR posée à la main par `h.forge.setPr` et une publication, elles pourraient partager un numéro. Republier une branche la remet ouverte, checks en attente.

Ces interfaces sont **minimales** : elles portent ce dont les faux ont besoin. Leur contrat complet (idempotence, erreurs, fencing) et les suites de conformité viennent d'ORC-189.

## L'horloge simulée

`h.clock` est une `FakeClock`. `await h.advance(ms)` avance l'horloge, déclenche les minuteries échues (debounce, relances) et attend que l'orchestrateur ait tout traité. Aucun scénario n'attend de vrai délai.

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

- La description du ticket doit faire au moins 30 caractères : sinon le contrôle de prise en charge du pack standard (`has_description`) bloque le ticket et aucun run ne démarre.
- `h.send(type, payload, ticketId?)` soumet un événement (ticket `REL-1` par défaut) et attend la fin de son traitement.
- `h.ticket()` lit l'état du ticket dans le store.
- `h.restart()` arrête proprement l'orchestrateur et en relance un neuf sur le même store, comme `relais up` au redémarrage.
- `h.checks.holdNext()` garde le prochain contrôle en cours et rend la fonction qui le termine (vert par défaut, ou le résultat passé). `h.send` et `h.advance` attendent la fin des contrôles en cours : n'attendez l'envoi qu'après avoir relâché le contrôle, et observez l'état intermédiaire avec `vi.waitFor` (exemple dans `test/scenarios/harness.test.ts`).
- `createHarness({ projectYaml })` surcharge le `workflow.yml` du pack standard, comme le fichier `.relais/workflow.yml` d'un projet.

## Le préréglage de test

`testPreset()` (`test/helpers/test-preset.ts`) décrit un enchaînement minimal fait d'étapes factices, avec ses bornes en clair, pour les scénarios et les futurs tests de propriétés (ORC-173) :

- `build` : une étape d'agent (le job `dev`) ;
- `verify` : une étape de contrôle (`fake:check`, exécutée par `h.checks`), bornée par `bounds.verifyAttempts`.

Seuls les runs du job `dev` passent par `verify` : le préréglage vide le `verify` de `dev-feedback`, que `fix-ci` étend, pour que ces deux étapes restent tout l'enchaînement.

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

## Les sept scénarios obligatoires

Chaque scénario est livré par le ticket qui livre le comportement qu'il teste, avec les faux et l'horloge ci-dessus :

| Scénario | Ticket | Faux à piloter |
|---|---|---|
| CI rouge 3 fois | ORC-184 | `h.forge` (checks en échec), `h.runner` |
| `.skip` ajouté | ORC-158 | `h.checks`, puis `h.publisher` quand l'usine poussera |
| Config de tests modifiée | ORC-131 | `h.checks`, puis `h.publisher` quand l'usine poussera |
| Réponse humaine pendant un run | ORC-180 | `h.runner` (`hold`), `h.advance` |
| Redémarrage pendant un contrôle | ORC-220 | `h.checks` (`holdNext`), `h.store`, `h.restart()` |
| Budget épuisé | ORC-216 | `h.runner` (`turns`, `costUsd`, `outcome: 'limit'`) |
| Délégation retirée | ORC-227 | `h.tracker`, `h.runner` (`hold`), `h.sandboxes` |

`h.restart()` est un arrêt propre : il attend la fin des contrôles en cours. Un redémarrage **pendant** un contrôle s'écrit donc aujourd'hui en posant l'état du contrôle dans `h.store` avant `h.restart()` ; le redémarrage brutal du harnais arrive avec ORC-228.
