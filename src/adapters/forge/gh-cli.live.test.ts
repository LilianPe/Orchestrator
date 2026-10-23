import { describe } from 'vitest';
import { describeForgeContract } from '../../../test/contracts/forge.contract.js';
import { GhCliForge } from './gh-cli.js';

const repoPath = process.env['FACTORY_LIVE_GH_REPO'];
const branch = process.env['FACTORY_LIVE_GH_BRANCH'];
const pr = Number(process.env['FACTORY_LIVE_GH_PR']);

// Reads only: findPr and unresolvedReviewComments never write to GitHub.
describe.skipIf(!repoPath || !branch || !Number.isInteger(pr))('GhCliForge against GitHub', () => {
  describeForgeContract('GhCliForge (live)', () => ({
    forge: new GhCliForge(),
    repoPath: repoPath!,
    missingBranch: 'factory/contract-no-such-branch',
    pr: { branch: branch!, number: pr },
  }));
});
