# Contrats des ports

Le moteur ne parle au monde que par six ports. Chacun a une **fiche** (ce que toute implémentation garantit : méthodes, idempotence, erreurs, fencing) et une **suite de conformité**, paramétrée par l'implémentation : le faux du harnais la passe, et un nouvel adaptateur doit la passer avant d'être branché.

| Port (doc MVP) | Interface | Fiche | Suite | Lancée sur |
|---|---|---|---|---|
| Tracker | `Tracker` | [tracker.md](tracker.md) | `test/contracts/tracker.contract.ts` | `FakeTracker` ; `LinearTracker` en live, lecture seule |
| Forge | `Forge` | [forge.md](forge.md) | `test/contracts/forge.contract.ts` | `FakeForge`, `GhCliForge` (sur un `gh` scripté) ; `GhCliForge` en live |
| Publisher | `Publisher` | [publisher.md](publisher.md) | `test/contracts/publisher.contract.ts` | `FakePublisher` |
| SandboxProvider | `SandboxProvider` | [sandbox-provider.md](sandbox-provider.md) | `test/contracts/sandbox.contract.ts` | `FakeSandboxProvider` |
| CheckRunner | `CheckRunner` | [check-runner.md](check-runner.md) | `test/contracts/check-runner.contract.ts` | `FakeCheckRunner`, `runVerify` |
| AgentRuntime | `Runner` | [agent-runtime.md](agent-runtime.md) | `test/contracts/agent-runtime.contract.ts` | `FakeRunner`, `ClaudeCodeRunner` (faux CLI `claude`) |

Les interfaces gardent leur nom actuel (`Runner` pour AgentRuntime) : elles prendront le nom cible quand le port changera de forme, pas avant.

## Brancher une nouvelle implémentation

Une suite est une fonction `describe<Port>Contract(nom, make)`. `make` est appelé par cas et rend un sujet neuf : l'implémentation, plus ce que la suite ne peut pas inventer (un ticket existant, une PR, des commandes qui échouent…). Le type `<Port>Subject` de chaque suite dit quoi fournir ; un champ optionnel absent saute les cas qui en ont besoin (`subjectWith`, `test/contracts/cases.ts`). Un test à côté de l'adaptateur l'appelle ; pour un futur adaptateur de conteneurs, par exemple :

```ts
import { describeSandboxContract } from '../../../test/contracts/sandbox.contract.js';

describeSandboxContract('PodmanSandboxProvider', () => ({
  provider: new PodmanSandboxProvider(/* … */),
  request: { runId: 'r1', ticketId: 'ORC-1', workspacePath: '/w', network: 'none' },
  active: async () => listContainersLabelled('factory.run'),
}));
```

Une suite ne lance aucun service : pour un adaptateur qui parle à un vrai service, le test est un test live (ci-dessous).

Chaque garantie d'erreur ou d'effet d'une fiche a son cas. Pour une panne, le sujet fournit de quoi la provoquer (un faux qui échoue sur demande, comme `FakeForge.offline`, ou le vrai adaptateur pointé vers un dossier absent ou un réseau coupé) ; pour un effet que le port ne relit pas (un commentaire, une activité), le sujet fournit de quoi le relire (`written` du Tracker). Une garantie qu'on ne sait pas tester ne s'écrit pas dans la fiche.

## Contrôles négatifs

Un cas qui passe contre tous les sujets ne prouve rien s'il passerait aussi contre un sujet qui viole sa garantie. `test/contracts/negative-controls.test.ts` lance chaque cas d'erreur et chaque cas d'effet des suites (rejeu, idempotence, indépendance, arrêt), et « seulement eux » de `listDelegated`, contre des sujets qui violent chacun une garantie exprès : le cas doit y échouer sur une assertion. Ce qu'ils couvrent, par port :

