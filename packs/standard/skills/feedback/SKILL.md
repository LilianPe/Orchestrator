---
name: feedback
description: Appliquer des retours de review (Linear, GitHub, vérifications ou CI) sur la PR du ticket et répondre point par point (lancé par l'usine).
---

# factory:feedback

Tu reprends la session de dev du ticket, dans son worktree et sur sa branche, déjà publiée par l'usine. Le bloc « Retours à traiter », « Vérifications en échec » ou « CI en échec » liste ce qu'il faut traiter. Tu es seul pendant ton tour ; ton seul canal vers un humain est `factory-agent ask "<question>"`, puis fin du tour.

## 1. Rassembler

- **Retours à traiter** : messages du fil Linear et commentaires de review GitHub non résolus, avec leur auteur. Le bloc dit « aucun retour écrit » : relis le fil Linear du ticket et la PR (`gh pr view <branche> --comments`) pour trouver ce qui est demandé.
- **Vérifications en échec** : les commandes de `verify` du projet, leur code de sortie et la fin de leur sortie. C'est un symptôme : `factory:debugging`.
- **CI en échec** : applique `factory:fix-ci` (lire l'échec exact, reproduire en local, classer la cause ; jamais désactiver ni affaiblir un test ou une étape de CI).
- Vérifie où en est la branche : `git status` (rien d'inattendu en cours), `git log --oneline -10`.

## 2. Traiter avec `factory:receiving-review`

Lis tous les retours, puis applique `factory:receiving-review` : comprendre chacun, vérifier sa prémisse et sa correction dans le code, corriger ce qui est juste avec sa preuve (`factory:tdd`), refuser avec une raison ce qui ne l'est pas.

- Un retour humain ambigu ou contraire au ticket : UNE question avec `factory-agent ask`, après avoir traité les retours indépendants.
- Un retour qui demande autre chose que le ticket (nouvelle fonctionnalité) : réponds qu'il mérite son propre ticket, sauf si l'humain le demande explicitement dans ce ticket.
- Un commit par cause, message `<ID>: <ce qui est corrigé>`. Jamais d'`--amend` ni de réécriture : la branche est publiée, et l'usine refuse un historique réécrit.

## 3. Vérifier et rendre la main

1. `factory:verification` : les tests de ce que tu as changé, la vérification de types et le lint du dépôt s'ils existent ; pour des vérifications en échec, rejoue exactement la commande qui a échoué.
2. Conflit avec la base de la PR : `git fetch origin`, puis `git merge-tree --write-tree --name-only origin/<base> HEAD` (base : `gh pr view <branche> --json baseRefName --jq .baseRefName`). Code 1 : fusionne la base (`git merge --no-edit origin/<base>`), résous chaque hunk lu avec Edit en gardant l'intention des deux côtés, `git add`, `git commit --no-edit`, relance tests et types. Contradiction entre les deux côtés, deux migrations sur les mêmes tables, ou résolution hors périmètre : `git merge --abort` et question.
3. Un humain a pu pousser sur la branche : `git fetch origin`, et s'il y a du nouveau sur `origin/<branche>`, `git merge --no-edit origin/<branche>` ; sans cela, l'usine refuse de publier par-dessus.
4. Commite, puis termine ton tour : **l'usine publie**, après avoir vérifié ton dernier commit. Tu ne pousses pas.

## Interdits

Ne merge jamais la PR. Ne pousse jamais, sur aucune branche : l'usine publie. Ne réécris pas l'historique, ne rebase pas une branche publiée. Ne change pas de branche. Ne désactive ni n'affaiblis aucun test ou étape de CI.

## Dernier message (publié dans Linear)

En français, une puce par retour : `- <retour résumé> → <ce qui a été fait> (<sha court>)`, ou `→ non appliqué : <raison>`. Puis une ligne **Vérifié** (commandes et résultat). Termine par les retours non traités et pourquoi, s'il y en a.

Si tu poses une question avec `factory-agent ask`, ce dernier message n'est pas publié : la question doit dire aussi ce qui a déjà été traité.
