import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parse } from 'yaml';
import { execCmd, TIMED_OUT } from '../exec.js';
import { checkCredentialFile } from './file.js';
import type { SecretSourceKind } from './types.js';

/** A key path in the decrypted document: names of letters, digits, `_`, `-` (an index for a list), joined by `.`. */
const KEY_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const DECRYPT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const absolute = (v: unknown): boolean => typeof v === 'string' && isAbsolute(v);

/** The clear document, decrypted by `sops` into JSON. Its errors carry sops's words, never its output: that is the clear document. */
async function decrypt(file: string, env: Record<string, string>): Promise<unknown> {
  let res;
  try {
    res = await execCmd('sops', ['--decrypt', '--output-type', 'json', file], { env, timeoutMs: DECRYPT_TIMEOUT_MS, maxStdout: MAX_OUTPUT_BYTES });
  } catch (err) {
    throw (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('sops is not installed (no sops in the PATH)') : new Error('sops could not be run', { cause: err });
  }
  if (res.code === TIMED_OUT) throw new Error('sops could not decrypt the file: it timed out');
  if (res.overflow) throw new Error('sops could not decrypt the file: its output is too large');
  if (res.code !== 0) {
    const said = res.stderr.trim().split('\n')[0];
    throw new Error(`sops could not decrypt the file${said ? `: ${said}` : ''}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    // A JSON parse error quotes the text it read.
    throw new Error('sops answered no JSON document');
  }
}

/** The value at `path` in the document: undefined when it holds none. */
function at(doc: unknown, path: string): unknown {
  let node = doc;
  for (const name of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, name)) return undefined;
    node = (node as Record<string, unknown>)[name];
  }
  return node;
}

/** When sops last wrote the file, from its metadata in clear: `sops.lastmodified` (YAML, JSON), `sops_lastmodified=` (dotenv), `[sops]` (INI). */
export function sopsRotation(text: string): Date | undefined {
  let stamp: unknown;
  try {
    stamp = at(parse(text), 'sops.lastmodified');
  } catch {
    // Not YAML: a dotenv file.
  }
  stamp ??= /^sops_lastmodified\s*=\s*(\S+)\s*$/m.exec(text)?.[1] ?? /^\[sops\](?:(?!^\[)[\s\S])*?^lastmodified\s*=\s*(\S+)\s*$/ms.exec(text)?.[1];
  const date = typeof stamp === 'string' ? new Date(stamp) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/**
 * `kind: sops` (ORC-418): a file encrypted by sops (with age, or a KMS), committed or deployed beside the daemon, decrypted in memory
 * by the `sops` binary at each read, never written in clear. The decryption key stays with sops: `age_key_file`, or what the daemon's
 * environment gives it (`SOPS_AGE_KEY_FILE`, its default `keys.txt`, a cloud KMS's credential).
 */
export const sopsKind: SecretSourceKind = {
  checkPath: (path) => (KEY_PATH.test(path) ? undefined : `"${path}" is not a key path of the sops file (\`section.key\`)`),
  credentialFiles: ['age_key_file'],
  checkOptions: (options) =>
    // `file` first, required: checked even when absent.
    Object.entries({ file: undefined, ...options }).flatMap(([key, v]) => {
      if (key === 'file' || key === 'age_key_file') return absolute(v) ? [] : [`${key}: an absolute path is expected`];
      return [`${key}: unknown key`];
    }),
  create: (options, env) => {
    const file = options['file'] as string;
    const keyFile = options['age_key_file'] as string | undefined;
    const sopsEnv: Record<string, string> = Object.fromEntries(Object.entries({ ...env, ...(keyFile ? { SOPS_AGE_KEY_FILE: keyFile } : {}) }).filter((e): e is [string, string] => e[1] !== undefined));
    const value = async (path: string): Promise<unknown> => {
      // The key opens every secret of the file: its owner's alone, as a `file` source's value.
      if (keyFile) await checkCredentialFile(keyFile, 'age_key_file', 0o077, 'others than its owner: chmod 600 it');
      return at(await decrypt(file, sopsEnv), path);
    };
    return {
      read: async (path) => {
        const v = await value(path);
        if (v === undefined) throw new Error(`no key ${path} in the sops file`);
        if (typeof v !== 'string') throw new Error(`the key ${path} of the sops file is not a text`);
        return v;
      },
      describe: async (path) => {
        if ((await value(path)) === undefined) return {};
        const rotatedAt = sopsRotation(await readFile(file, 'utf8'));
        return rotatedAt ? { rotatedAt } : {};
      },
    };
  },
};
