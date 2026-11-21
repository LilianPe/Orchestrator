import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstanceConfig } from './instance.js';

export interface GithubAppSettings {
  appId: string;
  /** PEM content, never a path. */
  privateKey: string;
  installationId?: string;
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
  const installationId = (fromConfig?.installationId ?? env['GH_APP_INSTALLATION_ID'] ?? '').trim() || undefined;
  return {
    appId,
    privateKey: readPrivateKey(key),
    ...(installationId ? { installationId } : {}),
  };
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
