import { LinearApi } from '../adapters/tracker/linear/api.js';
import { TokenManager } from '../adapters/tracker/linear/oauth.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { linearSettings, saveLinearTokens } from '../config/instance.js';

/**
 * Linear for a command of the CLI (`plan`, `baseline`), on the daemon's credentials: the OAuth tokens it saved, refreshed
 * and saved back when they expire. A message for the human when Linear is not connected.
 */
export function cliLinearTracker(home: string, yml: FactoryYml | undefined): LinearTracker | string {
  const linear = linearSettings(home, yml);
  if (!linear?.accessToken || !linear.appUserId) return 'Linear not connected: run `factory up`, then connect Linear.';
  const tm = new TokenManager({
    clientId: linear.clientId,
    clientSecret: linear.clientSecret,
    load: () => ({ accessToken: linear.accessToken!, refreshToken: linear.refreshToken, expiresAt: linear.expiresAt }),
    save: (t) => saveLinearTokens(home, t),
  });
  return new LinearTracker(new LinearApi(() => tm.get()), linear.appUserId);
}
