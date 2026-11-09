/**
 * Writes the baseline the golden replay compares with (ORC-236): `npm run golden:record`.
 *
 * Run it only on purpose: once a change of prompt, skill or preset is meant to change what the golden tickets
 * receive or end on, the replay lists them, and recording again accepts the new report. Review its diff in the PR.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGoldenSet } from '../../src/golden/golden-set.js';
import { replayGoldenSet } from '../../src/golden/replay.js';
import { fakeGoldenPass } from './fake-pass.js';

const report = await replayGoldenSet(loadGoldenSet(), fakeGoldenPass());
writeFileSync(join(import.meta.dirname, 'baseline.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('test/golden/baseline.json');
