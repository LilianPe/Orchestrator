/** Name shown to humans, wherever the code writes one (consumers: docs/transition.md, « Display name »); the only place to change it. */
export const PRODUCT_NAME = 'Orchestrator';

/** The git identity of what the factory commits itself, and of an agent's commits (ORC-479): no operator's, no address that receives mail. */
export const FACTORY_GIT_IDENTITY = { 'user.name': `${PRODUCT_NAME} factory`, 'user.email': 'factory@factory.invalid' } as const;
