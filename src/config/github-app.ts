import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstanceConfig } from './instance.js';

export interface GithubAppSettings {
  appId: string;
  /** PEM content, never a path. */
  privateKey: string;
  /** The pinned installation (`github.installation_id`), a positive integer (ORC-490). */
  installationId?: number;
}

const PEM_HEADER = '-----BEGIN';
const PEM_FOOTER = 'PRIVATE KEY-----';

function expandPem(value: string): string {
  const trimmed = value.trim();
  // Env vars often carry a PEM on one line, with literal \n sequences.
  if (trimmed.includes(PEM_HEADER) && !trimmed.includes('\n')) return trimmed.replace(/\\n/g, '\n');
  return trimmed;
}

/**
 * Accepts either a PEM inline or a path to a PEM file (github.private_key or GH_APP_KEY).
 * Reads the file only when needed so the reference may hold a path instead of a secret.
 */
export function readPrivateKey(
  value: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  const raw = value.trim();
  if (!raw) throw new Error('GitHub App configuration: empty private key');
  const expanded = expandPem(raw);
  const pem = expanded.includes(PEM_HEADER) ? expanded : readFile(expandHome(expanded));
  if (!pem.includes(PEM_HEADER) || !pem.includes(PEM_FOOTER)) {
    throw new Error('GitHub App configuration: the private key must be an RSA PEM (content or file path)');
  }
  return pem.endsWith('\n') ? pem : `${pem}\n`;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(1)) : path;
}

/**
 * Builds the GitHub App settings from factory.yml, with GH_APP_* env vars as fallback.
 * Returns undefined when no GitHub App is configured: the daemon then reads and publishes nothing on GitHub (ORC-181).
 * A partial configuration is an error rather than a silent start without the App.
 */
export function resolveGithubApp(config: InstanceConfig, env: NodeJS.ProcessEnv = process.env): GithubAppSettings | undefined {
  const fromConfig = config.github;
  const appId = (fromConfig?.appId ?? env['GH_APP_ID'] ?? '').trim();
  const key = (fromConfig?.privateKey ?? env['GH_APP_KEY'] ?? '').trim();
  if (!appId && !key) return undefined;
  if (!appId || !key) {
    throw new Error(
      'Incomplete GitHub App configuration: set github.app_id and github.private_key in factory.yml (or GH_APP_ID and GH_APP_KEY), ' +
        'or remove the github section to start without the App (nothing is then read or published on GitHub).',
    );
  }
  // The source read, the one a refusal names: factory.yml's key hides the variable.
  const installationId =
    fromConfig?.installationId !== undefined
      ? installationNumber('github.installation_id', fromConfig.installationId)
      : installationNumber('GH_APP_INSTALLATION_ID', env['GH_APP_INSTALLATION_ID']);
  return {
    appId,
    privateKey: readPrivateKey(key),
    ...(installationId ? { installationId } : {}),
  };
}

/**
 * The pinned installation as the number GitHub gives it (ORC-490), refused unless it is a positive integer: the daemon
 * would otherwise start and ask its tokens of an installation that cannot exist. A leading zero is read in decimal, as YAML
 * reads an unquoted `042`. Undefined when blank: nothing is pinned.
 */
function installationNumber(source: string, value: string | undefined): number | undefined {
  const written = (value ?? '').trim();
  if (!written) return undefined;
  const id = Number(written);
  if (/^\d+$/.test(written) && id > 0 && Number.isSafeInteger(id)) return id;
  throw new Error(
    `${source}: "${written}" is not an installation id. ` +
      "Write the positive integer GitHub shows at the end of the installation's URL (…/settings/installations/<id>), as in `installation_id: 987654`, " +
      "or remove it to let the daemon find each repository's installation.",
  );
}

/**
 * The App's OAuth client (ORC-399), for the dashboard's GitHub sign-in: `github.clientId` and `github.clientSecret` of
 * factory.yml, else `GH_APP_CLIENT_ID` and `GH_APP_CLIENT_SECRET`. Undefined when neither is set; one
 * without the other is an error.
 */
export function githubOAuthClient(config: InstanceConfig, env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } | undefined {
  const clientId = config.github?.clientId?.trim() || env['GH_APP_CLIENT_ID']?.trim() || '';
  const clientSecret = config.github?.clientSecret?.trim() || env['GH_APP_CLIENT_SECRET']?.trim() || '';
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error("Incomplete GitHub sign-in: set the App's client id and its client secret (github.client_id and github.client_secret, or GH_APP_CLIENT_ID and GH_APP_CLIENT_SECRET).");
  }
  return { clientId, clientSecret };
}

/**
 * Secret of the GitHub webhooks (ORC-134): `github.webhook_secret` of factory.yml, else the
 * `GH_WEBHOOK_SECRET` env var. Empty when neither is set: every GitHub webhook is then refused.
 */
export function githubWebhookSecret(config: InstanceConfig, env: NodeJS.ProcessEnv = process.env): string {
  return config.github?.webhookSecret?.trim() || env['GH_WEBHOOK_SECRET']?.trim() || '';
}
