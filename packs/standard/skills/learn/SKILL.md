---
name: learn
description: Ajouter à la base de connaissance partagée ce qui mérite d'être retenu après un ticket ou sur demande (« retiens ça »), par une PR relue (lancé par Relais).
---

# relais:learn

Ton répertoire de travail est un worktree du dépôt de connaissance, sur une branche `learn/...` dédiée. Le dépôt contient `INDEX.md` (une ligne par fiche) et `notes/*.md`. Personne ne répond pendant ton tour.

## Ce qui mérite une fiche

Un fait durable, non évident, réutilisable par un autre dev ou un autre ticket : une convention du projet, un piège rencontré et sa parade, une décision et sa raison, une commande utile. Pas le résumé du ticket, pas ce que le code ou la doc du dépôt disent déjà clairement, pas un détail qui ne servira qu'une fois.

Test rapide : un dev qui ouvre un ticket voisin dans trois mois perdrait-il du temps sans cette fiche ? Non : pas de fiche.

## Étapes

1. Si le bloc « Message » existe (« retiens ça »), c'est la connaissance à enregistrer : reformule-la fidèlement, sans rien ajouter que la personne n'a pas dit.
2. Sinon (ticket terminé), lis la PR : `gh pr view <url PR> --comments` et `gh pr diff <url PR>`. Les retours de review et les corrections de CI sont souvent là où se trouvent les pièges. Choisis 0 à 3 faits. Zéro est une bonne réponse.
3. **Vérifie chaque fait** dans la PR ou le code avant de l'écrire : une fiche fausse est pire qu'aucune fiche, car tous les runs suivants la lisent.
4. Avant d'écrire, cherche une fiche existante sur le même sujet (`grep -ril "<mot>" notes/`) et complète-la plutôt que d'en créer une. Une fiche existante que la PR contredit : corrige-la et dis-le.
5. Une fiche = `notes/<slug>.md` :
   ```
   ---
   title: <titre court>
   tags: [<projet>, <thème>]
   source: <ID du ticket ou « demande de <auteur> »>
   ---
   <3 à 10 lignes : le fait, pourquoi, comment l'appliquer>
   ```
6. Ajoute ou mets à jour la ligne dans `INDEX.md` : `- [<titre>](notes/<slug>.md) — <résumé en une ligne>`. L'index est injecté dans chaque run : la ligne doit dire quand la fiche sert.
7. Commite (`learn: <titre>`), pousse vers la branche courante, nommée (`git branch --show-current`) : `git push origin HEAD:refs/heads/<branche>`, vérifie avec `git ls-remote origin refs/heads/<branche>`, puis ouvre la PR : `gh pr create --head <branche> --title "learn: <titre>" --body "Source : <ID>"`.

Ne pousse jamais sur la branche principale du dépôt de connaissance, et ne merge jamais.

## Dernier message (publié dans Linear)

En français : « Retenu : <titre> — PR <url> », une ligne par fiche, ou « Rien à retenir de durable sur ce ticket. »
