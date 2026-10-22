import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCheckRunnerContract } from '../../../test/contracts/check-runner.contract.js';
import { runVerify } from '../../core/verify.js';

describeCheckRunnerContract('runVerify', () => ({
  checks: { run: runVerify },
  cwd: mkdtempSync(join(tmpdir(), 'factory-checks-')),
  pass: 'true',
  fails: [
    { command: 'echo "1 test failed"; exit 1', exitCode: 1, output: '1 test failed' },
    { command: 'echo "lint: 2 errors" >&2; exit 2', exitCode: 2, output: 'lint: 2 errors' },
  ],
  slow: 'sleep 5',
}));
