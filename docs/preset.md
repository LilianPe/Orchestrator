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
| Rouge non vérifié → `tests` | `red` | 2 contrôles en mode bloquant (le 2e rouge non vérifié bloque) | Bloqué ; l'agent peut aussi rendre `spec_impossible` |
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
| `counters.red` (2) | `jobs.<job>.red.attempts` = 2 | en mode bloquant, un rouge non vérifié renvoie à `tests` ; le 2e bloque |

`verify_attempts` et `ci_fix_attempts` de `workflow.yml` surchargent encore les deux premières, jusqu'au retrait du YAML (ORC-177).

## Étape `tests` et contrôle `red` (ORC-123)

L'étape `tests` (agent, skill `factory:tests`, Sonnet, effort medium, réseau du dépôt) écrit **seulement** les tests qui traduisent les critères d'acceptation, et les commite. L'usine ne la croit pas sur parole : le contrôle `red` (`src/checks/red.ts`) constate lui-même.

1. Il lit les fichiers changés par les commits de l'étape depuis le tronc (`baseSha` : leur merge-base avec `origin/<tronc>`), sur le dépôt de l'usine. Un fichier qui n'est pas un test (règle unique de `src/checks/test-files.ts`) fait échouer l'étape, sans rien lancer.
2. Il lance les seuls tests ajoutés ou modifiés avec la commande du job (`red.command`, `npm test --` dans le pack), là où `verify` lance ses commandes.
3. Il classe la sortie (vitest, jest, pytest) :

| Sortie | Cause | Rouge |
| -- | -- | -- |
| échec sur une assertion (`AssertionError`, `expect(received)`, `E assert`) | `assertion` | vérifié |
| « Cannot find module » (TypeScript) ou `ModuleNotFoundError` (Python) vers un chemin absent à `baseSha` (`git cat-file -e`) | `missing_module` | vérifié |
| même erreur vers un chemin présent à `baseSha`, ou vers un paquet | `module_at_base` | refusé |
| erreur de syntaxe, de compilation, de chargement ou de collecte | `compile` | refusé |
| échec sans assertion (erreur à l'exécution), délai dépassé | `error` | refusé |
| aucun test lancé, ou aucun test commité | `no_tests` | refusé |
| tests déjà verts | `passing` | refusé |
| fichier hors tests modifié | `scope` | refusé |

Le verdict revient comme le résultat de `verify` : `verify.passed` ou `verify.failed`, avec le champ `red` qui porte la cause. Un rouge vérifié démarre le job suivant (`on_success.run`, `dev` dans le pack).

**Mode mesure.** Sur les 20 premiers tickets, le contrôle est en mode mesure : un rouge non vérifié ne bloque pas, la décision porte la trace « red: aurait bloqué (<cause>), mode mesure : le run continue », et le build démarre. Seul `scope` fait échouer l'étape dans les deux modes. Les verdicts sont dans les mesures du ticket (`red` de `TicketMeasures`, ORC-235) : un rouge non `verified` est ce que le contrôle aurait bloqué.

**Mode bloquant.** Un rouge non vérifié renvoie à `tests` (session reprise, verdict en entrée), borné par le compteur `red`, puis Bloqué.

Le drapeau vit dans le job, figé avec la version du workflow de chaque ticket : `jobs.tests.red.mode: measure | blocking` (`measure` par défaut). Le passer en `blocking` dans `.factory/workflow.yml`, après validation sur les tickets dorés (ORC-236).

Le job `tests` du pack est inactif tant qu'aucune règle ne le lance : un dépôt l'active en faisant démarrer la délégation par lui (`ticket.delegated: - { when: "state in [todo, dev] && !blocked", run: tests }`). Les jobs sans `red` gardent le flux `dev` d'avant.

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
