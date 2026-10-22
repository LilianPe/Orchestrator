---
name: debugging
description: Méthode de diagnostic pour un bug, un test rouge, une CI en échec ou un comportement inattendu : trouver la cause avant toute correction.
---

# factory:debugging

**Règle : pas de correction sans cause établie.** Corriger un symptôme déplace le bug et coûte un aller-retour de plus. Une méthode posée est plus rapide qu'une suite d'essais au hasard, surtout quand la correction « évidente » tente.

## Quand

Un test rouge, une CI en échec, un bug décrit dans le ticket ou un retour, un build cassé, un comportement inattendu pendant ton propre développement.

## 1. Comprendre ce qui casse

- **Lis l'erreur en entier** : le premier message, pas seulement la dernière ligne ; la pile d'appels ; les fichiers, lignes et codes cités.
- **Reproduis-la** avec une commande exacte, dans ton répertoire de travail. Pas reproductible : récolte plus d'indices (relance, logs, entrées exactes) au lieu de deviner.
- **Regarde ce qui a changé** : `git log --oneline -15`, `git diff <base>...HEAD`, dépendances, configuration, variables d'environnement.
- **Système en couches** (CI → script → outil, route → service → base) : trouve à quelle frontière la donnée devient fausse. Ajoute un affichage temporaire à l'entrée et à la sortie de chaque couche, lance une fois, lis, puis retire ces affichages.
- **Remonte la donnée** : d'où vient la mauvaise valeur ? Qui a appelé avec elle ? Remonte jusqu'à la source ; corrige là, pas au point où elle explose.

## 2. Comparer à ce qui marche

Trouve un code voisin qui fonctionne (même motif ailleurs dans le dépôt, version précédente : `git show <sha>:<fichier>`). Liste **toutes** les différences, même celles qui « ne peuvent pas compter ». Si tu appliques un motif documenté, lis la référence en entier.

## 3. Une hypothèse à la fois

Écris-la : « la cause est X parce que Y ». Teste-la par le plus petit changement possible, une variable à la fois. Confirmée : étape 4. Infirmée : nouvelle hypothèse, sans empiler les essais précédents (annule-les).

Tu ne comprends pas un point : dis-le dans ton message plutôt que de faire semblant.

## 4. Corriger

1. Un test qui reproduit le bug et échoue (`factory:tdd`). Sans framework de test : un script de reproduction lancé avant et après.
2. **Une** correction, à la cause. Pas de « tant que j'y suis », pas de refactorisation groupée.
3. Vérifie : le test passe, les tests voisins aussi, le symptôme d'origine a disparu (`factory:verification`).

## Trois corrections ratées : stop

Si trois corrections successives échouent, ou si chaque correction révèle un problème ailleurs, ce n'est plus une hypothèse fausse : c'est la conception. N'essaie pas une quatrième. Annule les essais, décris dans ton message ce que tu as établi, ce qui a été tenté et pourquoi ça n'a pas suffi, et pose la question de conception avec `factory-agent ask "<question>"`, puis termine ton tour.

## Pas de cause dans le code

Si l'enquête montre une cause extérieure (réseau, service tiers, runner de CI, secret manquant, test instable sans lien avec le diff) : c'est un résultat, pas un échec. Écris ce que tu as vérifié et ce qui l'établit. Ne « corrige » pas le code à l'aveugle : pas de délai rallongé sans mesure, pas de test désactivé, pas de nouvelle tentative ajoutée pour masquer. La plupart des « pas de cause » sont une enquête incomplète : vérifie d'abord que l'échec ne se reproduit pas.

## Signaux d'arrêt

« Correction rapide, on verra après », « essayons de changer X », plusieurs changements avant de relancer, « c'est sûrement X » sans preuve, une correction proposée avant d'avoir suivi la donnée, « encore un essai » après deux échecs : retour à l'étape 1.

## Fini quand

La cause est nommée (fichier, ligne, mécanisme), un test la montre rouge puis vert, et la commande d'origine passe.
