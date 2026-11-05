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
| Rouge non vérifié → `tests` (mode bloquant) | `red` | 2 | Bloqué ; l'agent peut aussi rendre `spec_impossible` |
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
| `counters.red` (2) | `jobs.<job>.red.attempts` = 3 | en mode bloquant, 2 retours à `tests` après un rouge non vérifié ; le 3e bloque. Une relance humaine remet le compte à zéro |

`verify_attempts` et `ci_fix_attempts` de `workflow.yml` surchargent encore les deux premières, jusqu'au retrait du YAML (ORC-177).

## Étape `tests` et contrôle `red` (ORC-123)

L'étape `tests` (agent, skill `factory:tests`, Sonnet, effort medium, réseau du dépôt) écrit **seulement** les tests qui traduisent les critères d'acceptation, et les commite. L'usine ne la croit pas sur parole : le contrôle `red` (`src/checks/red.ts`) constate lui-même.

1. Au lancement de l'étape, l'usine retient la tête du worktree (`baseSha`) ; un retour à l'étape garde la première. Le contrôle lit les fichiers changés par les seuls commits de l'étape (`baseSha..HEAD`, sur le dépôt de l'usine), plus les fichiers non commités ou non suivis du worktree. Un fichier qui n'est pas un test (règle unique de `src/checks/test-files.ts`, aides et données sous un dossier de test comprises) est une sortie du périmètre (`scope`), constatée sans rien lancer.
2. Il lance les seuls fichiers de test ajoutés ou modifiés (`*.test.ts`, `test_*.py`…, pas les aides ni les données) avec la commande du job (`red.command`, `npm test --` dans le pack). Avec des bacs à sable, `git status` et les tests tournent dans un bac à sable à part, sans réseau ; sans, sur l'hôte comme `verify`.
3. Il classe la sortie (vitest, jest, pytest), les erreurs avant « aucun test » (pytest écrit `collected 0 items / 1 error` avant une erreur d'import) :

| Sortie | Cause | Rouge |
| -- | -- | -- |
| échec sur une assertion (`AssertionError`, `expect(received)`, `E assert`) | `assertion` | vérifié |
| module introuvable (« Cannot find module », TS2307, `ModuleNotFoundError`) dont aucun chemin n'existe à `baseSha` : relatif au fichier de test en TypeScript, dans un paquet du dépôt en Python | `missing_module` | vérifié |
| symbole qu'un module existant n'exporte pas (TS2305, « does not provide an export named », `is not a function` d'une fonction importée par le test, `cannot import name`), absent du module à `baseSha` | `missing_export` | vérifié |
| module introuvable qui existe à `baseSha` | `module_at_base` | refusé |
| paquet introuvable (nom nu en TypeScript, paquet Python hors du dépôt) : le build n'en installe pas | `missing_package` | refusé |
| erreur de syntaxe, de type, de chargement ou de collecte ; symbole manquant qui existe déjà à `baseSha` | `compile` | refusé |
| échec sans assertion (erreur à l'exécution), délai dépassé | `error` | refusé |
| aucun test lancé, ou aucun test commité | `no_tests` | refusé |
| tests déjà verts | `passing` | refusé |
| fichier hors tests, commité ou non | `scope` | refusé |
| le contrôle n'a pas pu tourner (git, worktree, bac à sable) | `infra` | aucun verdict |

Le verdict revient comme le résultat de `verify` : `verify.passed` ou `verify.failed`, avec le champ `red` qui porte la cause. Un rouge vérifié démarre le job suivant (`on_success.run`, `dev` dans le pack).

**Mode mesure.** Sur les 20 premiers tickets, le contrôle est en mode mesure : il ne bloque jamais. Un rouge non vérifié, une sortie du périmètre comprise, laisse dans la décision la trace « red: aurait bloqué (<cause>), mode mesure : le run continue », et le build démarre. Les verdicts sont dans les mesures du ticket (`red` de `TicketMeasures`, ORC-235) : un rouge non `verified` est ce que le contrôle aurait bloqué.

**Mode bloquant.** Un rouge non vérifié, ou une sortie du périmètre, fait échouer l'étape : retour à `tests` (session reprise, verdict en entrée), borné par le compteur `red`, puis Bloqué.

**Panne.** Un contrôle qui n'a pas pu tourner (`infra`) bloque le ticket dans les deux modes, sans relancer l'agent : ce n'est pas un verdict sur ses tests. Il n'entre pas dans les mesures.

Le drapeau vit dans le job, figé avec la version du workflow de chaque ticket : `jobs.tests.red.mode: measure | blocking` (`measure` par défaut). Le passer en `blocking` dans `.factory/workflow.yml`, après validation sur les tickets dorés (ORC-236).

Le job `tests` du pack est inactif tant qu'aucune règle ne le lance : un dépôt l'active en faisant démarrer la délégation par lui (`ticket.delegated: - { when: "state in [todo, dev] && !blocked", run: tests }`). Les jobs sans `red` gardent le flux `dev` d'avant.

## Gel des tests et du harnais (ORC-131)

Après `red`, l'usine gèle ce qui juge l'agent : les tests que l'étape `tests` a commités et le harnais qui les lance (`src/checks/freeze.ts`). Le gel **bloque dès le premier ticket**, en mode mesure du rouge compris : seul un retour à `tests` en mode bloquant le reporte au rouge suivant.

**Ce qui est gelé**, lu sur le dépôt de l'usine au commit de fin de l'étape, jamais dans le worktree de l'agent : les tests de l'étape, et partout dans le dépôt les fichiers du harnais : `vitest.config.*`, `jest.config.*` (JSON compris), leurs `setup` et `workspace`, `setupTests.*`, `tsconfig*.json`, le script `test` de chaque `package.json`, `conftest.py`, `pytest.ini`, la section `[tool.pytest…]` de `pyproject.toml`. Chaque fichier a son empreinte sha256 (de son contenu, ou de la seule partie lue par les tests pour les deux manifestes). Le gel (commit et empreintes) est dans l'état du ticket (`frozenTests`), posé par l'événement journalisé qui l'a lu : qui et quand sont dans le journal.

**Le contrôle.** Une fois le gel posé, chaque run du ticket dans son worktree (`dev`, `dev-feedback`, `fix-ci`, `review`) passe par la vérification, même sans commande `verify` : l'usine lit les fichiers changés depuis le commit du gel jusqu'à la tête de la branche. Un fichier gelé modifié ou supprimé (un `skip` ou un `only` ajouté est une modification), ou un fichier du harnais ajouté, fait échouer `factory/tests-gelés` : la vérification échoue, le run repart avec le résumé, puis le ticket est Bloqué au bout de `verify`, sans passer en Human Review. Le contrôle ne regarde pas l'auteur : un commit humain sur un test gelé échoue de la même façon. Un contrôle qui ne peut pas lire la branche échoue aussi, et un fichier du commit illisible au moment du gel fait échouer sa lecture : le gel ne s'ouvre jamais sur une panne. Un second passage par `tests` ajoute ses nouveaux tests au gel, sans toucher à ceux déjà gelés ; un fichier du harnais ajouté depuis le premier gel n'y entre pas et continue d'échouer.

**`/refreeze`.** Seule sortie du gel : un mainteneur désigné (matrice d'ORC-186) mentionne l'agent dans le ticket avec `/refreeze`, ou répond `/refreeze` dans sa session. Avant la décision, l'usine lit le gel à la tête locale de la branche, sans `fetch` (les fichiers déjà gelés et le harnais), et le journalise avec la commande ; accepté, il remplace l'ancien et la réponse dans le ticket donne le commit ; la vérification suivante part de lui. Refusé (autre rôle, acteur non signé, ou aucun rôle résolu), la commande est journalisée (`authz: refused refreeze …`) et répondue dans le ticket, et le gel ne bouge pas. Le regel ne relance rien : un ticket Bloqué se relance comme d'habitude. Sur un ticket sans gel, `/refreeze` n'en crée pas : la réponse dit qu'il n'y a rien à regeler.

**Pas encore** : le check publié sur la PR (ORC-273) ; les fichiers non commités du worktree ne sont pas lus : un test laissé non commité n'est pas gelé, mais depuis ORC-151, avec les sandboxes, les commandes `verify` ne les voient pas non plus : elles et le gel lisent le même commit, dans un clone neuf ; un commit poussé hors du worktree de l'usine n'est vu qu'une fois tiré (ORC-159) ; un changement du tronc apporté par un `merge` ou un `rebase` compte comme un changement depuis le gel, et demande un `/refreeze` ; seuls les setup et fixtures nommés comme le harnais sont gelés, un `test/setup.ts` déjà là ne l'est que si l'étape l'a changé ; `/refreeze` depuis un commentaire de PR ; la table `freezes` séparée du journal ; le scan des tests désactivés hors fichiers gelés reste celui d'`anti-triche` (ORC-158).

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
