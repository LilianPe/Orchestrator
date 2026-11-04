# Configuration du dépôt : `.factory/config.yml`

Un dépôt peut déclarer à l'usine ses commandes, ses chemins sensibles et ses limites dans `.factory/config.yml`, à la racine. Le fichier est facultatif : sans lui, le socle de `factory/default` s'applique tel quel.

**Statut (ORC-209, partie A).** Le schéma et `factory validate` existent. Le démon ne lit encore de ce fichier que `env` et `setup_secrets`, sur la branche par défaut, à chaque lancement (ORC-211). La lecture du reste et l'interdiction de `.factory/**` à l'agent viennent avec la partie C d'ORC-209 ; `factory.yml` côté serveur avec la partie B.

## Exemple

```yaml
extends: factory/default@1.0
setup: pnpm install --frozen-lockfile && pnpm db:migrate
commands: { lint: pnpm lint, typecheck: pnpm typecheck, test: pnpm test }
env: [NODE_ENV]                              # des noms ; les valeurs sont dans factory.yml
setup_secrets: [NPM_TOKEN]                   # le setup seul, scellés avant l'agent
services: [postgres]
sensitive_paths: ["src/auth/**", "src/billing/**", "db/migrations/**"]
budgets: { per_ticket_tokens: 2000000 }      # à calibrer (ORC-216)
max_diff: { files: 15, lines: 400 }          # hors tests ; seulement resserrer
feature_flags: { provider: openfeature }    # facultatif
visual_paths: ["src/components/**", "app/**"]
network: { level: limited, allow: ["docs.exemple.com"] }   # none | limited (défaut) | custom
```

## Clés

