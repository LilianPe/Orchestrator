# Port Publisher

L'usine pousse le sha vérifié et ouvre ou met à jour la PR de la branche. Aujourd'hui l'agent pousse lui-même : le port n'a qu'un faux, monté par le harnais.

- Interface : `Publisher` (`src/adapters/publisher/types.ts`), port nouveau (ORC-225).
- Implémentations : `FakePublisher` (`src/adapters/publisher/fake.ts`). Pas encore de vraie.
- Suite : `test/contracts/publisher.contract.ts`, lancée par `src/adapters/publisher/fake.test.ts`.

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `publish(req)` | la branche porte `req.sha` et a une PR ouverte ; rend son numéro, son URL `https://` et le sha poussé | même PR, même résultat ; un autre sha met la PR à jour au lieu d'en ouvrir une seconde | non spécifié aujourd'hui (le faux ne rejette jamais) ; cible plus bas |

Une branche a sa PR à elle. Quand la PR de la branche est mergée ou fermée, publier en ouvre une nouvelle, comme GitHub.

## Idempotence

La clé est la branche (ligne « PR » d'ORC-162) : la PR existante est cherchée avant d'en créer une. C'est ce que la suite vérifie.

## Fencing

Cible, pas encore dans le port : le push se fait en `--force-with-lease` sur le sha attendu et est refusé si la branche a bougé (ligne « Push » d'ORC-162). `PublishRequest` n'a pas encore de champ « sha attendu » : le cas entrera dans la suite avec lui, sans renommer le port.

## Ce que la suite demande à l'implémentation

`PublisherSubject` : une requête sur une branche sans PR, et en option `end(branche, n)`, qui merge ou ferme cette PR sur la forge (le faux le fait par `FakeForge.setPr`).

## Écarts connus

Aucun.
