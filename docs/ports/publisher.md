# Port Publisher

L'usine pousse le sha vérifié et ouvre la PR de la branche, ou la retrouve (ORC-125). L'agent ne pousse plus.

- Interface : `Publisher` (`src/adapters/publisher/types.ts`), port nouveau (ORC-225).
- Implémentations : `GitPublisher` (`src/publish/publish.ts`), `FakePublisher` (`src/adapters/publisher/fake.ts`).
- Suite : `test/contracts/publisher.contract.ts`, lancée par `src/adapters/publisher/fake.test.ts`. `GitPublisher` a ses tests sur un vrai git et un dépôt nu (`src/publish/publish.test.ts`), et sous un vrai moteur (`test/isolation/isolation-08-diff.test.ts`) : il lui faut une `ForgeWriter`, un sandbox et un dépôt, que la suite ne pose pas.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `publish(req)` | la branche porte `req.sha` et a une PR ouverte, draft à sa création ; rend son numéro, son URL `https://` et le sha poussé | même PR, même résultat, aucun push ; un autre sha met la branche à jour sans ouvrir de seconde PR | `PublishRefused` (`moved`, `rejected`, `diff`, `head`, `trunk`, `empty`) : une réponse, rien n'est écrit sur la forge, à ne pas rejouer ; toute autre rejet : à rejouer, le push a pu avoir lieu |

Une branche a sa PR à elle. Quand la PR de la branche est mergée ou fermée, publier en ouvre une nouvelle, comme GitHub.

## Idempotence

La clé est la branche (lignes « Push » et « PR » d'ORC-162) : la tête de la branche est lue avant de pousser, la PR existante cherchée avant d'en créer une.

## Fencing

Le push se fait en `--force-with-lease` sur la tête lue, et seulement si elle est dans le travail : jamais par-dessus un commit que le travail n'a pas. C'est `GitPublisher` qui le prouve (sur `--force-with-lease` refusé après un déplacement entre la lecture et le push) : le faux ne connaît pas l'ascendance, il refuse sur commande (`refuseNext`).

## Ce que la suite demande à l'implémentation

`PublisherSubject` : une requête sur une branche sans PR, et en option `end(branche, n)`, qui merge ou ferme cette PR sur la forge (le faux le fait par `FakeForge.setPr`).

## Écarts connus

`GitPublisher` ne lance pas la suite (voir plus haut).
