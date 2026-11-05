import { PRODUCT_NAME } from '../product.js';

/** Why a ticket waits for a human, in the order the Flux shows the causes (ORC-297). */
export const BLOCK_CAUSES = ['question', 'contested', 'red', 'infra', 'limit', 'loop', 'failed', 'pickup', 'dead_letter', 'pr_closed', 'stopped', 'other'] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];

/**
 * Each anchored on the head of a reason, which the factory writes: what follows may quote an error or
 * a job name. A block's cause lives in its reason alone, the projection has no field for it: a new
 * one would change what the replay compares (ORC-174).
 */
const CAUSES: readonly (readonly [Exclude<BlockCause, 'other'>, RegExp])[] = [
  ['question', /^(Question posée par l'agent|En attente d'une réponse à la question de l'agent)/],
  ['contested', /^L'agent conteste le ticket/],
  ['red', /^Rouge non vérifié après /],
  ['infra', /^Le run .+ s'est interrompu : panne d'infrastructure/],
  ['infra', /^Le contrôle du rouge de .+ n'a pas pu tourner : panne d'infrastructure/],
  ['infra', /^La vérification de .+ n'a pas pu tourner : panne d'infrastructure/],
  ['infra', /^Erreur au lancement : /],
  ['infra', /^Erreur : /],
  ['infra', new RegExp(`^${PRODUCT_NAME} a redémarré pendant `)],
  ['infra', /^Le bail du run .+ a expiré \d+ fois : /],
  ['limit', /^Le run .+ a atteint un plafond/],
  ['limit', /^Trop de relances après coupure : /],
  ['limit', /^(Vérifications|CI) toujours en échec après /],
  ['failed', /^Vérifications en échec après /],
  ['loop', /^Boucle : /],
  ['failed', /^Le run .+ a échoué\.$/],
  ['pickup', /^La description (fait moins de|ne contient pas de)/],
  ['pickup', /^Une branche .+ existe déjà sur origin\./],
  ['pickup', /^Aucun dépôt connu pour l'équipe Linear /],
  ['pickup', /^Dépôt à préciser : /],
  ['dead_letter', /^Événement .+ mis de côté /],
  ['pr_closed', /^PR #\d+ fermée sans merge$/],
  ['stopped', /^Arrêté à la demande$/],
];

/** The cause of a block, read from its reason; `other` when no cause is known for it, never a guess. */
export function blockCause(reason: string | undefined): BlockCause {
  if (reason === undefined) return 'other';
  return CAUSES.find(([, head]) => head.test(reason))?.[0] ?? 'other';
}
