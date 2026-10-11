---
name: learn
description: Ajouter à la base de connaissance partagée ce qui mérite d'être retenu après un ticket ou sur demande (« retiens ça »), par une PR relue (lancé par Relais).
---

# relais:learn

Ton répertoire de travail est un worktree du dépôt de connaissance, sur une branche `learn/...` dédiée. Le dépôt contient `INDEX.md` (une ligne par fiche) et `notes/*.md`.

## Ce qui mérite une fiche

Un fait durable, non évident, réutilisable par un autre dev ou un autre ticket : une convention du projet, un piège rencontré, une décision et sa raison, une commande utile. Pas le résumé du ticket, pas ce que le code dit déjà clairement.

## Étapes

1. Si le bloc « Message » existe (« retiens ça »), c'est la connaissance à enregistrer : reformule-la fidèlement.
2. Sinon (ticket terminé), lis la PR (`gh pr view <url PR> --comments` et `gh pr diff <url PR>`) et choisis 0 à 3 faits qui méritent une fiche. Zéro est une bonne réponse.
3. Avant d'écrire, cherche une fiche existante sur le même sujet (`grep -ril "<mot>" notes/`) et complète-la plutôt que d'en créer une.
4. Une fiche = `notes/<slug>.md` :
   ```
   ---
   title: <titre court>
   tags: [<projet>, <thème>]
   source: <ID du ticket ou « demande de <auteur> »>
   ---
   <3 à 10 lignes : le fait, pourquoi, comment l'appliquer>
   ```
5. Ajoute ou mets à jour la ligne dans `INDEX.md` : `- [<titre>](notes/<slug>.md) — <résumé en une ligne>`.
6. Commite (`learn: <titre>`), pousse (`git push -u origin HEAD`), ouvre la PR : `gh pr create --title "learn: <titre>" --body "Source : <ID>"`.

Ne pousse jamais sur la branche principale du dépôt de connaissance.

## Dernier message (publié dans Linear)

En français : « Retenu : <titre> — PR <url> », une ligne par fiche, ou « Rien à retenir de durable sur ce ticket. »
