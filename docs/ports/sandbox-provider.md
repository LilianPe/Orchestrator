# Port SandboxProvider

Un environnement isolé par tentative : un conteneur créé pour elle et détruit après, qui ne voit ni l'hôte, ni le démon, ni les autres runs (ORC-204). Le pipeline exprime des exigences ; le fournisseur prend un backend qui les satisfait, ou il refuse.

- Interface : `SandboxProvider` (`src/adapters/sandbox/types.ts`), port posé par ORC-225, élargi par ORC-204. Niveaux réseau : `none`, `claude-api`, `limited`, `full`. Niveaux d'isolation : `L3` (conteneur rootless), `L4` (gVisor), `L5` (microVM) ; seul `L3` existe au MVP.
- Implémentations :
  - `FakeSandboxProvider` (`src/adapters/sandbox/fake.ts`) : le faux du harnais, qui n'isole rien et rend ce qu'on lui scripte pour `exec` ;
  - `SandboxRouter` (`src/adapters/sandbox/router.ts`) : choisit le backend de chaque sandbox (ci-dessous) ;
  - le backend conteneur (`src/adapters/sandbox/docker-rootless.ts`), piloté par la CLI `docker` ou `podman`, au niveau `L3`, sans navigateur ni services.
- Suite : `test/contracts/sandbox.contract.ts`, lancée par `src/adapters/sandbox/fake.test.ts` et `src/adapters/sandbox/router.test.ts` (le routeur sur un faux).

Le ticket donnait `WorkspaceManager` → SandboxProvider. ORC-225 a posé `SandboxProvider` à côté, et `WorkspaceManager` (`src/adapters/workspace/types.ts`) reste le port des worktrees : le worktree est monté dans le sandbox, il n'y est pas créé.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `create(req)` | un sandbox vivant pour `req.runId`, qui porte le niveau réseau demandé (`req.network`, appliqué par le proxy de sortie, ci-dessous), sur un backend qui satisfait `req.requirements` | même `runId` : rend le sandbox existant, n'en crée pas de second (le routeur rejette s'il n'a pas ce niveau réseau ou ne satisfait pas les exigences) | rejette, en nommant l'exigence non satisfaite, quand aucun backend ne les satisfait toutes ; aucun sandbox n'est créé |
| `exec(id, argv, opts?)` | lance `argv` dans le sandbox jusqu'au bout et rend son code de sortie, `stdout` et `stderr` ; `cwd` vaut `/work` par défaut | relance la commande | rejette sur un id inconnu ou détruit ; un code non nul est un résultat, pas un rejet |
| `spawnCommand(id, argv, opts?)` | la commande hôte (`command`) qui lance `argv` dans le sandbox, stdio attaché, pour un runner qui lit sa sortie au fil de l'eau, et ce que le processus hôte doit avoir dans son environnement (`env`) ; les valeurs de `opts.env` ne figurent jamais dans la commande | même commande | lève sur un id inconnu |
| `findByAttempt(runId)` | le sandbox vivant de la tentative, par son label | sans effet | `undefined` quand il n'y en a pas, ou plus après `destroy` |
| `list()` | chaque sandbox vivant que le fournisseur a fait, avec son `runId`, pour que `recover()` détruise ceux des tentatives mortes | sans effet | aucune |
| `destroy(id)` | le sandbox n'existe plus | sans effet | un id inconnu ou déjà détruit est ignoré |

Après `destroy`, un `create` pour le même `runId` donne un nouveau sandbox.

## L'environnement du conteneur

`opts.env` est pour la commande du conteneur, jamais pour le processus du moteur sur l'hôte. Le backend conteneur le transporte sous des noms neutres (`-e FACTORY_SANDBOX_ENV_<n>`, valeurs dans l'environnement du processus CLI), et un petit `sh` dans le conteneur rend à chaque valeur son nom, retire les noms neutres et devient la commande. Sous son propre nom, une variable serait aussi lue par le moteur : mesuré sur Podman 5.8 rootless, `HOME` et `XDG_DATA_HOME` déplacent son stockage (« no container with name or ID »), `XDG_RUNTIME_DIR` et `TMPDIR` son dossier d'exécution, `CONTAINER_HOST` sa cible. Docker lit de même `DOCKER_HOST`. L'image doit donc avoir `sh`. Un nom qui n'est pas un nom de variable est refusé.

