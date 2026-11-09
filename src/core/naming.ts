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

/** The prefix of every branch the factory makes for a ticket: what `not_started` and the duplicate search look for (ORC-207). */
export const ownBranchPrefix = (identifier: string): string => `factory/${identifier.toLowerCase()}-`;

export function branchName(identifier: string, title: string): string {
  return `${ownBranchPrefix(identifier)}${slugify(title)}`;
}
