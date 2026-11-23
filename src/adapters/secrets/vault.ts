import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { checkCredentialFile } from './file.js';
import type { SecretSourceKind } from './types.js';

/** A segment of a secret's path or of a mount: letters, digits, spaces, `_`, `.`, `-`, never `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9 _.-]+$/;
const FIELD = /^[A-Za-z0-9_.-]+$/;
const REQUEST_TIMEOUT_MS = 10_000;
/** What a header value holds; fetch quotes any other value in its error, the token with it. */
const TOKEN = /^[\x21-\x7e]+$/;

const encoded = (path: string): string => path.split('/').map(encodeURIComponent).join('/');
const validPath = (path: string): boolean => path.split('/').every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');

/** `<path>#<field>`, or undefined when `ref` is not one. */
function split(ref: string): { path: string; field: string } | undefined {
  const hash = ref.indexOf('#');
  if (hash < 0) return undefined;
  const path = ref.slice(0, hash);
  const field = ref.slice(hash + 1);
  return validPath(path) && FIELD.test(field) ? { path, field } : undefined;
}

/** https, or http on the loopback, where the token never crosses a network. */
function addressFault(v: unknown): string | undefined {
  const fault = 'address: an https URL is expected (http on the loopback only)';
  if (typeof v !== 'string') return fault;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return fault;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return 'address: the server alone is expected (`https://<host>:<port>`), no path, query or credentials';
  }
  if (url.protocol === 'https:') return undefined;
  // URL lowercases the host and keeps IPv6 in brackets. An address, never a name: `localhost` is resolved, by DNS when a hosts file lacks it.
  const loopback = url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  return url.protocol === 'http:' && loopback ? undefined : fault;
}

const KNOWN = new Set(['address', 'token', 'token_file', 'mount', 'namespace']);

/**
 * `kind: vault` (ORC-418): a field of a secret of HashiCorp Vault's KV v2 engine (`GET /v1/<mount>/data/<path>`), read at each `read`
 * with a token: `token` (written `env:NAME`, resolved at the start and masked, refused in clear), or `token_file`, re-read at each read, where a Vault
 * Agent keeps a renewed one. The rotation date is the creation of the secret's current version.
 */
export const vaultKind: SecretSourceKind = {
  checkPath: (path) => (split(path) ? undefined : `"${path}" is not \`<path>#<field>\` of a Vault secret`),
  credentialOptions: ['token'],
  credentialFiles: ['token_file'],
  checkOptions: (options) => {
    const faults: string[] = [];
    const address = addressFault(options['address']);
    if (address) faults.push(address);
    const { token, token_file: tokenFile, mount, namespace } = options;
    if (token !== undefined && tokenFile !== undefined) faults.push('token: token or token_file, not both');
    else if (tokenFile !== undefined && (typeof tokenFile !== 'string' || !isAbsolute(tokenFile))) faults.push('token_file: an absolute path is expected');
    else if (tokenFile === undefined && token === undefined) faults.push('token: required, or token_file');
    else if (tokenFile === undefined && (typeof token !== 'string' || token === '')) faults.push('token: a non-empty text is expected');
    if (mount !== undefined && (typeof mount !== 'string' || !validPath(mount))) faults.push('mount: a mount path is expected (`secret`, `team/kv`)');
    if (namespace !== undefined && (typeof namespace !== 'string' || namespace === '')) faults.push('namespace: a non-empty text is expected');
    faults.push(...Object.keys(options).filter((key) => !KNOWN.has(key)).map((key) => `${key}: unknown key`));
    return faults;
  },
  create: (options) => {
    // The URL checked, not its text: a lone `?` or `#` left at its end would swallow the path.
    const address = new URL(options['address'] as string).origin;
    const mount = (options['mount'] as string | undefined) ?? 'secret';
    const namespace = options['namespace'] as string | undefined;
    const tokenFile = options['token_file'] as string | undefined;
    const token = async (): Promise<string> => {
      let value = options['token'] as string;
      if (tokenFile) {
        // A Vault Agent's sink is 0640 by default: its group may read it, as the daemon does when it is of that group.
        await checkCredentialFile(tokenFile, 'token_file', 0o007, 'any user: chmod 600 it (640 for a Vault Agent of its group)');
        try {
          value = (await readFile(tokenFile, 'utf8')).trim();
        } catch (err) {
          // The cause carries a path, never a content.
          throw new Error('the Vault token_file could not be read', { cause: err });
        }
        if (!value) throw new Error('the Vault token_file is empty');
      }
      if (!TOKEN.test(value)) throw new Error('the Vault token is not a valid header value (printable characters, no space)');
      return value;
    };
    /** The fields of the secret's current version, and its date: undefined when Vault holds no such secret. */
    const fetchSecret = async (path: string): Promise<{ data: Record<string, unknown>; created?: string } | undefined> => {
      // Each segment encoded: the URL parser would drop a space ending the path, and with it turn `.. ` into a dot segment.
      const url = `${address}/v1/${encoded(mount)}/data/${encoded(path)}`;
      const headers: Record<string, string> = { 'X-Vault-Token': await token() };
      if (namespace) headers['X-Vault-Namespace'] = namespace;
      let res: Response;
      try {
        // A redirect would carry the token to wherever it points.
        res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        throw new Error(`Vault is unreachable at ${address}`, { cause: err });
      }
      if (res.status === 404) return undefined;
      if (res.status === 403) throw new Error('Vault refused the token (403): invalid, expired, or its policy does not grant this path');
      if (res.status >= 300 && res.status < 400) throw new Error(`Vault answered ${res.status}: a redirect is not followed`);
      if (!res.ok) throw new Error(`Vault answered ${res.status}`);
      let body: { data?: { data?: unknown; metadata?: { created_time?: unknown } } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // A JSON parse error quotes the text it read.
        throw new Error('Vault answered no JSON document');
      }
      const data = body?.data?.data;
      if (!data || typeof data !== 'object') return undefined;
      const created = body.data?.metadata?.created_time;
      return { data: data as Record<string, unknown>, ...(typeof created === 'string' ? { created } : {}) };
    };
    return {
      read: async (ref) => {
        const { path, field } = split(ref)!;
        const secret = await fetchSecret(path);
        if (!secret) throw new Error(`no secret ${path} in Vault (${mount})`);
        if (!Object.hasOwn(secret.data, field)) throw new Error(`no field ${field} in the Vault secret ${path}`);
        const value = secret.data[field];
        if (typeof value !== 'string') throw new Error(`the field ${field} of the Vault secret ${path} is not a text`);
        return value;
      },
      describe: async (ref) => {
        const { path, field } = split(ref)!;
        const secret = await fetchSecret(path);
        if (!secret || !Object.hasOwn(secret.data, field) || !secret.created) return {};
        const rotatedAt = new Date(secret.created);
        return Number.isNaN(rotatedAt.getTime()) ? {} : { rotatedAt };
      },
    };
  },
};
