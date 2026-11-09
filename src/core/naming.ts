export function slugify(s: string, max = 40): string {
  const slug = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

/** The space of the factory's branches (ORC-353): `factory doctor` holds every pattern in it as reaching them. */
export const FACTORY_BRANCHES = 'factory/';

/** The prefix of every branch the factory makes for a ticket: what `not_started` and the duplicate search look for (ORC-207). */
export const ownBranchPrefix = (identifier: string): string => `${FACTORY_BRANCHES}${identifier.toLowerCase()}-`;

export function branchName(identifier: string, title: string): string {
  return `${ownBranchPrefix(identifier)}${slugify(title)}`;
}