## Exigences et refus

`req.requirements` : un niveau d'isolation minimal (`minLevel`, ordonné `L3` < `L4` < `L5`), `browser` et une liste de `services`. Un backend les satisfait toutes ou n'est pas pris : jamais de repli silencieux sur un backend moins isolé, ni sur l'hôte. Le refus est un rejet de `create` dont le message nomme ce qui manque (`level >= L5`, `browser`, `service postgres`). Au MVP, `L4`, `L5`, un navigateur et tout service sont donc refusés.

## Le routeur

`SandboxRouter` reçoit une liste de backends, chacun avec un nom, un `SandboxProvider` et ce qu'il sait faire (`level`, `browser`, `services`). Il est lui-même un `SandboxProvider` :

- `create` demande d'abord `findByAttempt(runId)` à chaque backend : un `create` rejoué rend le sandbox existant, quel que soit le backend qui le tient, s'il a le niveau réseau demandé et satisfait les exigences (niveau d'isolation, capacités de son backend) ; sinon il rejette, sans jamais le rendre. Sinon il prend le premier backend qui satisfait toutes les exigences, ou rejette en disant, backend par backend, ce qui lui manque.
- `exec`, `spawnCommand` et `destroy` vont au backend qui a fait l'id. Le routeur s'en souvient en mémoire ; après un redémarrage du démon, `list()` et `findByAttempt` le réapprennent des backends. Pour un id qu'il ne connaît pas, `destroy` ne fait rien, `exec` rejette, `spawnCommand` lève.
- `list()` met bout à bout les listes des backends.

## Idempotence

La clé est l'id de la tentative, `runId`, porté par le label `factory.attempt=<runId>` et cherché avant de créer (ligne « Conteneur » d'ORC-162). Un `create` rejoué rend le sandbox tel qu'il a été créé. Une requête rejouée avec un autre niveau réseau ou des exigences qu'il ne satisfait pas est rejetée par le routeur (et le backend conteneur pour le réseau) ; la suite de contrat ne le vérifie pas.

Avec plusieurs démons sur un même moteur, chacun pose aussi `factory.instance=<id>` (12 hexadécimaux du sha256 de son `FACTORY_HOME`) et ne cherche que ses conteneurs : `recover()` ne détruit pas ceux d'un autre.

## Fencing

Le sandbox appartient à une tentative : c'est le moteur qui décide quelle tentative est active (ORC-133) et détruit les autres, au démarrage par `list()` dans `recover()`.

## Ce que la suite demande à l'implémentation

`SandboxSubject` :

- `request` : une requête pour un run sans sandbox ;
- `active()` : les ids des sandboxes vivants (le faux les lit par `active()` ; un vrai, par ses labels) ;
- `unsatisfiable` (optionnel) : des exigences que le sujet ne sait pas satisfaire et un motif du message de refus qui doit les nommer ; sans lui, le cas du refus est sauté (le faux, qui ne regarde pas les exigences, n'en déclare pas).

Le cas `exec` lance `EXEC_PROBE` (`sh -c`, qui écrit sur les deux sorties et sort en 3) : un vrai sandbox l'exécute, un faux scripte sa réponse.

## Écarts connus

- **Réseau appliqué par le proxy de sortie (ORC-213).** Le backend conteneur tourne toujours en `--network none`. Avec le proxy de l'usine, il monte le socket du run et le certificat de l'autorité de sortie, et c'est le proxy qui applique le niveau ; sans proxy, rien ne sort, quel que soit le niveau. Le `Sandbox` rendu porte le niveau demandé (un `create` rejoué le compare). Un conteneur vivant dont le socket n'est pas tenu par ce processus (démon redémarré) n'est pas rendu : il est détruit et refait. Voir [interface-et-securite.md](../interface-et-securite.md#réseau-des-sandboxes).
- `FakeSandboxProvider` ne regarde pas les exigences : il crée toujours un sandbox `L3`. Le refus est vérifié sur le routeur.
- `FakeSandboxProvider.create` créait un sandbox à chaque appel : il rend celui du run depuis ORC-189.
