import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { SecretSourceKind } from './types.js';

/** A segment of a secret's path or of a mount: letters, digits, spaces, `_`, `.`, `-`, never `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9 _.-]+$/;
const FIELD = /^[A-Za-z0-9_.-]+$/;
const REQUEST_TIMEOUT_MS = 10_000;

const segments = (path: string): string[] | undefined => {
  const parts = path.split('/');
  return parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..') ? parts : undefined;
};

/** `<path>#<field>`, or undefined when `ref` is not one. */
function split(ref: string): { path: string; field: string } | undefined {
  const hash = ref.indexOf('#');
  if (hash < 0) return undefined;
  const path = ref.slice(0, hash);
  const field = ref.slice(hash + 1);
  return segments(path) && FIELD.test(field) ? { path, field } : undefined;
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
  if (url.protocol === 'https:') return undefined;
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  return url.protocol === 'http:' && loopback ? undefined : fault;
}

const KNOWN = new Set(['address', 'token', 'token_file', 'mount', 'namespace']);

/**
 * `kind: vault` (ORC-418): a field of a secret of HashiCorp Vault's KV v2 engine (`GET /v1/<mount>/data/<path>`), read at each `read`
 * with a token: `token` (written `env:NAME`, resolved at the start and masked), or `token_file`, re-read at each read, where a Vault
 * Agent keeps a renewed one. The rotation date is the creation of the secret's current version.
 */
export const vaultKind: SecretSourceKind = {
  checkPath: (path) => (split(path) ? undefined : `"${path}" is not \`<path>#<field>\` of a Vault secret`),
  checkOptions: (options) => {
    const faults: string[] = [];
    const address = addressFault(options['address']);
    if (address) faults.push(address);
    const { token, token_file: tokenFile, mount, namespace } = options;
    if (token !== undefined && tokenFile !== undefined) faults.push('token: token or token_file, not both');
    else if (tokenFile !== undefined) {
      if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile)) faults.push('token_file: an absolute path is expected');
    } else if (typeof token !== 'string' || token === '') faults.push(token === undefined ? 'token: required, or token_file' : 'token: a non-empty text is expected');
    if (mount !== undefined && (typeof mount !== 'string' || !segments(mount))) faults.push('mount: a mount path is expected (`secret`, `team/kv`)');
    if (namespace !== undefined && (typeof namespace !== 'string' || namespace === '')) faults.push('namespace: a non-empty text is expected');
    faults.push(...Object.keys(options).filter((key) => !KNOWN.has(key)).map((key) => `${key}: unknown key`));
    return faults;
  },
  create: (options) => {
    const address = (options['address'] as string).replace(/\/+$/, '');
    const mount = (options['mount'] as string | undefined) ?? 'secret';
    const namespace = options['namespace'] as string | undefined;
    const tokenFile = options['token_file'] as string | undefined;
    const token = async (): Promise<string> => {
      if (!tokenFile) return options['token'] as string;
      try {
        return (await readFile(tokenFile, 'utf8')).trim();
      } catch (err) {
        // The cause carries a path, never a content.
        throw new Error('the Vault token_file could not be read', { cause: err });
      }
    };
    /** The fields of the secret's current version, and its date: undefined when Vault holds no such secret. */
    const fetchSecret = async (path: string): Promise<{ data: Record<string, unknown>; created?: string } | undefined> => {
      const url = `${address}/v1/${mount}/data/${path}`;
      const headers: Record<string, string> = { 'X-Vault-Token': await token() };
      if (namespace) headers['X-Vault-Namespace'] = namespace;
      let res: Response;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        throw new Error(`Vault is unreachable at ${address}`, { cause: err });
      }
      if (res.status === 404) return undefined;
      if (res.status === 403) throw new Error('Vault refused the token (403): invalid, expired, or its policy does not grant this path');
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