| Clé | Type | Défaut | Rôle |
| -- | -- | -- | -- |
| `extends` | texte | `factory/default@1.0` | Le préréglage ; seul `factory/default@1.0` existe au MVP. |
| `setup` | commande | aucune | Préparation du dépôt (installation, migrations). |
| `commands` | `nom: commande` | `{}` | Les contrôles du dépôt (`lint`, `typecheck`, `test`…). |
| `env` | liste de noms | `[]` | Variables que le runner reçoit, `setup` et agent. Voir [Variables et secrets](#variables-et-secrets). |
| `setup_secrets` | liste de noms | `[]` | Secrets que le `setup` seul reçoit, scellés avant que l'agent démarre. |
| `services` | liste | `[]` | Services à démarrer à côté du runner (`postgres`…). |
| `sensitive_paths` | liste de motifs | `[]` | Chemins dont la modification marque le run (relecture renforcée). |
| `budgets.per_ticket_tokens` | entier > 0 | aucun | Plafond de tokens du ticket (ORC-216). |
| `max_diff` | `{ files, lines }` | `{ 15, 400 }` | Taille maximale du diff hors tests ; on ne peut que resserrer. |
| `feature_flags.provider` | texte | aucun | Fournisseur de feature flags. |
| `visual_paths` | liste de motifs | `[]` | Chemins qui demandent une preuve visuelle (ORC-176). |
| `network` | `{ level, allow }` | `limited`, `[]` | Niveau réseau de l'agent : `none`, `limited` ou `custom`. |

## Variables et secrets

Une variable n'entre dans le runner que si **le dépôt déclare son nom** ici et que **le serveur donne sa valeur** dans `factory.yml` (`repos[].env`, `repos[].secrets`, voir [`configuration.md`](configuration.md)). Le dépôt ne peut donc pas demander une variable du démon, et le serveur ne met rien dans un runner que le dépôt n'a pas déclaré. Un nom déclaré sans valeur reste absent, et le démon le journalise.

Sont refusés : un nom qui n'est pas en majuscules, chiffres et `_` ; les noms réservés à l'usine (proxy et autorité, `PATH`, `LD_*`, `NODE_OPTIONS`, `ANTHROPIC_*`, `CLAUDE*`, `FACTORY_*`, `LINEAR_*`, `GH_*`, `GITHUB_*`, `GIT_*`, `PIP_*`, `UV_*`, `YARN_*`, `NPM_CONFIG_*`…) ; sous `env`, un nom de secret (`*_TOKEN`, `*_KEY`, `*_SECRET`, `DATABASE_URL`…), que l'agent verrait, et un nom aussi présent sous `setup_secrets`.

## Le `setup`

Le `setup` tourne dans un conteneur à lui, au niveau réseau `limited`, avec le worktree en écriture et le dossier git du dépôt en **lecture seule** : une commande qui écrit dans `.git` (`git submodule update`, `git lfs pull`, un hook posé par husky) échoue. Ce conteneur est détruit à la fin, avec son `$HOME` et son `/tmp` : l'agent ne retrouve que ce que le `setup` a écrit dans le worktree.

Il s'exécute sous ces réglages, posés par l'environnement :

| Réglage | Variables | Effet |
| -- | -- | -- |
| Pas de script d'installation | `npm_config_ignore_scripts`, `YARN_ENABLE_SCRIPTS`, et un `~/.yarnrc` pour Yarn 1 | npm, pnpm et Yarn ne lancent aucun `postinstall`. Une commande explicite (`npm run db:migrate`) tourne encore. Une compilation native à l'installation ne se fait donc pas. |
| Roues binaires | `PIP_ONLY_BINARY=:all:`, `UV_NO_BUILD=1` | Aucun paquet source construit à l'installation. uv construit encore le projet lui-même ; pip refuse un paquet sans roue. |
| Âge minimal : 7 jours | `npm_config_minimum_release_age`, `npm_config_before`, `UV_EXCLUDE_NEWER` | Une version publiée depuis moins de 7 jours est refusée à la résolution. Un lockfile respecté (`npm ci`, `uv sync --frozen`) garde ses versions. `uv sync --locked` échoue sur un lockfile fait sans ce plafond : utilisez `--frozen`. |

Une commande du dépôt peut passer outre (`--ignore-scripts=false`) : ces réglages protègent d'une dépendance, pas du dépôt lui-même.

Après le `setup`, avant l'agent, `sealSecrets` supprime tout fichier du worktree qui contient une valeur de `setup_secrets`, telle quelle ou encodée en base64, dans une URL ou en JSON. Un secret haché, ou encodé autrement, n'est pas reconnu : ne le laissez pas dans le worktree sous une autre forme.

## Ce qu'une configuration ne peut pas faire

Une configuration **ajoute** des contrôles ou des interdits, elle n'en **retire** jamais au socle. `factory validate` refuse, avec le chemin de la clé fautive :

- une clé inconnue, comme `checks: { disable: [...] }` : rien ne peut éteindre un contrôle du socle, et une clé ignorée en silence laisserait croire le contraire ;
- un motif négatif (`!…`) dans `sensitive_paths` ou `visual_paths` : il retirerait un chemin ;
- un `max_diff` plus large que le socle (15 fichiers, 400 lignes) ;
- `network.level: full`, réservé à `setup`, jamais pour l'agent ; et dans `network.allow`, tout ce qui n'est pas un nom d'hôte (`*`, `*.com`, `0.0.0.0/0`) : un joker ou une plage reviendrait à `full` ;
- un autre préréglage que `factory/default@1.0`.

Les chemins interdits du socle (`.factory/**`) restent toujours interdits à l'agent, quoi que le fichier déclare.

`custom` est `limited` avec les hôtes du dépôt : c'est le plafond `limited` contre lequel les étapes du préréglage sont vérifiées ; `none` est le plafond `none`.

## Vérifier

```bash
factory validate            # le dépôt courant
factory validate ../mon-depot
```

Code de sortie 0 si le fichier est valide (ou absent), 1 sinon, avec une ligne par violation et le chemin de l'élément fautif (`sensitive_paths[1]`, `commands.test`). Un `.factory/config.yaml` est refusé : l'usine ne lit que `config.yml`.
