# Ligne de commande

Relais fournit deux exécutables (installés par `npm link`, voir [`installation.md`](installation.md)) :

- **`relais`** : pour vous, l'opérateur ;
- **`relais-agent`** : pour les agents, pendant un run. Vous ne l'appelez pas vous-même.

Toutes les commandes `relais` lisent `RELAIS_HOME` (défaut `~/.relais`) et `config.yaml`. Une commande inconnue ou incomplète affiche l'aide et sort avec le code 1.

## `relais`

| Commande | Rôle | Démon requis |
|---|---|---|
| `relais init` | Configurer Relais pour le dépôt courant. | non |
| `factory doctor [repo]` | Refuser un dépôt dont la CI peut exposer des secrets aux branches de l'usine. | non (GitHub App) |
| `relais up [--fake-runner]` | Démarrer le démon. | — |
| `relais plan` | Lister les tickets délégués et dire lesquels seraient pris. | non (Linear connecté) |
| `relais status` | État de l'instance en cours. | oui |
| `relais pause` / `relais resume` | Suspendre / reprendre la file. | oui |
| `relais stop <ID>` | Arrêter le run d'un ticket. | oui |
| `factory run repair <ID> [replay\|skip\|force] [<événement>]` | Lister ou réparer les événements mis de côté (dead-letter) d'un ticket. | non (lit et écrit la base) |

Les commandes qui demandent le démon appellent `http://127.0.0.1:<port>/api/…` avec le `port` de `config.yaml`. Si `RELAIS_UI_PASSWORD` est défini dans votre shell, elles l'envoient en HTTP Basic (nécessaire quand le démon écoute hors bouclage). En Docker, lancez-les dans le conteneur : `docker compose exec factoryd node dist/src/cli/factory.js status`.

### `relais init`

À lancer **dans le dépôt** à confier à Relais (sinon il demande le chemin du dépôt). Assistant interactif :

1. Demande la **clé de l'équipe Linear** (ex. `REL`), mise en majuscules.
2. Ajoute (ou remplace) le projet dans `config.yaml` : `id` = nom du dossier du dépôt (slug, 30 caractères max), `repoPath` = racine git, `linearTeamKey`.
3. Sans `publicUrl` ni relais configuré, crée un **canal smee.io** et l'enregistre dans `relay`.
4. Affiche les valeurs exactes à saisir dans Linear (URL de callback, URL de webhook, catégories) puis demande **Client ID**, **Client secret** et **Webhook signing secret** (redemandé tant que la réponse est vide), enregistrés dans `secrets.json`. Détails : [`linear.md`](linear.md).
5. Si aucune base de connaissance n'est configurée, propose de créer un dépôt GitHub privé `relais-knowledge` (`gh repo create`). Voir [`projets-et-workspaces.md`](projets-et-workspaces.md#base-de-connaissance-partagée).
6. Si `.relais/workflow.yml` n'existe pas, le crée : demande les commandes de vérification (proposées à partir des scripts `lint`, `typecheck`, `test` de `package.json`, séparées par `;`) et met `workspace.setup: ["npm ci"]` si le dépôt a un `package-lock.json`. Contenu exact : [`workflow.md`](workflow.md#1-rôle-du-fichier-et-fusion-avec-le-pack).
7. Écrit `config.yaml` et affiche la suite : `relais up`, « Connecter Linear », déléguer un ticket.

`relais init` est relançable : pour un deuxième dépôt (nouveau projet), ou pour changer les identifiants Linear. Il ne réécrit jamais un `.relais/workflow.yml` existant. Pensez à commiter `.relais/workflow.yml` dans le dépôt.

### `relais up`

Démarre le démon au premier plan : serveur HTTP (interface, API, webhooks, OAuth), relais smee, minuteries, réconciliation Linear et GitHub toutes les 5 minutes par minuterie en base (relevé des PR toutes les 30 s si les webhooks GitHub sont refusés), réévaluation de la file toutes les minutes. Affiche `Relais tourne : <url>`.

