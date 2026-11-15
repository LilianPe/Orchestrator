import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SecretSourceKind } from './types.js';

/** A credential's name, as `LoadCredentialEncrypted=<name>` gives it: one file name, never `.` or `..`. */
const CREDENTIAL_NAME = /^[A-Za-z0-9_.-]+$/;

const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * `kind: systemd-creds` (ORC-398): the credentials systemd decrypts for the daemon's service at its start, each a file of
 * `$CREDENTIALS_DIRECTORY` (`LoadCredentialEncrypted=`), held in memory, never on disk in clear. Encrypted with the host's key
 * (and its TPM when it has one), a credential copied to another machine cannot be decrypted. No network credential.
 * `store`, optional: the folder of the encrypted files (`/etc/credstore.encrypted`), whose dates are the rotations.
 */
export const systemdCredsKind: SecretSourceKind = {
  checkPath: (path) =>
    CREDENTIAL_NAME.test(path) && path !== '.' && path !== '..' ? undefined : `"${path}" is not a credential name (\`LoadCredentialEncrypted=<name>\`)`,
  checkOptions: (options) =>
    Object.entries(options).flatMap(([key, v]) => {
      if (key !== 'store') return [`${key}: unknown key`];
      return typeof v === 'string' && isAbsolute(v) ? [] : ['store: an absolute path is expected'];
    }),
  create: (options, env) => {
    const store = options['store'] as string | undefined;
    return {
      read: async (name) => {
        const dir = env['CREDENTIALS_DIRECTORY'];
        if (!dir) throw new Error(`CREDENTIALS_DIRECTORY is not set: the daemon does not run as a systemd service with LoadCredentialEncrypted=${name}`);
        let text: string;
        try {
          text = await readFile(join(dir, name), 'utf8');
        } catch (err) {
          // The cause carries a path, never a content.
          throw new Error(errnoCode(err) === 'ENOENT' ? `no credential ${name} in CREDENTIALS_DIRECTORY` : `the credential ${name} could not be read`, { cause: err });
        }
        // `echo … | systemd-creds encrypt` keeps the line break: a webhook secret must not.
        return text.replace(/\r?\n$/, '');
      },
      describe: async (name) => {
        if (!store) return {};
        for (const file of [`${name}.cred`, name]) {
          try {
            return { rotatedAt: (await stat(join(store, file))).mtime };
          } catch (err) {
            if (errnoCode(err) !== 'ENOENT') throw err;
          }
        }
        return {};
      },
    };
  },
};
