import type { SecretSourceKind } from './types.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `env:NAME` (ORC-211, ORC-308): the daemon's environment, read at each `setup`. Built in, never declared. */
export const envSecretKind: SecretSourceKind = {
  checkPath: (path) => (ENV_NAME.test(path) ? undefined : `"${path}" does not name a variable (\`env:NAME\`)`),
  checkOptions: (options) => Object.keys(options).map((key) => `${key}: unknown key`),
  create: (_options, env) => ({
    read: async (name) => {
      const value = env[name];
      if (value === undefined || value === '') throw new Error(`the environment variable ${name} is not set`);
      return value;
    },
  }),
};
