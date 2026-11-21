import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SecretSourceKind } from './types.js';

/** A file's name in its folder: letters, digits, `_`, `.`, `-`, never a dot name nor a path. */
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * `kind: file` (ORC-470): a value held in a file of `dir`, mode 0600, its owner's alone. What `factory init --dev` declares for the
 * `secrets_key` it draws on a workstation, kept apart from the `secrets.json` it encrypts. In clear on its disk: a server keeps its
 * key in a sealed source (systemd-creds). A file others can read, or a symbolic link, is refused.
 */
export const fileSecretKind: SecretSourceKind = {
  checkPath: (path) => (FILE_NAME.test(path) ? undefined : `"${path}" is not a file name of its folder`),
  checkOptions: (options) => [
    ...(typeof options['dir'] === 'string' && isAbsolute(options['dir']) ? [] : ['dir: an absolute path is expected']),
    ...Object.keys(options)
      .filter((key) => key !== 'dir')
      .map((key) => `${key}: unknown key`),
  ],
  create: (options) => {
    const dir = options['dir'] as string;
    return {
      read: async (name) => {
        const file = join(dir, name);
        let text: string;
        try {
          const st = await lstat(file);
          if (!st.isFile()) throw new Error(`the file ${name} is not a regular file`);
          // Windows has no mode bits: the folder's ACL keeps it (docs/installation.md).
          if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error(`the file ${name} is readable by others than its owner: chmod 600 it`);
          text = await readFile(file, 'utf8');
        } catch (err) {
          if (!errnoCode(err)) throw err;
          // The cause carries a path, never a content.
          throw new Error(errnoCode(err) === 'ENOENT' ? `no file ${name} in its folder` : `the file ${name} could not be read`, { cause: err });
        }
        return text.replace(/\r?\n$/, '');
      },
      describe: async (name) => {
        try {
          return { rotatedAt: (await lstat(join(dir, name))).mtime };
        } catch (err) {
          if (errnoCode(err) === 'ENOENT') return {};
          throw err;
        }
      },
    };
  },
};
