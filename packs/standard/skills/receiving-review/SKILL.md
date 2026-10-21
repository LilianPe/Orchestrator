---
name: receiving-review
description: Traiter des retours (review humaine ou IA, commentaires de PR, vérifications ou CI en échec) avec rigueur : comprendre, vérifier dans le code, corriger ce qui est juste, refuser avec une raison ce qui ne l'est pas. Utilisé par factory:feedback, factory:fix-ci et factory:review.
---

# factory:receiving-review

Un retour est une affirmation sur le code, et la correction qu'il propose en est une autre. Les deux se vérifient avant d'écrire une ligne. Ni complaisance (« excellente remarque ! »), ni application aveugle, ni défense de principe.

## 1. Tout lire, puis comprendre

- Lis **tous** les retours avant d'en corriger un : plusieurs retours peuvent décrire un même mécanisme, ou se contredire.
- Reformule chacun en une exigence technique (« la date doit être validée côté serveur »). Retour ancré (`chemin:ligne — texte`) : ouvre ce fichier à cette ligne.
- **Un retour ambigu, ou contraire au ticket ou à un autre retour humain** : ne corrige rien de ce qui en dépend. Pose UNE question précise avec `factory-agent ask "<question>"` (ce que tu as compris, les deux lectures possibles), traite les retours indépendants, puis termine ton tour.

## 2. Vérifier dans le code

Pour chaque retour :

- **La prémisse** : lis la fonction citée en entier (pas un `grep`) ; pour « X peut arriver », trace si un vrai chemin y mène. Un retour fondé sur une lecture fausse est refusé, avec ce que montre le code.
- **La correction proposée**, aussi sévèrement que le défaut : une réécriture suggérée est du code non vérifié. Pièges connus :
  - « ces deux formes sont équivalentes » : à l'exécution peut-être, mais une règle de lint ou de typage peut être la raison de la forme actuelle ;
  - « calcule-le une seule fois » : compare les copies opérande par opérande ; si elles diffèrent, les fusionner change le comportement ;
  - « supprime ce test » : nomme la régression dont il est le seul garde avant d'y toucher ;
  - « fais-le proprement » (export, métriques, options) : vérifie que quelqu'un s'en sert (`grep`) ; sinon c'est hors besoin ;
  - **un compromis** (échouer ouvert ou fermé, réessayer ou abandonner, une limite, un délai, un seuil) : ce n'est pas un défaut mais une décision. N'en applique aucun côté seul ; décris les deux scénarios d'échec et laisse trancher (question ou « reste à voir par un humain »).
- **Les règles du dépôt** pour ce que tu vas toucher (`CLAUDE.md` sur les tests, les commentaires, les migrations). Une correction qui les enfreint n'est pas appliquée : dis laquelle.
- **Un test existant qui fige le comportement inverse** est un contrat que le relecteur n'a pas vu : n'inverse jamais son assertion pour faire passer un retour ; signale le conflit.

Source du retour :

- **Humain** (fil Linear, commentaire de PR d'un relecteur) : c'est la décision produit. Applique après avoir compris ; s'il contredit le ticket ou un choix antérieur, demande au lieu de trancher.
- **IA ou outil** (review automatique, constat de `factory:code-review`) : sceptique. Un retour non vérifié n'est pas appliqué.
- **Vérification ou CI en échec** : ce n'est pas une opinion, c'est un symptôme ; passe par `factory:debugging`.

## 3. Corriger

- Ordre : ce qui casse (bug, faille) d'abord, puis les corrections simples, puis les plus lourdes.
- **Un commit par cause.** Plusieurs retours sur un même mécanisme sont un seul défaut vu sous plusieurs angles : une correction à la cause, un commit qui les nomme tous. Les retours indépendants gardent chacun leur commit.
- **Corrige la règle, pas l'exemple** : un retour qui cite un cas d'une classe de bugs se corrige par ce qui couvre toute la classe.
- **Une duplication se supprime**, elle ne se commente pas (« voir plus haut »).
- **Chaque correction de comportement a sa preuve** (`factory:tdd`) : un test rouge sur l'ancien code puis vert. Pour un durcissement sans changement visible, montre que le test rougit quand tu casses volontairement la garde (avec Edit), puis remets-la.
- Lance les tests de ce que la correction change (`factory:verification`), pas la suite complète.
- Jamais `git commit --amend` ni réécriture d'historique : la branche est déjà poussée et le force-push est interdit. Pour annuler une correction : `git revert --no-edit <sha>`.

## 4. Répondre

Pas de remerciements ni d'accord de façade : l'action montre que le retour est entendu. Pour chaque retour, une ligne :

- corrigé : `<retour résumé> → <ce qui a changé> (<sha court>)` ;
- refusé : `<retour résumé> → non appliqué : <raison technique, avec ce que montre le code ou le test>` ;
- en attente : `<retour résumé> → question posée : <question>` ou `→ à trancher par un humain : <les deux options>`.

Tu t'étais trompé en refusant : dis-le en une phrase (« vérifié : tu avais raison, X fait Y ») et corrige.

## Fini quand

Chaque retour a une ligne de réponse ; chaque correction a son commit et sa preuve ; rien n'a été appliqué sans être vérifié ni refusé sans raison.
