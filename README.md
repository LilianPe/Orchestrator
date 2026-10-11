# Relais

Orchestrateur d'agents de code : un ticket Linear délégué à l'agent devient une PR, relue par un humain puis par une boucle de review IA, prête à merger. Prototype privé.

## Démarrage
```bash
npm ci && npm run build && npm link
cd <votre dépôt> && relais init
relais up            # http://localhost:4100, puis « Connecter Linear »
```
Sans tokens, pour tester l'interface : `relais up --fake-runner`.

## Documents
- Recette : `docs/recette.md`

## Développement
`npm test` · `npm run typecheck` · `npm run lint` · `npm run dev:web` (UI avec proxy vers :4100)
