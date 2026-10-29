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

Le port `Forge` ne fait que lire. Les écritures de l'usine sont à part, dans `ForgeWriter` (même fichier, ORC-162), chacune idempotente ; elles ne sont pas encore appelées (le [Publisher](publisher.md), ORC-125, appellera `ensurePr`) et n'ont pas de suite de conformité :

| Méthode | Ce qu'elle garantit | Rejouée |
|---|---|---|
| `ensurePr(repo, { branch, base, title, body })` | la PR **ouverte** de la branche, créée si la branche n'en a pas ; une PR fermée ou mergée n'est pas réutilisée | rend la même PR, `deduplicated: true` ; après une course perdue (422), relit la PR ouverte |
| `upsertCheckRun(repo, { sha, name, externalId, status, … })` | le check run du sha qui porte `externalId`, créé ou mis à jour | met à jour le même check run, `deduplicated: true` |
| `mergePr(repo, n, sha)` (ORC-148) | merge la PR seulement si sa tête est encore `sha` (GitHub le vérifie dans le même appel) ; un refus pour une raison à dire à l'humain est une **réponse** : `head_moved` (409), `not_mergeable` avec le message de GitHub (405) ; toute autre erreur est levée, pour que l'effet soit rejoué | PR déjà mergée sur `sha` : `{ merged: true, deduplicated: true }`, aucune écriture |

Seuls `GitHubAppForge` et `FakeForge` l'implémentent : GitHub ne laisse qu'une app créer un check run, pas le jeton utilisateur de `gh`. Détail et limites : [Idempotence des effets externes](../idempotence.md).

## Fencing

Sans objet : aucune écriture.

## Ce que la suite demande à l'implémentation

`ForgeSubject` : un dépôt, une branche sans PR, et en option une branche avec sa PR et les fils non résolus attendus, la même implémentation face à une forge qui ne répond pas (`unreachable`), et la branche d'une PR ouverte dont les checks sont illisibles (`unreadableChecks`).

- `FakeForge` : `offline = true` fait rejeter ses lectures. Il n'a pas de checks illisibles (il rend ceux qu'on lui pose) : ce cas est sauté pour lui.
- `GhCliForge` sur un `gh` scripté : `gh` qui sort en erreur pour la forge injoignable, une sortie de `gh pr checks` qui n'est pas du JSON pour les checks illisibles.
- `GhCliForge` en live lit une vraie PR (variables dans [l'index](README.md#tests-live)) ; sa forge injoignable est le vrai `gh`, derrière un proxy sur un port local fermé.

## Écarts connus

Aucun. `FakeForge` rendait ses objets internes : il rend des copies depuis ORC-189, comme `FakeTracker`.
