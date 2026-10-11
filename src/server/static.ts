import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export function readStatic(webDir: string, urlPath: string): { body: Buffer; type: string } | undefined {
  const root = normalize(webDir + sep);
  let file = normalize(join(webDir, decodeURIComponent(urlPath)));
  if (!file.startsWith(root) && file !== normalize(webDir)) return undefined;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, 'index.html');
  if (!existsSync(file)) return undefined;
  return { body: readFileSync(file), type: TYPES[extname(file)] ?? 'application/octet-stream' };
}
