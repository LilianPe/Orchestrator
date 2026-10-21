---
name: dev
description: Développer un ticket Linear de bout en bout dans le worktree courant et ouvrir sa PR (lancé par l'usine).
---

# factory:dev

Tu reçois un ticket Linear (bloc « Ticket ») et tu travailles dans un worktree git déjà créé sur la branche indiquée (« Branche »), partie du tronc. Tu es seul : personne ne répond pendant ton tour. Ton seul canal vers un humain est `factory-agent ask "<question>"`, après quoi tu termines ton tour.

Le prompt porte le **quoi** (le ticket) ; ce skill porte le **comment**. Le `CLAUDE.md` du dépôt l'emporte sur ce skill partout où les deux parlent du même sujet (conventions de commit, de test, de nommage) : lis-le avant d'écrire une ligne.

## 1. Comprendre

1. Lis le ticket en entier, puis les fichiers qu'il cite. Ticket lié mentionné : `factory-agent issue <ID>`. Lis `CLAUDE.md` et `docs/agent/` du dépôt s'ils existent, et la base de connaissance (`factory-agent kb search "<mots>"`) sur le sujet.
2. Vérifie sur le code que le ticket tient encore : ce qu'il dit de modifier ou de réutiliser existe (`grep -rn "<symbole>"`), et ce qu'il doit livrer n'est pas déjà là. Une contradiction entre le ticket et le code est une question, pas un choix à faire seul.
3. **Une décision produit manque** (comportement attendu ambigu, deux lectures possibles, critère contradictoire) : pose UNE question précise avec `factory-agent ask "<question>"` avant de coder, en donnant les options que tu vois, puis termine ton tour. Une question technique que le code ou le dépôt tranche n'en est pas une : tranche-la et dis-le dans ton dernier message.
4. Reste dans le périmètre du ticket. Un défaut voisin sans lien : note-le pour tes points d'attention, ne le corrige pas.

## 2. Mini-plan, si utile

Si le ticket demande plusieurs changements (plusieurs modules, une migration plus du code, une API plus son appelant), écris d'abord une liste courte d'étapes avec la liste de tâches de ta session : pour chacune, les fichiers touchés et le test qui la prouvera. Chaque étape se termine par des tests verts. Pas de fichier de plan dans le dépôt. Un ticket simple n'en a pas besoin.

## 3. Développer

- Chaque comportement : `factory:tdd` (un test qui échoue, puis le code minimal).
- Un bug, un test rouge inattendu, un comportement que tu ne comprends pas : `factory:debugging` avant toute correction.
- Respecte les conventions du dépôt et le motif établi dans le code voisin. Presque aucun commentaire : une ligne pour un « pourquoi » que le code ne dit pas, jamais une paraphrase.
- Commite par étape cohérente : `<ID>: <ce que fait le commit>` (ou la convention du `CLAUDE.md`). Aucune mention d'outil, d'IA ou de session dans les commits ni dans la PR, pas de ligne `Co-Authored-By`.

## 4. Vérifier et relire

1. `factory:verification` : tests de ce que tu as touché et de ses consommateurs, puis la vérification de types et le lint du dépôt s'ils existent. Pas la suite complète : l'usine relance les vérifications du projet après ton run, puis la CI tourne.
2. **Auto-review légère** avec `factory:code-review` sur ton propre diff, au niveau **rapide** ou **standard** selon le risque (jamais « approfondi » : la review IA du ticket s'en charge plus tard). Corrige les constats bloquants et importants selon `factory:receiving-review`, relance les tests concernés. Une seule passe : pas de deuxième review.
3. Relis les critères du ticket un par un : chacun est-il couvert, et par quel test ou quelle vérification ?

## 5. Intégrer au tronc, pousser, ouvrir la PR

1. Contrôle de conflit avec le tronc, juste avant de pousser :
   ```bash
   git fetch origin
   git rev-parse --abbrev-ref origin/HEAD
   git merge-tree --write-tree --name-only origin/<tronc> HEAD
   ```
   Code 0 : rien à faire. Code 1 : la sortie liste les fichiers en conflit.
2. **Conflit, branche jamais poussée** : `git rebase origin/<tronc>`. Pour chaque fichier en conflit, lis les hunks (Read) et résous-les avec Edit en gardant l'intention des deux côtés, jamais en réécrivant le fichier par un script ; puis `git add <fichier>`, `git commit --no-edit`, `git rebase --continue`. Relance ensuite les tests touchés et la vérification de types. **Arrête-toi** (`git rebase --abort`, puis `factory-agent ask`) dans trois cas seulement : les deux côtés se contredisent, deux migrations changent les mêmes tables, ou la résolution sort du périmètre du ticket.
   Branche déjà poussée (session reprise) : pas de rebase, le force-push est interdit ; fusionne le tronc à la place (`git merge --no-edit origin/<tronc>`, mêmes règles de résolution, puis `git commit --no-edit`).
3. Pousse vers une destination nommée, jamais un `git push` nu (il peut viser le tronc selon la configuration) :
   ```bash
   git push origin HEAD:refs/heads/<branche>
   ```
   Puis vérifie que le distant porte ton commit : `git ls-remote origin refs/heads/<branche>` doit afficher le même sha que `git rev-parse HEAD`. Push refusé (le distant a bougé) : `git fetch origin`, lis ce qui est arrivé, intègre-le ; jamais de force.
4. PR : si `gh pr view <branche> --json url` échoue, crée-la :
   ```bash
   gh pr create --head <branche> --title "<ID> <titre du ticket>" --body "<résumé>

   Fixes <ID>"
   ```
   **Le mot-clé ferme le ticket au merge : il doit dire vrai.** `Fixes <ID>` seulement si la PR règle tout ce que décrit le ticket ; sinon `Part of <ID>`, et dis ce qui reste dans tes points d'attention. Sinon, si la PR existe, mets son titre et son corps à jour si le changement a dérivé (`gh pr edit`).
5. N'attends pas la CI : l'usine la surveille et lance `factory:fix-ci` si elle échoue.

## Interdits

Ne merge jamais. Ne force-push jamais, ne réécris pas un historique poussé. Ne pousse jamais sur le tronc. Ne change pas de branche. Ne touche à rien hors du worktree, et ne modifie pas la configuration git.

## Dernier message (publié dans Linear)

En français, autonome, au format :

```
**Ce qui a changé** — 2 à 4 puces.
**Comment tester** — étapes concrètes ou commande.
**Vérifié** — commandes lancées et résultat (tests ciblés, types, lint), auto-review (niveau, constats corrigés).
**Points d'attention** — risques, choix faits, ce qui n'est pas couvert, défauts voisins hors périmètre.
PR : <url>
```

Si tu poses une question avec `factory-agent ask`, ce dernier message n'est pas publié : la question doit se suffire (contexte, options, ce que tu as déjà fait).
