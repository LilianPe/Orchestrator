import type { DashboardAccess } from '../adapters/forge/github-login.js';
import { PRODUCT_NAME } from '../product.js';
import { oldDatabaseWarnings } from '../store/open.js';
import type { FactoryYml } from './factory-yml.js';
import { githubOAuthClient } from './github-app.js';
import { isLoopbackHost, relayWarnings, type InstanceConfig } from './instance.js';
import { SECRETS_KEY_REQUIRED } from './server-secrets.js';

/** What the start goes on with once `startRefusals` let it. */
export interface StartChecks {
  warnings: string[];
  oauthClient?: { clientId: string; clientSecret: string };
  signIn?: { client: { clientId: string; clientSecret: string }; access: DashboardAccess; publicUrl: string };
}

/**
 * The refusals of the daemon's start that config.yaml and factory.yml decide before anything opens, for the start and
 * `factory doctor` alike (ORC-448): the first one throws, with the message the start gives; its warnings are returned: the
 * Smee relay's (ORC-446), and a SQLite file left in `home` from before Postgres, named, never opened (ORC-178, ORC-463). The App's OAuth client whole (ORC-399); off the loopback, the dashboard's GitHub sign-in (that client,
 * who may sign in, an HTTPS publicUrl GitHub calls back to) and `secrets_key`, which encrypts secrets.json at rest (ORC-398).
 * `signIn`: what the dashboard's sign-in is built from, off the loopback alone.
 */
export function startRefusals(home: string, instance: InstanceConfig, yml: FactoryYml | undefined, env: NodeJS.ProcessEnv): StartChecks {
  const client = githubOAuthClient(instance, env);
  let signIn: StartChecks['signIn'];
  if (!isLoopbackHost(instance.host)) {
    const exposed = `host: ${instance.host} exposes the interface and the API of ${PRODUCT_NAME} outside this machine, behind a GitHub sign-in through the factory's App`;
    if (!client) {
      throw new Error(`${exposed}: set the App's OAuth client (github.client_id and github.client_secret in factory.yml, or GH_APP_CLIENT_ID and GH_APP_CLIENT_SECRET), or set host: 127.0.0.1 back in config.yaml.`);
    }
    if (!yml?.dashboard) throw new Error(`${exposed}: name who may sign in, dashboard: { logins, org, team } in factory.yml.`);
    if (!instance.publicUrl?.startsWith('https://')) throw new Error(`${exposed}: set publicUrl to its https:// address, where GitHub calls the sign-in back and the session cookie is sent.`);
    // Its reference counts too: doctor reads no secret but the App's, a key of another source than env stays unread there. At the
    // start, a reference is a value read, or the start already stopped.
    if (!yml.secretsKey && !yml.secretRefs?.['secrets_key']) throw new Error(`host: ${instance.host} exposes ${PRODUCT_NAME} outside this machine: ${SECRETS_KEY_REQUIRED}.`);
    signIn = { client, access: yml.dashboard, publicUrl: instance.publicUrl };
  }
  return { warnings: [...relayWarnings(instance), ...oldDatabaseWarnings(home)], ...(client ? { oauthClient: client } : {}), ...(signIn ? { signIn } : {}) };
}
