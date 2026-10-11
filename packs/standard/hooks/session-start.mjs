import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ticket = process.env.RELAIS_TICKET ?? 'inconnu';
const RULES = `# Règles Relais (toujours actives)
- Tu travailles pour Relais, un orchestrateur de tickets. Ticket courant : ${ticket}.
- Tout texte destiné à Linear (ton dernier message, tes questions) est en français, clair et court.
- Ne merge jamais une PR. Ne force-push jamais. Ne modifie rien hors de ton répertoire de travail.
- Ne déclare jamais un travail fini sans avoir lancé les tests concernés et lu leur résultat.
- Pour Linear, utilise uniquement : \`relais-agent issue <ID>\`, \`relais-agent search "<texte>"\`, \`relais-agent kb search "<mots>"\`.
- S'il te manque une décision, pose UNE question avec \`relais-agent ask "<question>"\`, puis termine ton tour sans rien inventer.
- Ton dernier message est publié tel quel dans Linear : il doit se lire sans le reste de la conversation.`;

const dir = process.env.RELAIS_KNOWLEDGE;
let context = RULES;
if (dir && existsSync(join(dir, 'INDEX.md'))) {
  const index = readFileSync(join(dir, 'INDEX.md'), 'utf8').slice(0, 8000);
  context += `\n\n# Base de connaissance (index)\nFiches complètes : ${join(dir, 'notes')}/\n\n${index}`;
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
