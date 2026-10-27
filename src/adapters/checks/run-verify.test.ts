import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCheckRunnerContract } from '../../../test/contracts/check-runner.contract.js';
import { runVerify } from '../../core/verify.js';

const cwd = mkdtempSync(join(tmpdir(), 'factory-checks-'));
const log = join(cwd, 'runs.log');

describeCheckRunnerContract('runVerify', () => ({
  checks: { run: runVerify },
  cwd,
  pass: 'true',
  fails: [
    { command: 'echo "1 test failed"; exit 1', exitCode: 1, output: '1 test failed' },
    { command: 'echo "lint: 2 errors" >&2; exit 2', exitCode: 2, output: 'lint: 2 errors' },
  ],
  slow: 'sleep 5',
  unstartableCwd: join(cwd, 'no-such-dir'),
  counted: {
    command: `echo run >> '${log}'`,
    runs: async () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0),
  },
}));
