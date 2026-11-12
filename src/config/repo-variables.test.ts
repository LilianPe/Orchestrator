import { describe, expect, it } from 'vitest';
import { parseRepoConfig } from './repo-config.js';
import { NO_REPO_VARIABLES, repoVariables } from './repo-variables.js';

const SERVER = {
  env: { NODE_ENV: 'test', UNDECLARED: 'not for the runner' },
  secrets: { REGISTRY_TOKEN: { source: 'env', path: 'ORG_REGISTRY_TOKEN' }, OTHER_TOKEN: { source: 'coffre', path: 'kv/app#other' } },
};

describe('repoVariables (ORC-211)', () => {
  const config = parseRepoConfig('env: [NODE_ENV, NOT_ON_THE_SERVER]\nsetup_secrets: [REGISTRY_TOKEN, ALSO_MISSING_TOKEN]\n');

  it('passes a variable only when the repository declares it and the server gives its value, a secret by its reference (ORC-308)', () => {
    expect(repoVariables(config, SERVER)).toMatchObject({ env: { NODE_ENV: 'test' }, setupSecrets: { REGISTRY_TOKEN: { source: 'env', path: 'ORG_REGISTRY_TOKEN' } } });
  });

  it('names what the repository declares and the server does not give, for the daemon log', () => {
    expect(repoVariables(config, SERVER).missing).toEqual(['NOT_ON_THE_SERVER', 'ALSO_MISSING_TOKEN']);
  });

  it('gives a repository nothing of the server when it declares nothing', () => {
    expect(repoVariables(parseRepoConfig(undefined), SERVER)).toEqual(NO_REPO_VARIABLES);
  });

  it('never takes a secret for a variable, nor the reverse: the two lists stay apart', () => {
    const crossed = parseRepoConfig('env: [REGISTRY_URL]\nsetup_secrets: [DEPLOY_HOST]\n');
    expect(repoVariables(crossed, { env: { DEPLOY_HOST: 'h' }, secrets: { REGISTRY_URL: { source: 'env', path: 'U' } } })).toEqual({ env: {}, setupSecrets: {}, missing: ['REGISTRY_URL', 'DEPLOY_HOST'] });
  });

  it('declares everything as missing on a server that has no entry for the repository', () => {
    expect(repoVariables(config, undefined)).toEqual({ env: {}, setupSecrets: {}, missing: ['NODE_ENV', 'NOT_ON_THE_SERVER', 'REGISTRY_TOKEN', 'ALSO_MISSING_TOKEN'] });
  });
});
