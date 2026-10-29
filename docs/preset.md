# Le préréglage `factory/default`

Le préréglage décrit, en TypeScript, l'enchaînement des étapes d'un run et la borne de chaque boucle. Il remplacera les 6 états et les règles `on` de [`workflow.yml`](workflow.md) (ORC-187). Les règles `on` de `workflow.yml` pilotent encore les runs, mais le moteur prend déjà ses bornes dans le préréglage, compilé à chaque chargement du workflow (voir « Ce que le moteur lit déjà »).

Code : `src/presets/preset.ts` (types et compilateur), `src/presets/factory-default.ts` (la définition).

## Enchaînement

```
intake → clarify (si le ticket est flou) → spec_draft → spec_check → spec_review (porte humaine)
  → tests → red → freeze_tests → build → verify → publish → review IA → human_review (porte de merge)
  → merge (après passage en Done par un humain) → after_merge
```

Après publication, une seule étape `fix` sert toutes les boucles : `fix → verify_fix → publish → review IA → human_review`. Son skill dépend de la cause : `factory:fix-ci` pour une CI rouge, `factory:feedback` pour une review IA ou des retours humains.

Chaque étape a un type : `spec_check`, `agent_step`, `verify` (modes `red`, `freeze`, `full`), `review`, `fix`, `human_gate` (porte `spec` ou `merge`), `publish` (modes `push`, `merge`). Une étape a une suite en cas de succès (`next`) et, si elle peut échouer, un retour arrière (`onFailure`) qui consomme un compteur. Toute étape `agent_step` déclare ce qu'elle écrit (`writes` : `nothing`, `spec`, `tests` ou `code`) : un oubli fait échouer la compilation.

## Bornes

| Boucle | Compteur | Limite | Au-delà |
| -- | -- | -- | -- |
| `spec_check` échoue → `spec_draft` | `spec_check` | 1 | Bloqué |
| `spec_review` « Modifier » → `spec_draft` | `spec_review` | 3 | Bloqué |
| Rouge non vérifié → `tests` | `red` | 2 | Bloqué (ou `spec_impossible`, ORC-123) |
| `verify` échoue → `build` (ou `verify_fix` → `fix`) | `verify` | 3 | Bloqué |
| Review IA ou CI rouge → `fix` | `review_ci` | 2, un seul compteur par run | Bloqué |
| Retours humains → `fix` | `human_review` | 3, distincts des tours IA | Bloqué |
| Même commande, même échec, diff inchangé | `sameFailure` | 3 | Bloqué, cause « boucle » |

Une CI rouge est l'échec d'un push : tant que la PR est ouverte, y compris pendant la porte de merge, elle part vers `fix` sur le compteur `review_ci` (`redCi`, seule source de cette règle). Aucune réaction ne relance `fix` hors de ce compteur. Une PR mergée n'a plus de retour arrière.

`verify` et `verify_fix` partagent le compteur `verify`, remis à zéro quand une vérification passe : les 3 retours comptent des échecs consécutifs. Le total reste borné, car le nombre de passages par `verify` l'est par les autres compteurs.

## Modèles, effort, tours, réseau

| Étape | Modèle | Effort | Tours max | Réseau |
| -- | -- | -- | -- | -- |
| `intake`, `clarify` | Sonnet | low | 150 | Limité |
| `spec_draft` | Sonnet | high | 150 | Limité |
| `tests`, `after_merge` | Sonnet | medium | 150 | Limité |
| `build` | Sonnet | medium | 150 | Limité |
| `fix` | Sonnet | medium | 60 | Limité |
| `review` | Opus | high | 25 | API Claude |
| `spec_check`, `verify*`, `red`, `freeze_tests` | (contrôle usine) | | | Aucun |

Les tours des étapes que le doc MVP ne chiffre pas reprennent l'ancien `per_run.turns: 150`. Les plafonds en tokens restent à fixer (ORC-216).

Le niveau de réseau se choisit par dépôt (Limité par défaut) ; une étape peut seulement le resserrer. Une étape déclarée au-dessus du niveau du dépôt fait échouer la compilation.

## Ce que le moteur lit déjà

`loadWorkflow` compile le préréglage puis reporte ses bornes dans `limits`, qui est figé avec la version du workflow de chaque ticket (ORC-149). Un ticket garde donc les bornes avec lesquelles il a démarré.

| Borne du préréglage | Dans le workflow chargé | Effet |
| -- | -- | -- |
| `counters.verify` (3) | `limits.verifyAttempts` = 4 | 3 retours au run après un contrôle en échec ; le 4e échec bloque |
| `counters.review_ci` (2) | `limits.ciFixAttempts` = 2 | 2 relances `fix-ci` sur CI rouge ; la suivante bloque. Les tours de review IA rejoindront ce compteur avec ORC-184 |
| `sameFailure` (3) | `limits.repeatedFailures` = 3 | même échec sur un worktree inchangé, 3 fois de suite : Bloqué, cause « Boucle » |

`verify_attempts` et `ci_fix_attempts` de `workflow.yml` surchargent encore les deux premières, jusqu'au retrait du YAML (ORC-177).

## Compilation et version

`compilePreset(preset, { repoNetwork })` vérifie les invariants du socle et renvoie le hash du préréglage, ou lève une `PresetError` qui liste toutes les violations :

- **cycles bornés** : les liens `next` seuls ne forment aucun cycle, et chaque retour arrière nomme un compteur déclaré, de limite entière positive ;
- **gel des tests avant le build** : aucune étape qui écrit du code (`fix`, ou `agent_step` avec `writes: code`) n'est atteignable sans passer par un `verify` en mode `freeze` ;
- **porte de merge** : depuis du code écrit, un `publish` en mode `merge` n'est atteignable qu'à travers une porte humaine `merge` ;
- **relecteur en lecture seule** : toute étape `review` est en lecture seule, réseau API Claude au plus ;
- **contrôles hors réseau** : toute étape `verify` tourne sans réseau ;
- **réseau** : aucune étape en Complet (réservé à `setup`), aucune au-dessus du niveau du dépôt ;
- **plafond de budget** : toute étape agent a un nombre de tours maximum.

Le hash est le sha256 du JSON canonique du préréglage (clés triées) : il ne dépend pas de l'ordre des clés et change dès qu'une borne, un modèle ou une étape change. Chaque run sera figé sur le hash avec lequel il a démarré (table `workflow_versions`, ORC-149).
