import { existsSync } from 'node:fs';
import type { DashboardAccess } from '../adapters/forge/github-login.js';
import { PRODUCT_NAME } from '../product.js';
import { oldDatabaseWarnings } from '../store/old-databases.js';
import type { FactoryYml } from './factory-yml.js';
import { githubOAuthClient } from './github-app.js';
import { isLoopbackHost, oldInstanceFileWarnings, homePaths, relayWarnings, type InstanceConfig } from './instance.js';
import { LINEAR_NEEDS_SECRETS_KEY, SECRETS_KEY_REQUIRED } from './secrets-file.js';

/** What the start goes on with once `startRefusals` let it. */
export interface StartChecks {
  warnings: string[];
  oauthClient?: { clientId: string; clientSecret: string };
  signIn?: { client: { clientId: string; clientSecret: string }; access: DashboardAccess; publicUrl: string };
}

/** Why the daemon does not start without its factory.yml (ORC-199): `config.yaml` is never read in its place. */
const NO_FACTORY_YML = 'no factory.yml in FACTORY_HOME: the daemon reads its configuration there alone, never config.yaml (ORC-199). Run factory init, or write it (docs/configuration.md).';

/**
 * The refusals of the daemon's start that factory.yml decides before anything opens, for the start and
 * `factory doctor` alike (ORC-448): the first one throws, with the message the start gives. The file itself (ORC-199); the App's OAuth client whole
 * (ORC-399); off the loopback, the dashboard's GitHub sign-in (that client, who may sign in, an HTTPS publicUrl GitHub calls
 * back to) and `secrets_key`, which encrypts secrets.json at rest (ORC-398); on the loopback too, `secrets_key` as soon as Linear is
 * there, a `linear` section or a secrets.json (ORC-470).
 * `warnings`: the Smee relay's (ORC-446), each SQLite file left in `home` from before Postgres (ORC-178, ORC-463) and each file of
 * the instance from before factory.yml (ORC-199), looked at by their presence alone, never opened.
 * `signIn`: what the dashboard's sign-in is built from, off the loopback alone.
 */
export function startRefusals(home: string, instance: InstanceConfig, yml: FactoryYml | undefined, env: NodeJS.ProcessEnv): StartChecks {
  if (!yml) throw new Error(NO_FACTORY_YML);
  const client = githubOAuthClient(instance, env);
  let signIn: StartChecks['signIn'];
  // Its reference counts too: doctor reads no secret but the App's, a key of another source than env stays unread there. At the
  // start, a reference is a value read, or the start already stopped.
  const keyed = !!yml.secretsKey || !!yml.secretRefs?.['secrets_key'];
  if (!isLoopbackHost(instance.host)) {
    const exposed = `host: ${instance.host} exposes the interface and the API of ${PRODUCT_NAME} outside this machine, behind a GitHub sign-in through the factory's App`;
    if (!client) {
      throw new Error(`${exposed}: set the App's OAuth client (github.client_id and github.client_secret in factory.yml, or GH_APP_CLIENT_ID and GH_APP_CLIENT_SECRET), or set host: 127.0.0.1 back in factory.yml.`);
    }
    if (!yml.dashboard) throw new Error(`${exposed}: name who may sign in, dashboard: { logins, org, team } in factory.yml.`);
    if (!instance.publicUrl?.startsWith('https://')) throw new Error(`${exposed}: set public_url to its https:// address, where GitHub calls the sign-in back and the session cookie is sent.`);
    if (!keyed) throw new Error(`host: ${instance.host} exposes ${PRODUCT_NAME} outside this machine: ${SECRETS_KEY_REQUIRED}.`);
    signIn = { client, access: yml.dashboard, publicUrl: instance.publicUrl };
  }
  // Only its presence: a sealed file is not opened here.
  if (!keyed && (yml.linear || existsSync(homePaths(home).secrets))) throw new Error(`${LINEAR_NEEDS_SECRETS_KEY}.`);
  return { warnings: [...relayWarnings(instance), ...oldDatabaseWarnings(home), ...oldInstanceFileWarnings(home)], ...(client ? { oauthClient: client } : {}), ...(signIn ? { signIn } : {}) };
}