- Écrit `<RELAIS_HOME>/run-settings.json` (voir [`configuration.md`](configuration.md#ce-qui-ne-sort-pas-du-démon)).
- Clôt les runs interrompus par un arrêt ou un crash précédent et bloque leurs tickets (voir [`exploitation.md`](exploitation.md#arrêt-redémarrage-et-runs-interrompus)).
- Si Linear n'est pas connecté, journalise `Linear non connecté : ouvrez <url>/oauth/start`.
- Si le secret de webhook manque dans `secrets.json`, journalise un avertissement : tous les webhooks seront refusés (401) tant qu'il n'est pas renseigné.
- Refuse de démarrer si `host` n'est pas en bouclage et que `RELAIS_UI_PASSWORD` est vide.

`Ctrl+C` (SIGINT) ou SIGTERM : arrêt propre (les runs en cours sont interrompus, puis repris en main au prochain démarrage).

`--fake-runner` : remplace Claude Code par un runner simulé qui répond « Terminé. » sans rien coûter. Pour tester l'interface et le câblage Linear.

### `factory validate [repo]`

Vérifie le `.factory/config.yml` du dépôt (le dépôt courant par défaut) contre le socle : une configuration ajoute des contrôles ou des interdits, elle n'en retire jamais. Sortie 1 avec une ligne par violation (clé inconnue, motif négatif, `max_diff` élargi, réseau `full`), 0 sinon ou sans fichier. Ne demande pas d'instance. Voir [configuration du dépôt](configuration-depot.md) (ORC-209).

### `factory doctor [repo]`

Contrôle avant de confier un dépôt : refuse (code retour `1`) une CI qui peut exposer des secrets à une branche `factory/*` sans approbation humaine, et accepte (code `0`) une CI sans secrets ou dont les jobs à secrets sont sous un environnement protégé avec required reviewers.

- Lit `.github/workflows` et `GET /repos/{owner}/{repo}/environments` avec la GitHub App : pas de repli `gh`.
- Résout `owner/name` par `git remote get-url origin` ; dépôt courant par défaut.
- `--json` : rapport machine (workflows, déclencheurs, secrets oui/non, environnements, verdict).
- N'affiche jamais de secret ; en cas de doute (YAML ambigu, `on` dynamique, secrets indirects, API en erreur), refuse.

Règle complète, exemples et limites : [`github.md`](github.md).

### `relais plan`

Ne démarre rien. Pour chaque projet, liste les tickets délégués à l'agent dans Linear, triés par priorité :

```text
REL-12  pris  Ajouter l'export CSV
REL-15  pas pris  Corriger le login — La description fait moins de 30 caractères.
REL-9  déjà géré  Refonte du menu (human_review)
```

- `pris` : passerait les contrôles `tracker.pickup.checks` ;
- `pas pris` : suivi des raisons ;
- `déjà géré` : déjà suivi par Relais (avec son état logique).

Exige que Linear soit connecté (`Linear non connecté : lancez relais up puis connectez Linear.` sinon).

### `relais status`

```text
Linear : connecté · file : active · places dev 1/3 · coût du jour 2.40 $
  REL-12  dev  Ajouter l'export CSV
  REL-15  todo (bloqué)  Corriger le login
```

### `relais pause` / `relais resume`

`pause` : plus aucun run ne démarre ; les demandes s'accumulent dans la file. Les runs en cours continuent. L'état de pause est conservé dans `relais.db` et survit à un redémarrage. `resume` relance la file. Équivalent au bouton « Pause / Reprendre » de l'interface.

### `relais stop <ID>`

Arrête le run du ticket `<ID>` (ex. `REL-12`) : SIGINT au processus Claude Code, puis SIGKILL après 10 s. Le ticket est bloqué jusqu'à une réponse dans le fil Linear ou le label `agent:reprendre`. Équivalent au bouton « Stop » de l'interface, au « stop » de la session Linear et au label `agent:stop`.

### `factory replay <journal.json | dossier>...` (ORC-174)

Rejoue des journaux de tickets exportés, sans instance ni réseau : chaque ligne du journal passe par les upcasters (`schemaVersion`, et les minuteries enregistrées d'avant ORC-161 par `upcastTimer`), puis sa décision est refaite (`decide`, puis `reduce`) à partir de ce que la transaction de décision a enregistré (projection lue sous le verrou, version du workflow, horloge). Un dossier est lu en entier (`*.json`, par ordre de nom).

- **Régression** (par défaut) : la projection, les effets, les minuteries et la remise à zéro des minuteries doivent ressortir **bit à bit** comme enregistrés (JSON canonique, clés triées). Chaque divergence est listée avec l'événement qui la porte. Code de sortie 0 sans divergence, 1 si un journal diverge, 2 sur une option inconnue, un journal illisible ou impossible à rejouer (version de workflow absente) ou un journal sans aucune décision ; les autres journaux du dossier sont rejoués quand même.
- **What-if** (`--what-if <workflow.yml>`) : les décisions tournent sur ce workflow, posé sur le pack standard (`--pack <dossier>` pour un autre), au lieu des versions sur lesquelles les tickets étaient figés. Le rejeu s'arrête à la première divergence et la signale :

```
test/replay/journals/check-failed-then-feedback.json : p/REL-1 : 4 décision(s) rejouée(s) — arrêt à la première divergence
  événement check:id-1 (verify.failed, n° 4 du journal) : ticket.blockReason enregistré absent, rejoué "Vérifications toujours en échec après 1 tentatives."
  événement check:id-1 (verify.failed, n° 4 du journal) : effects[0].kind enregistré "start_run", rejoué "activity"
1 journal(aux) sur 1 divergent.
```

`factory replay --export <ID> [--project <id>] [--out <fichier>]` écrit le journal d'un ticket de l'instance (store de `FACTORY_DATABASE_URL`, sinon `factory.db`, ouvert sans migration), avec les versions de workflow de ses décisions. `--project` est requis quand l'instance a plusieurs projets. Un ticket sans événement journalisé, ou une instance sans base, est refusé plutôt qu'exporté vide. Le format et la mise en CI : [`tests.md`](tests.md#loracle-de-rejeu).
### `factory run repair <ID> [replay|skip|force] [<événement>]`

Répare un événement dont la décision a échoué et que le démon a mis de côté (table `dead_letter`) en bloquant le ticket `<ID>`. Sans action, liste les événements mis de côté du ticket (ouverts et déjà réparés) ; avec une action, répare le seul ouvert, ou celui donné en dernier argument :

```text
$ factory run repair REL-12
Événements mis de côté pour REL-12 :
  l1  label.changed  ouvert  (1 échec) rule.when.every is not a function
$ factory run repair REL-12 replay
Événement l1 (label.changed) rejoué par armand : réparation journalisée, décidée au prochain passage du démon.
```

- `replay` : décider l'événement de nouveau, après un correctif ;
- `skip` : l'ignorer (refusé pour un résultat de run ou de vérifications : utilisez `force`) ;
- `force` : enregistrer ses faits sans sa décision (aucun effet).

Le ticket est débloqué et la réparation journalisée (événement `dead_letter.repaired`, avec le nom de l'utilisateur). La commande écrit dans la base de l'instance (SQLite, ou Postgres avec `FACTORY_DATABASE_URL`) : le démon n'a pas besoin de tourner, il décide la réparation à son prochain passage. Un événement sans ticket se désigne par son id à la place de `<ID>`. Détails : [`exploitation.md`](exploitation.md#dead-letter-et-factory-run-repair-orc-175).

## `relais-agent` (côté agent)

Pendant un run, Relais ajoute `bin/` de Relais au `PATH` et pose `RELAIS_API` et `RELAIS_RUN_TOKEN`. L'agent utilise alors :

| Commande | Effet |
|---|---|
| `relais-agent issue <ID>` | Affiche le ticket : identifiant, titre, statut, URL, description. **Limité au ticket du run** (403 sinon). |
| `relais-agent search <texte>` | Recherche des tickets Linear. |
| `relais-agent kb search <mots>` | Recherche dans `notes/*.md` de la base de connaissance (mots de 3 lettres ou plus, sans accents ni casse). Affiche `fichier:ligne: texte`. |
| `relais-agent ask <question>` | Publie la question dans la session Linear (elicitation) et **bloque** le ticket. L'agent doit terminer son tour ; la réponse humaine relance le travail. |

Lancé hors d'un run, il répond `relais-agent doit être lancé par Relais (RELAIS_API et RELAIS_RUN_TOKEN manquants).` (code 2). Le jeton n'est accepté que tant que le run est en cours. Le pack autorise `Bash(relais-agent:*)` et le hook de démarrage rappelle ces commandes à l'agent ([`pack-et-skills.md`](pack-et-skills.md)).

## Scripts de développement

Voir [Contribuer](../README.md#contribuer).
