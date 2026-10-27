# Port Forge

La forge de code, en lecture : la PR d'une branche, l'état de ses checks, ses fils de review non résolus.

- Interface : `Forge` (`src/adapters/forge/types.ts`), nom gardé.
- Implémentations : `GhCliForge` (`src/adapters/forge/gh-cli.ts`, par la CLI `gh`), `FakeForge` (`src/adapters/forge/fake.ts`).
- Suite : `test/contracts/forge.contract.ts`, lancée par `src/adapters/forge/fake.test.ts`, `src/adapters/forge/gh-cli.test.ts` (sur un `gh` scripté, sans réseau) et `src/adapters/forge/gh-cli.live.test.ts`.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `findPr(repo, branche)` | `undefined` sans PR ; sinon la PR de la branche (numéro, URL `https://`, état `OPEN`/`MERGED`/`CLOSED`), `checks` parmi `pending`/`pass`/`fail`/`none`, `failedChecks` non vide exactement quand `checks` vaut `fail` ; une copie | lecture : même réponse | rejette si la forge ne répond pas ; des checks illisibles donnent `none` |
| `unresolvedReviewComments(repo, n)` | les fils de review non résolus, en `FeedbackItem` de source `review` (auteur, corps, date) ; une copie | lecture | rejette si la forge ne répond pas |

## Idempotence

Le port ne fait que lire. L'ouverture et la mise à jour de la PR passent par le [Publisher](publisher.md) ; les check runs (ligne « Check run » d'ORC-162, mise à jour par `external_id`) seront une nouvelle méthode, avec ORC-181.

## Fencing

Sans objet : aucune écriture.

## Ce que la suite demande à l'implémentation

`ForgeSubject` : un dépôt, une branche sans PR, et en option une branche avec sa PR et les fils non résolus attendus, la même implémentation face à une forge qui ne répond pas (`unreachable`), et la branche d'une PR ouverte dont les checks sont illisibles (`unreadableChecks`).

- `FakeForge` : `offline = true` fait rejeter ses lectures. Il n'a pas de checks illisibles (il rend ceux qu'on lui pose) : ce cas est sauté pour lui.
- `GhCliForge` sur un `gh` scripté : `gh` qui sort en erreur pour la forge injoignable, une sortie de `gh pr checks` qui n'est pas du JSON pour les checks illisibles.
- `GhCliForge` en live lit une vraie PR (variables dans [l'index](README.md#tests-live)) ; sa forge injoignable est le vrai `gh`, derrière un proxy sur un port local fermé.

## Écarts connus

Aucun. `FakeForge` rendait ses objets internes : il rend des copies depuis ORC-189, comme `FakeTracker`.
