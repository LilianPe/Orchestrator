# Configuration du dépôt : `.factory/config.yml`

Un dépôt peut déclarer à l'usine ses commandes, ses chemins sensibles et ses limites dans `.factory/config.yml`, à la racine. Le fichier est facultatif : sans lui, le socle de `factory/default` s'applique tel quel.

**Statut (ORC-209).** Le schéma, `factory validate` et la lecture par le démon existent (voir [Quand et où il est lu](#quand-et-où-il-est-lu)). Appliqués aux runs : `setup`, `env`, `setup_secrets` et `network` au lancement, `commands`, `setup` et `env` à chaque `verify`. Lus et validés, mais pas encore appliqués : `budgets` (ORC-216), `services` (ORC-282, ORC-309), `max_diff` (ORC-145, ORC-125), `sensitive_paths` (le moteur garde la liste du socle), `visual_paths` et `feature_flags`.

## Quand et où il est lu

- **Au lancement de chaque run d'agent**, une seule fois, sur la branche par défaut de la forge, récupérée juste avant dans le dépôt de l'usine (`git fetch origin`, puis `origin/HEAD`) : jamais dans le worktree de l'agent, ni sur sa branche. L'agent ne peut pas écrire cette référence : son dossier git est le sien (ORC-317). Le run en tire son `setup`, ses variables et son niveau réseau, et la garde : ce qui le contrôle ensuite (le contrôle du rouge, `verify` sur l'hôte sans sandbox) reprend cette lecture, même si la branche par défaut a changé entre-temps.
- **Une forge qui ne répond pas refuse le lancement** : le `fetch` est borné à 2 minutes, sans demande d'identifiants. Le ticket se bloque (« Erreur au lancement : la forge ne répond plus après 120 s ») et se range parmi les pannes d'infrastructure dans le Flux, comme une branche par défaut illisible. Le message ne contient ni le chemin du dépôt sur le serveur ni la commande git : le détail est dans le journal du démon. Il ne propose `git remote set-head origin --auto` que lorsque `origin/HEAD` manque sur le dépôt de l'usine.
- **À chaque `verify`**, sur la branche par défaut de la forge, récupérée à ce moment-là dans un clone à part (ORC-151) : `commands`, `setup` et `env`.
- **Un fichier invalide refuse le lancement** : le ticket se bloque avec le message de `factory validate` (« Configuration du dépôt à corriger : .factory/config.yml refusé : … »), sans worktree neuf, sans sandbox ni run. Aucun run ne part sur une config à moitié lue. Le Flux le range sous « Configuration du dépôt invalide », pas parmi les pannes. Un `.factory` ou un `config.yml` qui est un lien symbolique est refusé de même : git ne lit rien à travers un lien. Corrigez le fichier sur la branche par défaut, puis relancez.
- **L'agent ne peut pas changer la config de son run.** `.factory/**` est un chemin interdit : `verify` bloque un commit qui y touche (`factory/chemins-interdits`), et le run suivant relit le fichier de la branche par défaut. Une modification de la config passe par une PR humaine, mergée sur la branche par défaut.

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
network: { level: custom, allow: ["docs.exemple.com"] }    # none | limited (défaut) | custom ; `allow` pour custom seul
```

## Clés

| Clé | Type | Défaut | Rôle |
| -- | -- | -- | -- |
| `extends` | texte | `factory/default@1.0` | Le préréglage ; seul `factory/default@1.0` existe au MVP. |
| `setup` | commande | aucune | Préparation du dépôt (installation, migrations), lancée sur chaque worktree neuf avant l'agent ; `verify` la relance sur son clone neuf, à `limited` et sans secret, avant ses commandes. Absente : `workspace.setup` du workflow. |
| `commands` | `nom: commande` | `{}` | Les contrôles du dépôt (`lint`, `typecheck`, `test`…), lancés par `verify` dans l'ordre du fichier, au niveau réseau `none`. Vide : `jobs.<job>.verify` du workflow, jusqu'à ORC-177. |
| `env` | liste de noms | `[]` | Variables que le runner reçoit : `setup`, agent, contrôle du rouge, et `verify`. Voir [Variables et secrets](#variables-et-secrets). |
| `setup_secrets` | liste de noms | `[]` | Secrets que le `setup` seul reçoit, scellés avant que l'agent démarre. |
| `services` | liste | `[]` | Services à démarrer à côté du runner (`postgres`…). |
| `sensitive_paths` | liste de motifs | `[]` | Chemins dont la modification marque le run (relecture renforcée). |
| `budgets.per_ticket_tokens` | entier > 0 | aucun | Plafond de tokens du ticket (ORC-216). |
| `max_diff` | `{ files, lines }` | `{ 15, 400 }` | Taille maximale du diff hors tests ; on ne peut que resserrer. |
| `feature_flags.provider` | texte | aucun | Fournisseur de feature flags. |
| `visual_paths` | liste de motifs | `[]` | Chemins qui demandent une preuve visuelle (ORC-176). |
| `network` | `{ level, allow }` | `limited`, `[]` | Niveau réseau de l'agent : `none`, `limited` ou `custom`. Voir [Réseau de l'agent](#réseau-de-lagent). |

## Variables et secrets

Une variable n'entre dans le runner que si **le dépôt déclare son nom** ici et que **le serveur donne sa valeur** dans `factory.yml` (`repos[].env`, `repos[].secrets`, voir [`configuration.md`](configuration.md)). Le dépôt ne peut donc pas demander une variable du démon, et le serveur ne met rien dans un runner que le dépôt n'a pas déclaré. Un nom déclaré sans valeur reste absent, et le démon le journalise.

Sont refusés : un nom qui n'est pas en majuscules, chiffres et `_` ; les noms réservés à l'usine (proxy et autorité, `PATH`, `LD_*`, `NODE_OPTIONS`, `ANTHROPIC_*`, `CLAUDE*`, `FACTORY_*`, `LINEAR_*`, `GH_*`, `GITHUB_*`, `GIT_*`, `PIP_*`, `UV_*`, `YARN_*`, `NPM_CONFIG_*`…) ; sous `env`, un nom de secret (`*_TOKEN`, `*_KEY`, `*_SECRET`, `DATABASE_URL`…), que l'agent verrait, et un nom aussi présent sous `setup_secrets`.

## Le `setup`

Le `setup` tourne dans un conteneur à lui, au niveau réseau `limited`, avec le worktree en écriture et son dossier `.git` en **lecture seule** : une commande qui écrit dans `.git` (`git submodule update`, `git lfs pull`, un hook posé par husky) échoue. Ce conteneur est détruit à la fin, avec son `$HOME` (`/tmp/setup-home`) et son `/tmp` : l'agent ne retrouve que ce que le `setup` a écrit dans le worktree.

Il s'exécute sous ces réglages, posés par l'environnement :

| Réglage | Variables | Effet |
| -- | -- | -- |
| Pas de script d'installation | `npm_config_ignore_scripts`, `YARN_ENABLE_SCRIPTS`, et un `~/.yarnrc` pour Yarn 1 | npm, pnpm et Yarn ne lancent aucun `postinstall`. Une commande explicite (`npm run db:migrate`) tourne encore. Une compilation native à l'installation ne se fait donc pas. |
| Roues binaires | `PIP_ONLY_BINARY=:all:`, `UV_NO_BUILD=1` | Aucun paquet source construit à l'installation. uv construit encore le projet lui-même ; pip refuse un paquet sans roue. |
| Âge minimal : 7 jours | `npm_config_minimum_release_age`, `npm_config_before`, `UV_EXCLUDE_NEWER` | Une version publiée depuis moins de 7 jours est refusée à la résolution. Un lockfile respecté (`npm ci`, `uv sync --frozen`) garde ses versions. `uv sync --locked` échoue sur un lockfile fait sans ce plafond : utilisez `--frozen`. |

Une commande du dépôt peut passer outre (`--ignore-scripts=false`) : ces réglages protègent d'une dépendance, pas du dépôt lui-même.

Conséquence du conteneur à part : ce qu'un outil range dans `$HOME` disparaît. Un projet Yarn PnP avec son cache global, un virtualenv Poetry sous `~/.cache`, des navigateurs Playwright doivent s'installer dans le worktree, sinon l'agent ne les retrouve pas.

Après le `setup`, avant l'agent, `sealSecrets` supprime tout fichier du worktree qui contient une valeur de `setup_secrets` : telle quelle, en base64, seule ou dans une valeur plus longue (`user:jeton`), dans une URL ou en JSON. Un secret haché, chiffré, ou en base64 coupé en lignes n'est pas reconnu : ne le laissez pas dans le worktree sous une autre forme.

Le `setup` ne reçoit **aucun secret** quand sa branche a des commits au-delà de la branche par défaut (un ticket repris après la suppression de son worktree) : il exécuterait du code qu'aucun humain n'a relu. Un `setup` qui a besoin d'un secret échoue alors, et le ticket se bloque.

## Ce qu'une configuration ne peut pas faire

Une configuration **ajoute** des contrôles ou des interdits, elle n'en **retire** jamais au socle. `factory validate` refuse, avec le chemin de la clé fautive :

- une clé inconnue, comme `checks: { disable: [...] }` : rien ne peut éteindre un contrôle du socle, et une clé ignorée en silence laisserait croire le contraire ;
- un motif négatif (`!…`) dans `sensitive_paths` ou `visual_paths` : il retirerait un chemin ;
- un `max_diff` plus large que le socle (15 fichiers, 400 lignes) ;
- `network.level: full`, réservé à `setup`, jamais pour l'agent ; dans `network.allow`, tout ce qui n'est pas un nom d'hôte (`*`, `*.com`, `0.0.0.0/0`) : un joker ou une plage reviendrait à `full` ; et une liste `allow` sous un autre niveau que `custom`, qui n'ouvrirait rien ;
- un autre préréglage que `factory/default@1.0`.

Les chemins interdits du socle (`.github/workflows/**`, `.factory/**`, `.claude/**`, `.git/hooks/**`, `.git/config`, `.gitattributes`, `.gitmodules`, `.npmrc`, `package.json#scripts`, `.husky/**`, `.vscode/**`, `Dockerfile*`, `.devcontainer/**`, `claims/**`, liens symboliques sortants) restent toujours interdits à l'agent, quoi que le fichier déclare. `factory/chemins-interdits` les bloque dans `verify`, à toute profondeur, sauf `.github/workflows/**` et `claims/**`, lus à la racine (ORC-151).

`custom` est `limited` avec les hôtes du dépôt : c'est le plafond `limited` contre lequel les étapes du préréglage sont vérifiées ; `none` est le plafond `none`.

## Réseau de l'agent

Chaque run d'agent prend le niveau du dépôt, lu au lancement :

| `network.level` | Ce que l'agent joint |
| -- | -- |
| `limited` (défaut) | L'API Claude, GitHub et les registres en lecture, les docs de la liste de l'usine. |
| `custom` | `limited`, plus les hôtes de `network.allow`, en lecture. |
| `none` | L'API Claude seule (`claude-api`) : sans elle, l'agent ne tourne pas. |

Toutes les étapes ont aujourd'hui ce même niveau : celui que le préréglage donne à chaque étape (la revue en `claude-api`) s'appliquera quand la revue se passera de `gh` et de `git fetch` (ORC-322). Après un redémarrage du démon, un run repris garde son niveau mais perd la liste `allow` : il ne peut que se restreindre.

## Vérifier

```bash
factory validate            # le dépôt courant
factory validate ../mon-depot
```

Code de sortie 0 si le fichier est valide (ou absent), 1 sinon, avec une ligne par violation et le chemin de l'élément fautif (`sensitive_paths[1]`, `commands.test`). Un `.factory/config.yaml` est refusé : l'usine ne lit que `config.yml`.
