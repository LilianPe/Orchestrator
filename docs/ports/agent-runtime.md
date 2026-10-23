# Port AgentRuntime

Lancer un agent sur un prompt, suivre son flux, l'arrêter, et lire son issue. C'est le port `Runner` actuel, pas renommé tant qu'il ne change pas de forme.

- Interface : `Runner`, `RunRequest`, `RunHandle`, `RunResult` (`src/adapters/runner/types.ts`).
- Implémentations : `ClaudeCodeRunner` (`src/adapters/runner/claude-code.ts`, `claude -p` en sous-processus), `FakeRunner` (`src/adapters/runner/fake.ts`).
- Suite : `test/contracts/agent-runtime.contract.ts`, lancée par `src/adapters/runner/fake.test.ts` et `src/adapters/runner/claude-code.test.ts` (sur le faux `claude` de `src/adapters/runner/fixtures/`, sans réseau).

## Méthodes

| Méthode | Ce qu'elle garantit | Rejouée | Erreur |
|---|---|---|---|
| `start(req)` | un run, et son `RunHandle` | un second `start` lance un second run | ne lève pas : un échec de lancement finit en `failure` |
| `handle.events` | les événements du flux, dans l'ordre ; le flux se ferme quand le run finit | — | — |
| `handle.done` | l'issue : `success`, `failure`, `stopped` ou `limit`, le coût (≥ 0), les tours (≥ 1 sur un succès), le dernier texte de l'agent | — | ne rejette pas |
| `handle.stop()` | le run finit en `stopped` | sans effet ; après la fin, l'issue ne change pas | — |

Un run qui dépasse `limits.durationMs` ou `limits.turns` finit en `limit`. Deux runs sont indépendants : arrêter l'un laisse l'autre tourner.

## Idempotence

`start` n'est pas idempotent : la ligne « Appel au modèle » d'ORC-162 met l'idempotence dans le moteur (id de tentative), pas dans le port.

## Fencing

Un `RunHandle` appartient à un seul `start`, donc à un seul `runId` : la suite vérifie que les runs ne se mélangent pas. Ignorer le résultat d'une tentative qui n'est plus active, c'est le moteur (ORC-133, ORC-162).

## Ce que la suite demande à l'implémentation

`AgentRuntimeSubject` : le runtime, en option `elapse(ms)`, qui avance son horloge (absent, la suite attend en temps réel), et `script(nom)`, qui prépare le prochain run à se comporter comme `success`, `failure`, `hang` (tourne jusqu'à l'arrêt ou au plafond) ou `chatty` (enchaîne au moins trois tours), et rend ce que sa requête doit porter pour ça (le faux `claude` lit son script dans l'environnement).

## Hypothèse sur le point ouvert (ORC-155)

ORC-155 décidera si ce port devient une abstraction du harness (Claude Code ou un autre). La suite ne tranche pas : elle traite le runtime en boîte noire, et ne regarde ni les champs propres à Claude de `RunRequest` (`claudeSessionId`, `pluginDir`, `settingsPath`) ni les arguments de la CLI (testés à part, `buildClaudeArgs`). Un second runtime la passe tant que `start`, `RunHandle` et les quatre issues gardent leur forme ; si ORC-155 change cette forme, la suite change avec le port.

## Écarts connus

Aucun. `FakeRunner` ignorait `limits` : depuis ORC-189, il les tient comme le vrai runtime.

- Tours : un script dont `turns` dépasse `limits.turns` finit en `limit` tout de suite, sans attendre `release`, avec `turns` ramené au plafond.
- Durée : sur l'horloge simulée passée au constructeur (`new FakeRunner(clock)`), vérifiée à chaque `tick()`. Un run tenu (`hold`) finit en `limit` quand l'horloge atteint `limits.durationMs` depuis son départ. Le harnais des scénarios lui passe son horloge et appelle `tick()` dans `advance(ms)` : un scénario qui avance l'horloge au-delà du plafond d'un run tenu le voit finir en `limit`.
