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

export function branchName(identifier: string, title: string): string {
  return `factory/${identifier.toLowerCase()}-${slugify(title)}`;
}
