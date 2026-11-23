import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parse } from 'yaml';
import type { SecretSourceKind } from './types.js';

/** A key path in the decrypted document: names of letters, digits, `_`, `-` (an index for a list), joined by `.`. */
const KEY_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const DECRYPT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const absolute = (v: unknown): boolean => typeof v === 'string' && isAbsolute(v);

/** The clear document, decrypted by `sops` into JSON. Its errors carry sops's words, never its output: that is the clear document. */
function decrypt(file: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('sops', ['--decrypt', '--output-type', 'json', file], { env, timeout: DECRYPT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return reject(new Error('sops is not installed (no sops in the PATH)'));
        const said = String(stderr).trim().split('\n')[0];
        return reject(new Error(`sops could not decrypt the file${said ? `: ${said}` : err.killed ? ': it timed out' : ''}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        // A JSON parse error quotes the text it read.
        reject(new Error('sops answered no JSON document'));
      }
    });
  });
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

/** When sops last wrote the file, from its metadata in clear: `sops.lastmodified` (YAML, JSON), `sops_lastmodified=` (dotenv, INI). */
export function sopsRotation(text: string): Date | undefined {
  let stamp: unknown;
  try {
    stamp = at(parse(text), 'sops.lastmodified');
  } catch {
    // Not YAML: a dotenv file.
  }
  stamp ??= /^sops_lastmodified\s*=\s*(\S+)\s*$/m.exec(text)?.[1];
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
  checkOptions: (options) =>
    Object.entries({ file: undefined, ...options }).flatMap(([key, v]) => {
      if (key === 'file') return absolute(v) ? [] : ['file: an absolute path is expected'];
      if (key === 'age_key_file') return absolute(v) ? [] : ['age_key_file: an absolute path is expected'];
      return [`${key}: unknown key`];
    }),
  create: (options, env) => {
    const file = options['file'] as string;
    const keyFile = options['age_key_file'] as string | undefined;
    const sopsEnv = keyFile ? { ...env, SOPS_AGE_KEY_FILE: keyFile } : env;
    const value = async (path: string): Promise<unknown> => at(await decrypt(file, sopsEnv), path);
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
