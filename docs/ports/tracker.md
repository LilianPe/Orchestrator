# Port Tracker

Le suivi des tickets : lire un ticket, le déplacer, l'étiqueter, commenter, et parler dans sa session d'agent.

- Interface : `Tracker` (`src/adapters/tracker/types.ts`), nom gardé.
- Implémentations : `LinearTracker` (`src/adapters/tracker/linear/tracker.ts`), `FakeTracker` (`src/adapters/tracker/fake.ts`).
- Suite : `test/contracts/tracker.contract.ts`, lancée par `src/adapters/tracker/fake.test.ts` et `src/adapters/tracker/linear/tracker.live.test.ts`.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `getIssue(id)` | le ticket, `teamKey` = préfixe de l'identifiant ; une copie que l'appelant peut modifier | lecture | rejette sur un ticket inconnu avec `IssueNotFoundError`, distincte d'une erreur de lecture |
| `listDelegated(teamKey)` | les tickets de l'équipe délégués à l'app, et seulement eux | lecture | — |
| `search(term)` | les tickets que le terme trouve, dont ceux qui l'ont dans leur titre, avec URL et statut | lecture | — |
| `moveTo(id, statut)` | le ticket est dans ce statut | sans effet de plus | rejette sur un ticket inconnu ; sur un statut que l'équipe n'a pas, rejette et laisse le statut |
| `setLabels(id, add, remove)` | l'état final : `add` posés (créés s'ils manquent), `remove` retirés ; retirer un label absent est ignoré ; un label d'un groupe exclusif (groupe de labels Linear, `FakeTracker.setLabelGroup`) retire les autres labels de son groupe, deux labels d'un même groupe dans `add` sont refusés ; rien n'est écrit si le ticket l'a déjà | n'écrit rien | rejette sur un ticket inconnu |
| `comment(id, corps, effectId?)` | un commentaire sur le ticket ; avec `effectId`, il porte `<!-- factory:effect=<id> -->` (et, chez Linear, un id client dérivé de l'effet) | **écrit un second commentaire** : l'appelant cherche d'abord avec `findComment` | rejette sur un ticket inconnu |
| `findComment(id, effectId)` | l'id du commentaire du ticket écrit pour cet effet, `undefined` sinon | lecture | rejette sur un ticket inconnu |
| `ensureSession(id)` | un identifiant de session d'agent sur le ticket | peut ouvrir une autre session | rejette sur un ticket inconnu |
| `activity(session, a, effectId?)` | une activité dans la session (`thought`, `response`, `elicitation`, `error`, `action`, éphémère ou non) ; avec `effectId`, sous un id dérivé de l'effet | écrit une seconde activité : l'appelant cherche d'abord avec `findActivity` | non spécifié (le faux accepte une session inconnue) |
| `findActivity(session, effectId)` | l'id de l'activité de la session écrite pour cet effet, `undefined` sinon | lecture | non spécifié |
| `addExternalUrl(session, label, url)` | un lien sur la session ; rien si la session a déjà cette URL | n'écrit rien | non spécifié |
| `setSessionPlan(session, plan)` | le plan de la session est `plan`, en entier (ORC-171) | réécrit le même état | non spécifié ; l'usine journalise l'erreur et continue |

## Idempotence

Les écritures rejouables sans dommage sont celles qui écrivent un état final : `moveTo`, `setLabels`, `addExternalUrl` et `setSessionPlan`. `comment` et `activity` d'un effet de l'outbox sont clés par l'id de l'effet (ORC-162) : le moteur cherche avec `findComment` / `findActivity` avant d'écrire, et un rejeu n'écrit rien. Sans `effectId` (avis de reprise, réponses hors outbox, relais du flux d'un run), ou pour `ensureSession`, un rejeu écrit en double. Le détail, et ce que l'API Linear permet, est dans [Idempotence des effets externes](../idempotence.md) ; ces cas sont testés par `test/scenarios/idempotency.test.ts` et `linear/tracker.test.ts`, pas encore par la suite de conformité (ORC-189).

## Fencing

Aucun au niveau du port : il n'a pas de notion de tentative. Les échos de nos propres écritures (labels, statuts) sont filtrés par le moteur (`putEcho`/`isEcho`), pas par l'adaptateur.

## Ce que la suite demande à l'implémentation

`TrackerSubject` : un ticket existant, un identifiant absent de la même équipe, et en option un terme de recherche, deux statuts de l'équipe, une équipe avec un ticket délégué et un non délégué, et `written`, qui relit ce que `comment`, `ensureSession`, `activity` et `addExternalUrl` ont écrit (le port ne sait pas le relire ; `FakeTracker` le fournit par `written()`). Les cas d'écriture ne tournent que si le sujet donne les deux statuts : jamais contre un espace partagé.

## Écarts connus

Aucun. `FakeTracker` acceptait n'importe quel nom de statut : depuis ORC-189, il a un catalogue par équipe et refuse, dans `moveTo` comme dans `addIssue`, un statut qui n'y est pas.

- Par défaut, chaque équipe a les statuts du workflow standard (`STANDARD_STATES`, `packs/standard/workflow.yml` ; un test vérifie qu'ils ne divergent pas). Le harnais des scénarios passe ceux de la config du workflow qu'il charge.
- Le catalogue ne porte que les statuts que le workflow nomme ; une vraie équipe Linear en a d'autres (Backlog, Canceled…). Un scénario qui a besoin d'un statut hors catalogue le déclare : `h.tracker.setStates('REL', [...h.tracker.statesOf('REL'), 'Backlog'])` (garde les statuts du workflow chargé), ou `new FakeTracker([...])` pour toutes les équipes.

Le live `LinearTracker` tourne en lecture seule (sans statuts) : `getIssue`, `search` et `listDelegated`, avec l'utilisateur du jeton comme app ; variables dans [l'index](README.md#tests-live). Ses écritures, et donc leurs effets, ne passent par aucune suite.
