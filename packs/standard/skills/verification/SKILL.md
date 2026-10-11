---
name: verification
description: Vérifier avant d'affirmer : lancer la commande qui prouve un résultat et lire sa sortie avant de dire que c'est fait, que ça passe ou que c'est corrigé, et avant chaque commit, push ou PR.
---

# relais:verification

**Règle : aucune affirmation de réussite sans une preuve fraîche.** Ton dernier message est publié dans Linear et un humain s'y fie. « Ça devrait passer » n'est pas un résultat.

## La porte, avant toute affirmation

1. **Quelle commande prouve ce que je vais dire ?**
2. **La lancer maintenant**, en entier, sur l'état actuel du code (pas un résultat d'avant ta dernière modification).
3. **Lire** la sortie et le code de sortie : nombre de tests, échecs, avertissements.
4. La sortie confirme : affirme-le, avec la preuve (« 14 tests passent, `npx vitest run src/foo.test.ts` »). Elle ne confirme pas : dis l'état réel.

| Affirmation | Preuve exigée | Ne suffit pas |
|---|---|---|
| Les tests passent | sortie du lanceur : 0 échec | un ancien run, « devrait passer » |
| Le bug est corrigé | le symptôme d'origine rejoué : il a disparu | « le code a changé » |
| Le test de non-régression marche | rouge sans la correction, vert avec | « j'ai écrit un test » |
| Les types sont bons | la vérification de types du dépôt : code 0 | le lint, les tests (souvent sans contrôle de types) |
| C'est poussé | `git ls-remote origin refs/heads/<branche>` égal à `git rev-parse HEAD` | la fin d'une sortie de `git push` |
| La CI est verte | `gh pr checks <branche>` lu, aucun check en cours ni rouge | « la CI va tourner » |
| Le ticket est traité | chaque critère du ticket relu et coché | « les tests passent » |

## Quoi lancer, et quoi ne pas lancer

D'autres sessions tournent en même temps sur la même machine, et Relais relance ensuite les vérifications du projet (`verify` du workflow) puis la CI.

- **Les tests de ce que tu as touché** : le fichier de test de chaque module modifié et ceux de ses consommateurs directs. Avec vitest, `npx vitest related <fichiers modifiés> --run` les trouve.
- **Une liste vide ne lance pas « rien »** : `vitest run` sans fichier lance toute la suite, `vitest related` sans fichier ne lance rien et sort en succès. Quand ta liste de fichiers vient d'une commande (`git diff --name-only`…), vérifie qu'elle n'est pas vide avant de lancer. « No test files found » : aucun test ne couvre ces fichiers ; dis-le, ce n'est pas un vert.
- **La vérification de types et le lint du dépôt**, une fois avant de pousser, s'ils existent et sont légers (scripts `typecheck`, `lint` de `package.json`, ou l'équivalent). Un changement de type exporté casse des fichiers que tes tests ne lancent pas : seule la vérification de types complète le voit.
- **Pas la suite complète ni le build**, même si le `CLAUDE.md` du dépôt le conseille : c'est le rôle de `verify` et de la CI. Exception : le dépôt n'a ni l'un ni l'autre ; dis-le alors dans ton message.
- **Juge un run sur son code de sortie**, jamais sur un `grep` de son résumé ni sur la fin d'une sortie tronquée par `| tail`.

## Pièges

- Dire « parfait », « c'est bon », « terminé » avant d'avoir lancé la commande.
- Conclure d'un vérificateur à un autre : le lint ne compile pas, les tests ne vérifient pas toujours les types.
- Croire un rapport (d'un sous-agent, d'un message de commit, d'un retour) sans regarder le diff ou relancer.
- Un échec dans un fichier que tu n'as pas touché n'est pas forcément « pas toi » : une dépendance changée casse un test intact. Pour savoir s'il préexiste, regarde s'il échoue aussi sur le tronc (la CI du tronc, ou `git log` du fichier) ; sinon traite-le comme le tien (`relais:debugging`).

## Fini quand

Chaque phrase de ton dernier message qui dit « marche », « passe », « corrigé », « poussé » ou « vert » s'appuie sur une commande lancée après ta dernière modification, et tu la cites. Ce que tu n'as pas pu vérifier est écrit comme tel.
