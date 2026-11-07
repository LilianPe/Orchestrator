# Port CheckRunner

Les commandes de vérification d'un job (`verify`), lancées hors de l'agent, et leur verdict.

- Interface : `CheckRunner` (`src/adapters/checks/types.ts`), port nouveau (ORC-225) ; `run` a le type `Verifier` de `src/core/verify.ts`. Le `Verifier` du ticket, c'est ce type.
- Implémentations : `runVerify` (`src/core/verify.ts`, `bash -c` dans un dossier ; `{ run: runVerify }` est un `CheckRunner`), `FakeCheckRunner` (`src/adapters/checks/fake.ts`). Avec les sandboxes, `verify` ne passe pas par ce port : `runCleanVerify` (`src/core/clean-verify.ts`, ORC-151) lance les commandes dans un sandbox neuf, sur un clone du SHA figé, et rejette au lieu de répondre quand il n'a pas de verdict. Ce port reste pour le `setup` sans sandbox et pour `FACTORY_ALLOW_HOST_VERIFY=1`.
- Suite : `test/contracts/check-runner.contract.ts`, lancée par `src/adapters/checks/fake.test.ts` et `src/adapters/checks/run-verify.test.ts`.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `run(cwd, commandes, timeoutMs?)` | lance **toutes** les commandes, dans l'ordre ; `ok` vrai exactement quand aucune n'échoue ; chaque échec porte sa commande, son code de sortie et sa sortie ; une commande qui dépasse `timeoutMs` échoue avec un code `null` ; aucune commande, c'est un succès | relance les commandes | ne rejette pas : une commande qui ne démarre pas est un échec de code `null` |

## Idempotence

Le port ne publie rien : rejouer, c'est relancer les commandes, sans effet externe de plus. Le verdict n'est stable que si les commandes le sont.

## Fencing

Le résultat ne porte pas de tentative : c'est le moteur qui le rattache à son run (`verify.passed` et `verify.failed` portent le `runId`). Le fencing de `runCleanVerify` est le même : son verdict, ou `verify.errored`, porte le `runId`.

## Ce que la suite demande à l'implémentation

`CheckRunnerSubject` : un dossier, une commande qui passe, deux commandes qui échouent avec des codes distincts et le texte qu'elles affichent, et en option une commande qui dépasse 200 ms, un dossier où aucune commande ne démarre (`runVerify` : un dossier absent, où `bash` ne se lance pas), et une commande qui passe en comptant ses lancements, pour vérifier qu'un rejeu relance. Le faux interprète ces commandes par un `Verifier` de repli (celui de son constructeur).

## Écarts connus

Aucun. `FakeCheckRunner` ne transmettait pas `timeoutMs` à son `Verifier` de repli : depuis ORC-189, il le transmet, et la suite y joue la commande lente par sa table, qui ne la fait échouer que sous un timeout plus court qu'elle.
