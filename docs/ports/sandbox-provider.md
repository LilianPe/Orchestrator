# Port SandboxProvider

Un environnement isolé par tentative, au niveau réseau demandé. Aujourd'hui l'agent travaille dans son worktree : le port n'a qu'un faux, monté par le harnais, que l'orchestrateur n'appelle pas encore.

- Interface : `SandboxProvider` (`src/adapters/sandbox/types.ts`), port nouveau (ORC-225). Niveaux réseau : `none`, `claude-api`, `limited`, `full`.
- Implémentations : `FakeSandboxProvider` (`src/adapters/sandbox/fake.ts`). Pas encore de vraie.
- Suite : `test/contracts/sandbox.contract.ts`, lancée par `src/adapters/sandbox/fake.test.ts`.

Le ticket donnait `WorkspaceManager` → SandboxProvider. ORC-225 a posé `SandboxProvider` à côté, et `WorkspaceManager` (`src/adapters/workspace/types.ts`) reste le port des worktrees tant que les runs n'ont pas de conteneur (ORC-204) : il n'a pas de fiche à part, il disparaîtra dans ce port.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `create(req)` | un sandbox vivant, au niveau réseau de `req.network` | même `runId` : rend le sandbox existant, n'en crée pas de second | non spécifié |
| `destroy(id)` | le sandbox n'existe plus | sans effet | un id inconnu ou déjà détruit est ignoré |

Après `destroy`, un `create` pour le même `runId` donne un nouveau sandbox.

## Idempotence

La clé est l'id de la tentative, `runId` (ligne « Conteneur » d'ORC-162 : un label porte l'id de tentative, cherché avant de créer). Un `create` rejoué rend le sandbox tel qu'il a été créé, même si la requête rejouée demande un autre niveau réseau.

## Fencing

Le sandbox appartient à une tentative : c'est le moteur qui décide quelle tentative est active (ORC-133) et détruit les autres.

## Ce que la suite demande à l'implémentation

`SandboxSubject` : une requête pour un run sans sandbox, et `active()`, les ids des sandboxes vivants (le faux les lit par `active()` ; un vrai, par ses labels).

## Écarts connus

Aucun. `FakeSandboxProvider.create` créait un sandbox à chaque appel : il rend celui du run depuis ORC-189.
