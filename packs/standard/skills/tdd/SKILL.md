---
name: tdd
description: Méthode test d'abord (rouge, vert, nettoyage) pour tout changement de comportement : fonctionnalité, correction de bug, refactorisation. À suivre avant d'écrire le code de production.
---

# relais:tdd

**Règle : pas de code de production sans un test qui a échoué d'abord, et pour la bonne raison.** Un test que tu n'as pas vu échouer ne prouve rien : il peut tester autre chose, ou rien du tout.

## Quand

Toujours quand le comportement change : nouvelle fonctionnalité, bug, refactorisation qui touche une logique, retour de review qui décrit un défaut.

Exceptions (à écrire dans ton dernier message, avec la raison) : fichier de configuration pur, texte ou traduction, code généré, documentation. Si le dépôt interdit un type de test (voir `CLAUDE.md`), suis le dépôt et dis-le.

## Le cycle

1. **Rouge — un test, un comportement.** Avant d'écrire le test, nomme le changement de production qui le ferait échouer. Nom de test qui décrit le comportement attendu (« refuse un e-mail vide », pas « test1 »). Un « et » dans le nom : deux tests.
2. **Vérifier le rouge — obligatoire.** Lance ce seul fichier de test (`npx vitest run <fichier>`, `pytest <fichier>::<test>`, etc.). Il doit **échouer**, pas planter : le message d'échec dit que le comportement manque, pas qu'un import est cassé ou qu'il y a une faute de frappe. Il passe déjà ? Tu testes du comportement existant : corrige le test. Il plante ? Corrige l'erreur et relance jusqu'à un vrai échec.
3. **Vert — le code minimal.** Le plus simple qui fait passer le test. Pas d'option « pour plus tard », pas de refactorisation voisine, pas d'amélioration hors du test.
4. **Vérifier le vert — obligatoire.** Relance le test, puis les tests voisins (même fichier, même module, consommateurs du code changé). Sortie propre : pas d'erreur ni d'avertissement nouveau. Un test échoue : corrige le code, pas le test.
5. **Nettoyer.** Seulement au vert : noms, duplication, extraction. Les tests restent verts à chaque pas. Aucun comportement nouveau ici.
6. Comportement suivant : retour en 1.

## Des tests honnêtes

- **Du vrai code, pas des mocks.** Un mock seulement aux frontières lentes ou externes (réseau, horloge, service tiers). Une assertion sur un mock (« a été appelé 3 fois ») teste le mock, pas le code.
- **Le test doit pouvoir échouer.** Un mock enregistré trop tard, une assertion négative (« ne lève pas ») qui passe dès la première écriture, une valeur que le banc de test produirait de toute façon (`undefined`, `0`, `""`) : ce test ne garde rien. Vérifie-le : casse volontairement le code (une ligne, avec Edit), relance, le test doit rougir ; puis remets le code (Edit) et vérifie que `git diff` ne montre plus ta mutation.
- **Placer le test là où la fonction est déjà testée** (`grep -rl "<fonction>" <dossier de tests>`), pas d'après le nom du fichier.
- **Pas de code réservé aux tests dans la production.** Les aides de test vont dans les utilitaires de test.
- Avant de mocker une dépendance, sache ce qu'elle fait d'autre (transformation locale, effet de bord) : le mock l'efface aussi.

## Bug : le test d'abord

Un bug se corrige en deux commits logiques ou un seul, mais toujours dans cet ordre : un test qui reproduit le symptôme (rouge), puis la correction (vert). Pour trouver la cause, suis `relais:debugging` ; le test vient avant la correction.

## Signaux d'arrêt

Recommence avec un test si tu te surprends à : écrire le code avant le test ; garder du code « en référence » en écrivant le test après ; voir un test passer du premier coup sans comprendre pourquoi ; dire « testé à la main », « trop simple pour un test », « je testerai après ». Un test écrit après coup passe tout de suite et ne prouve rien.

Difficile à tester ? C'est souvent le design : interface plus simple, dépendance injectée, plutôt qu'un échafaudage de mocks.

## Fini quand

- chaque comportement nouveau ou corrigé a un test que tu as vu échouer pour la bonne raison ;
- le code minimal le fait passer, et les tests voisins sont verts ;
- tu peux citer la commande lancée et son résultat (voir `relais:verification`).