| Port | Cas sous contrôle |
|---|---|
| AgentRuntime | run en échec, run qui ne peut pas démarrer, plafonds de durée et de tours, `stop` (pendant le run, rejoué, après la fin), runs indépendants |
| CheckRunner | commande en échec (code, sortie, ordre), délai dépassé, commande qui ne démarre pas, rejeu |
| Forge | branche sans PR, forge injoignable, checks illisibles |
| Tracker | ticket inconnu en lecture et en écriture, statut absent de la team, `moveTo` rejoué, état final de `setLabels`, effets des écritures, `ensureSession`, `listDelegated` |
| SandboxProvider | `destroy` d'un id inconnu ou déjà détruit, `create` rejoué, une sandbox par run, une nouvelle après `destroy` |
| Publisher | republier une branche, une PR par branche, une nouvelle PR après merge ou fermeture |

Les sujets fautifs de chaque cas sont nommés par les titres de `negative-controls.test.ts`.

Un cas qui attend une réponse du port (un résultat, un `undefined`, un `destroy` ou un rejeu sans effet) la lit par `resolved` (`test/contracts/cases.ts`) : un sujet qui rejette au lieu de répondre y échoue sur une assertion, pas sur sa propre erreur. Tout rejet y compte, un `TypeError` du sujet fautif compris, par exception à la règle du paragraphe suivant : un contrôle qui passe ainsi ne dit pas s'il a touché la garantie visée.

Toutes les suites déclarent leurs cas par `describeContract` (`test/contracts/cases.ts`). Leur troisième argument, `{ violates: [noms de cas] }`, les met dans ce mode : seuls ces cas tournent, et chacun ne passe que s'il échoue sur une assertion (une autre erreur, un `TypeError` du sujet par exemple, fait échouer le contrôle, de même qu'un sujet qui n'a pas le champ dont le cas a besoin, au lieu de le sauter). Un nom qui ne désigne aucun cas, ou une liste vide, fait échouer le fichier, pour qu'un cas renommé ne laisse pas son contrôle tourner à vide. Un nouveau cas d'erreur ou d'effet arrive avec son contrôle.

## Écarts connus

Aucun : chaque implémentation passe tous les cas qu'elle lance. `LinearTracker` en live ne lance que les lectures (sans `states`, les cas d'écriture sont sautés) : ses écritures ne passent par aucune suite. Les faux qui s'en écartaient ont été alignés par ORC-189 ; chaque fiche dit lesquels, et ce qu'un scénario doit déclarer depuis (catalogue de statuts de `FakeTracker`, horloge de `FakeRunner`).

Une implémentation qui ne tiendrait pas un cas ne le déclare pas dans sa suite : elle s'aligne, ou le cas sort du contrat avec la fiche, par une décision écrite.

## Tests live

Hors CI, sautés sans leurs variables (règle de [`docs/transition.md`](../transition.md#tests-live-hors-ci)) :

| Test | Variables | Ce qu'il lit |
|---|---|---|
| `src/adapters/tracker/linear/tracker.live.test.ts` | `FACTORY_LIVE_LINEAR_TOKEN` (le jeton d'accès OAuth de l'app, envoyé en `Bearer` comme le fait l'instance ; pas une clé d'API personnelle), `FACTORY_LIVE_LINEAR_ISSUE` (un ticket, ex. `ORC-1`) ; options `FACTORY_LIVE_LINEAR_SEARCH`, un mot de son titre, et `FACTORY_LIVE_LINEAR_DELEGATED` avec `FACTORY_LIVE_LINEAR_NOT_DELEGATED`, deux tickets de la même équipe, l'un délégué à l'app (pas terminé ni annulé), l'autre non | le ticket et les tickets délégués à l'app (l'utilisateur du jeton), sans rien écrire |
| `src/adapters/forge/gh-cli.live.test.ts` | `FACTORY_LIVE_GH_REPO` (un clone local), `FACTORY_LIVE_GH_BRANCH` et `FACTORY_LIVE_GH_PR` (une branche et sa PR, aux checks terminés : une PR mergée convient) ; `gh` connecté | la PR, sans rien écrire ; la forge injoignable passe par un proxy sur un port local fermé |

```bash
FACTORY_LIVE_GH_REPO=$PWD FACTORY_LIVE_GH_BRANCH=orc-168-ci-postgres-docker-rootless FACTORY_LIVE_GH_PR=30 \
  npx vitest run src/adapters/forge/gh-cli.live.test.ts
```
