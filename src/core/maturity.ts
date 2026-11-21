/** The maturity card the dry run on the default branch fills (ORC-410, ORC-437). */
export const MAIN_CARD = 'main';

/** The `main` card's value while the project has no dry run on its default branch: not approvable (ORC-437). */
export const MAIN_UNCHECKED = 'not checked yet: the dry run (ORC-408) runs setup, build and tests on main';

/** Whether a card is the `main` card not checked yet (ORC-437): the store and the page refuse to approve it. */
export const uncheckedMain = (c: { key: string; value: string }): boolean => c.key === MAIN_CARD && c.value === MAIN_UNCHECKED;
