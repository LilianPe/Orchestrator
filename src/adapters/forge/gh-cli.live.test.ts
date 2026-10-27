import { describe } from 'vitest';
import { describeForgeContract } from '../../../test/contracts/forge.contract.js';
import { execCmd, type Exec } from '../exec.js';
import { GhCliForge } from './gh-cli.js';

const repoPath = process.env['FACTORY_LIVE_GH_REPO'];
const branch = process.env['FACTORY_LIVE_GH_BRANCH'];
const pr = Number(process.env['FACTORY_LIVE_GH_PR']);
// GitHub out of reach: gh goes through a proxy on a closed local port.
const offline: Exec = (cmd, args, opts) => execCmd(cmd, args, { ...opts, env: { ...opts?.env, HTTPS_PROXY: 'http://127.0.0.1:9' } });

// Reads only: findPr and unresolvedReviewComments never write to GitHub.
describe.skipIf(!repoPath || !branch || !Number.isInteger(pr))('GhCliForge against GitHub', () => {
  describeForgeContract('GhCliForge (live)', () => ({
    forge: new GhCliForge(),
    repoPath: repoPath!,
    missingBranch: 'factory/contract-no-such-branch',
    pr: { branch: branch!, number: pr },
    unreachable: new GhCliForge(offline),
  }));
});
