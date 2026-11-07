# Port Forge

La forge de code, en lecture : la PR d'une branche, l'état de ses checks, ses fils de review non résolus.

- Interface : `Forge` (`src/adapters/forge/types.ts`), nom gardé.
- Implémentations : `GitHubAppForge` (`src/adapters/forge/github-app.ts`, par l'API REST et GraphQL de GitHub, en GitHub App : la forge de production), `GhCliForge` (`src/adapters/forge/gh-cli.ts`, par la CLI `gh`), `FakeForge` (`src/adapters/forge/fake.ts`).
- Suite : `test/contracts/forge.contract.ts`, lancée par `src/adapters/forge/fake.test.ts`, `src/adapters/forge/github-app.test.ts` (sur un `fetch` scripté, sans réseau), `src/adapters/forge/gh-cli.test.ts` (sur un `gh` scripté, sans réseau) et `src/adapters/forge/gh-cli.live.test.ts`.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `findPr(repo, branche)` | `undefined` sans PR ; sinon la PR de la branche (numéro, URL `https://`, état `OPEN`/`MERGED`/`CLOSED`), `checks` parmi `pending`/`pass`/`fail`/`none`, `failedChecks` non vide exactement quand `checks` vaut `fail` ; une copie | lecture : même réponse | rejette si la forge ne répond pas, y compris quand elle rend la PR mais pas ses checks, et quand elle rend des checks illisibles, même sans erreur (ORC-305 : le relevé des PR journalise l'erreur et réessaie au tour suivant) ; une PR ouverte sans aucun check donne `none` ; un check dans un état que la forge ne connaît pas ne donne ni `pass` ni `none` (ORC-303) |
| `unresolvedReviewComments(repo, n)` | les fils de review non résolus, en `FeedbackItem` de source `review` (auteur, corps, date) ; une copie | lecture | rejette si la forge ne répond pas |

## Idempotence

Le port `Forge` ne fait que lire. Les écritures de l'usine sont à part, dans `ForgeWriter` (même fichier, ORC-162), chacune idempotente ; elles n'ont pas de suite de conformité. Le [Publisher](publisher.md) (ORC-125) appelle `ensurePr` et `gitAccess`, le passage en *Human Review* appelle `markPrReady` :

| Méthode | Ce qu'elle garantit | Rejouée |
|---|---|---|
| `ensurePr(repo, { branch, base, title, body, draft? })` | la PR **ouverte** de la branche, créée si la branche n'en a pas, en draft si demandé ; une PR fermée ou mergée n'est pas réutilisée | rend la même PR, `deduplicated: true` ; après une course perdue (422), relit la PR ouverte |
| `markPrReady(repo, n)` (ORC-125) | la PR sort de draft ; la mutation GraphQL est la seule voie, l'API REST ne le permet pas | lue d'abord : une PR déjà sortie n'écrit rien |
| `gitAccess(repo)` (ORC-125) | l'URL du dépôt et, **dans l'environnement seulement**, le jeton de l'App limité à ce dépôt, pour le git de l'usine ; jamais donné à un run | relit le jeton (son cache) |
| `upsertCheckRun(repo, { sha, name, externalId, status, … })` | le check run du sha qui porte `externalId`, créé ou mis à jour | met à jour le même check run, `deduplicated: true` |
| `mergePr(repo, n, sha, { unchecked? })` (ORC-148) | merge la PR seulement si sa tête est encore `sha` (GitHub le vérifie dans le même appel) ; `unchecked` (la tête n'a aucun check) : seulement dans un dépôt sans CI (tête toujours sans check, aucun workflow Actions actif du dépôt, hors workflows dynamiques de GitHub, commit de base de la PR sans check) ; un refus pour une raison à dire à l'humain est une **réponse** : `head_moved` (409), `not_mergeable` avec le message de GitHub (405), `checks_missing` (tête sans check dans un dépôt qui a une CI) ; toute autre erreur est levée, pour que l'effet soit rejoué | PR déjà mergée sur `sha` : `{ merged: true, deduplicated: true }`, aucune écriture |

Seuls `GitHubAppForge` et `FakeForge` l'implémentent : GitHub ne laisse qu'une app créer un check run, pas le jeton utilisateur de `gh`. Détail et limites : [Idempotence des effets externes](../idempotence.md).

## Fencing

Sans objet : aucune écriture.

## Ce que la suite demande à l'implémentation

`ForgeSubject` : un dépôt, une branche sans PR, et en option une branche avec sa PR et les fils non résolus attendus, la même implémentation face à une forge qui ne répond pas (`unreachable`), la branche d'une PR ouverte dont les checks sont illisibles (`unreadableChecks`), celle d'une PR ouverte sans aucun check (`noChecks`), celle d'une PR que la forge rend mais dont elle ne rend pas les checks (`checksDown`), et celle d'une PR ouverte dont un check est dans un état que la forge ne connaît pas, les autres verts (`unknownBucket`).

- `FakeForge` : `offline = true` fait rejeter ses lectures. Il pose une PR sans check pour `noChecks` ; il n'a ni checks illisibles, ni panne entre la PR et ses checks, ni état de check inconnu (il rend ceux qu'on lui pose) : ces trois cas sont sautés pour lui.
- `GhCliForge` sur un `gh` scripté : `gh` qui sort en erreur pour la forge injoignable, une sortie de `gh pr checks` qui n'est pas une liste de checks, en code 0, pour les checks illisibles : `findPr` rejette, avec la commande et le début de la sortie dans l'erreur (de même pour une sortie non vide qui n'est pas une liste de checks en code non nul, avec ou sans le message de la PR sans check), et pour `gh pr checks` ce que rendent les `gh` 2.63 et 2.103 : code 1 et stdout vide dans les deux cas, avec `no checks reported on the '<branche>' branch` sur stderr pour la PR sans check, une erreur réseau pour la panne. Seul ce message les distingue ; des checks en échec ou en attente arrivent en JSON, quel que soit le code de sortie. `GhCliForge` ne rend `pass` que si tous les buckets valent `pass` ou `skipping` ; un bucket inconnu donne `pending`, sauf à côté d'un bucket `fail` ou `cancel`, qui donne `fail`. Pour `unknownBucket`, une liste où des checks `pass` côtoient un bucket que `gh` ne documente pas (`mystery`) et un bucket vide.
- `GitHubAppForge` sur un `fetch` scripté, sans réseau : un `fetch` qui lève pour la forge injoignable (le jeton d'installation n'arrive même pas) ; pour les checks illisibles, une réponse 200 de `check-runs` sans sa liste `check_runs` : `findPr` rejette, avec l'appel et le début de la réponse dans l'erreur, de même pour une réponse qui n'est pas du JSON, une entrée sans `name` ou `status`, une réponse de `status` sans sa liste `statuses`, et une liste de PR qui n'est pas une liste, ou dont une entrée n'a pas son numéro, son URL, son état ou sa tête, ou a une base sans sa branche ou son sha (jamais lue comme « pas de PR »). Lue comme une liste vide, une telle réponse donnerait `none`, et ouvrirait le merge `unchecked` d'un dépôt qu'elle ferait passer pour un dépôt sans CI ; il rejette donc aussi. Les deux listes sont lues page par page, 100 par page : un check en échec au-delà de la première page reste dans le verdict. Au-delà de 10 pages (1000 entrées), il rejette, de même pour les workflows ci-dessous : un serveur qui ignore `page` le ferait boucler sans fin. Pour `mergePr` `unchecked`, la liste des workflows Actions suit la même règle (toutes les pages ; une réponse sans sa liste rejette, jamais lue comme « aucun workflow »), comme la PR qu'il lit avant de merger ; des réglages du dépôt qui ne sont pas un objet rejettent aussi. Pour la PR sans check, deux listes vides ; pour la panne, un 502 sur `check-runs` ; pour `unknownBucket`, un check run `completed` de conclusion inconnue et un statut d'état inconnu à côté d'un check vert : chacun compte comme `pending`.
- `GhCliForge` en live lit une vraie PR (variables dans [l'index](README.md#tests-live)) ; sa forge injoignable est le vrai `gh`, derrière un proxy sur un port local fermé.

## Écarts connus

`GitHubAppForge` ne lançait pas cette suite et lisait une liste de checks absente de la réponse de GitHub comme une liste vide, et seulement la première page des check runs : il la lance et rejette ces réponses depuis ORC-273.

`FakeForge` rendait ses objets internes : il rend des copies depuis ORC-189, comme `FakeTracker`.
