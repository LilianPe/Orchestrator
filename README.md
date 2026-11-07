> **Orchestrator** (nom de bêta de l'usine) : ces docs décrivent l'état de départ (Relais) ; elles sont réécrites ticket par ticket. Le code porte déjà les nouveaux noms (CLI `factory`, variables `FACTORY_*`, `~/.factory`, `.factory/`) : la correspondance est dans [`docs/transition.md`, « Renommage »](docs/transition.md#renommage-orc-167).

# Relais

Orchestrateur d'agents de code : un ticket Linear délégué à l'agent devient une PR, relue par un humain puis par une boucle de review IA, prête à merger. Prototype privé.

- Relais tourne comme un démon (`relais up`) relié à **Linear** (application agent OAuth + webhooks) et à **GitHub** (CLI `gh`).
- Chaque ticket délégué obtient son worktree git et une session **Claude Code** headless, reprise de run en run (retours, CI, review).
- Le comportement (événements, jobs, modèles, limites, vérifications) se décrit en YAML par dépôt (`.relais/workflow.yml`) ; les consignes des agents vivent dans un pack de skills, pas dans le cœur.
- Les humains gardent la main : seuls eux mergent, l'agent pose ses questions dans Linear, une base de connaissance partagée s'enrichit par PR relues.

## Prérequis

Node.js 24+, git, GitHub CLI `gh` connecté, Claude Code CLI `claude` connecté, un espace Linear dont vous êtes admin et un dépôt GitHub cloné en local. Détails : [`docs/installation.md`](docs/installation.md).

## Démarrage rapide

De zéro à un premier ticket traité :

```bash
# 1. Installer
git clone https://github.com/LilianPe/relais.git && cd relais
npm ci && npm run build && npm link

# 2. Configurer le dépôt à confier à Relais
cd <votre dépôt>
relais init          # équipe Linear, application OAuth, base de connaissance, .relais/workflow.yml

# 3. Démarrer
relais up            # http://localhost:4100, puis « Connecter Linear »
```

4. Dans Linear, créez un ticket clair (au moins 30 caractères de description) et **déléguez-le à `@relais`**. En moins de 10 s : le commentaire « Bien reçu. » et le plan dans la session, puis statut *In Progress*, sortie en direct dans l'interface, puis PR ouverte, statut *Human Review* et résumé dans la session Linear.
5. Répondez dans la session pour demander des changements, passez le ticket en *AI Review* pour la review IA, mergez la PR sur GitHub : le ticket passe en *Done*.

Sans tokens, pour tester l'interface : `relais up --fake-runner`.

## Documentation

### Installer
- [Installation](docs/installation.md) : prérequis, installation, répertoire home du démon.
- [Linear](docs/linear.md) : application OAuth, connexion de l'agent, webhooks, délégation, statuts et labels.
- [GitHub](docs/github.md) : compte et droits, relevé des PR, branches, protection de branche, CI.
- [Déploiement](docs/deploiement.md) : Docker, service longue durée, arrêt propre et mise à jour.

### Configurer
- [Configuration du démon](docs/configuration.md) : variables d'environnement, `config.yaml`, `secrets.json`, `factory.yml` (secrets en `env:`), budget journalier, ports, secrets.
- [Personnaliser `workflow.yml`](docs/workflow.md) : événements, jobs, modèles, limites, vérifications, recettes.
- [Configuration du dépôt (`.factory/config.yml`)](docs/configuration-depot.md) : clés, ce qu'une configuration ne peut pas retirer au socle, `factory validate`.
- [Le préréglage `factory/default`](docs/preset.md) : étapes typées, bornes des boucles, compteur unique review + CI rouge, modèles et réseau par étape, invariants vérifiés à la compilation, hash.
- [Projets, worktrees et base de connaissance](docs/projets-et-workspaces.md) : plusieurs dépôts, worktrees par ticket, `workspace.setup`, ports, nettoyage, dépôt de connaissance.
- [Pack et skills](docs/pack-et-skills.md) : skills de job et skills de méthode (TDD, débogage, vérification, review à niveaux), règles toujours actives, permissions, personnaliser ou créer un skill.

### Utiliser
- [Ligne de commande](docs/cli.md) : `relais init|up|plan|status|pause|resume|stop` et `relais-agent`.
- [Interface web et sécurité](docs/interface-et-securite.md) : interface, routes exposées, mot de passe, CSRF, limites connues.

### Exploiter
- [Exploitation](docs/exploitation.md) : limites atteintes, tickets bloqués, pause, journaux et transcripts, redémarrages, dépannage.
- [Recette](docs/recette.md) : vérification de bout en bout sur un Linear de test.

### Transition vers l'usine
- [Point de départ](docs/transition.md) : commit et tag de référence (`relais-v1-final`), tests live hors CI, inventaire des modules avec leur statut et le ticket qui les touche.

### Tester
- [Tests et harnais](docs/tests.md) : écrire un scénario avec les faux adaptateurs, l'horloge simulée et le préréglage de test.
- [Idempotence des effets externes](docs/idempotence.md) : la table des 7 effets (clé, déduplication, comportement en doublon), un test par ligne, ce que Linear, GitHub et Docker permettent.
- [Contrats des ports](docs/ports/README.md) : une fiche par port (méthodes, idempotence, erreurs, fencing) et sa suite de conformité, à faire passer à tout nouvel adaptateur.

### Décisions
Pages des tickets de décision : question, options, preuves, recommandation, puis la décision du dev, écrite aussi dans le ticket.
- [ORC-128 — Options de `claude -p`](docs/decisions/ORC-128.md) : ignorer les réglages du dépôt, couper les outils web intégrés, reprendre la session d'un ticket.
- [ORC-129 : inbox + outbox maison ou DBOS Transact](docs/decisions/ORC-129.md) : décision (option maison), spike `kill -9` et rejeu sur les deux options, impact sur les tickets du moteur.
- [ORC-138 — Invariants de `decide` et doublons des effets](docs/decisions/ORC-138.md) : tranché le 2026-10-22, toutes les recommandations retenues. Les 12 invariants testables par propriété et la table d'idempotence des 7 effets externes.

### Contribuer

```bash
npm test                  # unitaires et scénarios (projet vitest `unit`)
npm run test:all          # tous les projets vitest
npm run test:integration  # Postgres (DATABASE_URL requis)
npm run test:isolation    # moteur rootless (FACTORY_ISOLATION=1)
npm run test:chaos        # démon tué par kill -9 au hasard (CHAOS_EVENTS=500 et DATABASE_URL comme la CI)
NUM_RUNS=10000 npm run test:properties  # invariants de decide sur 10 000 séquences, comme la CI
npm run typecheck         # types du démon et de l'interface
npm run lint
npm run dev               # CLI depuis les sources (tsx) : npm run dev -- up
npm run dev:web           # interface avec proxy vers :4100
```

Règles :

- **Toute nouvelle feature livre sa doc** : une page dans `docs/` (installation, configuration, utilisation) ou une section d'une page existante, et son lien depuis ce README. Une feature sans doc n'est pas terminée.
- Les exemples YAML de [`docs/workflow.md`](docs/workflow.md) sont chargés par un test (`src/docs-workflow.test.ts`) : gardez-les valides.
- Code, noms de fichiers et messages de commit en anglais (`feat(core): …`, `docs: …`) ; textes destinés aux humains (docs, skills du pack, messages Linear) en français.
- La CI (`.github/workflows/ci.yml`) lance typecheck, lint et tests unitaires sur chaque PR, plus les jobs Postgres et rootless séparés.

## Licence

Le code est publié sous [Elastic License 2.0](LICENSE) (ELv2) : chacun peut l'utiliser, le modifier, le redistribuer et s'en servir en entreprise, mais pas le proposer à des tiers comme service hébergé ou géré, ni contourner une clé de licence, ni retirer les mentions de licence. Les parties reprises d'autres projets gardent leur licence, citée dans [`packs/standard/NOTICE.md`](packs/standard/NOTICE.md).
