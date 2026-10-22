# Contrats des ports

Le moteur ne parle au monde que par six ports. Chacun a une **fiche** (ce que toute implémentation garantit : méthodes, idempotence, erreurs, fencing) et une **suite de conformité**, paramétrée par l'implémentation : le faux du harnais la passe, et un nouvel adaptateur doit la passer avant d'être branché.

| Port (doc MVP) | Interface | Fiche | Suite | Lancée sur |
|---|---|---|---|---|
| Tracker | `Tracker` | [tracker.md](tracker.md) | `test/contracts/tracker.contract.ts` | `FakeTracker` ; `LinearTracker` en live, lecture seule |
| Forge | `Forge` | [forge.md](forge.md) | `test/contracts/forge.contract.ts` | `FakeForge` ; `GhCliForge` en live |
| Publisher | `Publisher` | [publisher.md](publisher.md) | `test/contracts/publisher.contract.ts` | `FakePublisher` |
| SandboxProvider | `SandboxProvider` | [sandbox-provider.md](sandbox-provider.md) | `test/contracts/sandbox.contract.ts` | `FakeSandboxProvider` |
| CheckRunner | `CheckRunner` | [check-runner.md](check-runner.md) | `test/contracts/check-runner.contract.ts` | `FakeCheckRunner`, `runVerify` |
| AgentRuntime | `Runner` | [agent-runtime.md](agent-runtime.md) | `test/contracts/agent-runtime.contract.ts` | `FakeRunner`, `ClaudeCodeRunner` (faux CLI `claude`) |

Les interfaces gardent leur nom actuel (`Runner` pour AgentRuntime) : elles prendront le nom cible quand le port changera de forme, pas avant.

## Brancher une nouvelle implémentation

Une suite est une fonction `describe<Port>Contract(nom, make, écarts?)`. `make` est appelé par cas et rend un sujet neuf : l'implémentation, plus ce que la suite ne peut pas inventer (un ticket existant, une PR, des commandes qui échouent…). Le type `<Port>Subject` de chaque suite dit quoi fournir ; un champ optionnel absent saute les cas qui en ont besoin (`subjectWith`, `test/contracts/cases.ts`). Un test à côté de l'adaptateur l'appelle ; pour un futur adaptateur de conteneurs, par exemple :

```ts
import { describeSandboxContract } from '../../../test/contracts/sandbox.contract.js';

describeSandboxContract('PodmanSandboxProvider', () => ({
  provider: new PodmanSandboxProvider(/* … */),
  request: { runId: 'r1', ticketId: 'ORC-1', workspacePath: '/w', network: 'none' },
  active: async () => listContainersLabelled('factory.run'),
}));
```

Une suite ne lance aucun service : pour un adaptateur qui parle à un vrai service, le test est un test live (ci-dessous).

## Écarts connus

Un cas qu'une implémentation ne tient pas encore se déclare dans le troisième argument : il tourne en `it.fails` (`caseFor`, `test/contracts/cases.ts`), reste vert tant que l'écart existe, et vire au rouge le jour où l'implémentation s'aligne, ce qui oblige à retirer la déclaration. Limite : `it.fails` reste vert quelle que soit la cause de l'échec ; un cas déclaré ne protège donc pas contre une autre régression dans ce même cas. Écarts déclarés aujourd'hui, tous sur des faux :

| Implémentation | Écart | Fiche |
|---|---|---|
| `FakeTracker` | `moveTo-unknown-state` : accepte un statut que l'équipe n'a pas | [tracker.md](tracker.md#écarts-connus) |
| `FakeRunner` | `duration-limit`, `turn-limit` : ignore les plafonds | [agent-runtime.md](agent-runtime.md#écarts-connus) |

## Tests live

Hors CI, sautés sans leurs variables (règle de [`docs/transition.md`](../transition.md#tests-live-hors-ci)) :

| Test | Variables | Ce qu'il lit |
|---|---|---|
| `src/adapters/tracker/linear/tracker.live.test.ts` | `FACTORY_LIVE_LINEAR_TOKEN` (un jeton d'accès OAuth, envoyé en `Bearer` comme le fait l'instance ; pas une clé d'API personnelle), `FACTORY_LIVE_LINEAR_ISSUE` (un ticket, ex. `ORC-1`) ; option `FACTORY_LIVE_LINEAR_SEARCH`, un mot de son titre | le ticket, sans rien écrire |
| `src/adapters/forge/gh-cli.live.test.ts` | `FACTORY_LIVE_GH_REPO` (un clone local), `FACTORY_LIVE_GH_BRANCH` et `FACTORY_LIVE_GH_PR` (une branche et sa PR, aux checks terminés : une PR mergée convient) ; `gh` connecté | la PR, sans rien écrire |

```bash
FACTORY_LIVE_GH_REPO=$PWD FACTORY_LIVE_GH_BRANCH=orc-168-ci-postgres-docker-rootless FACTORY_LIVE_GH_PR=30 \
  npx vitest run src/adapters/forge/gh-cli.live.test.ts
```
