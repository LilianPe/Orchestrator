/**
 * Writes the recorded journals the CI replays (ORC-174): `npm run replay:record`.
 *
 * Run it only on purpose: once a change of the engine or of the preset is meant to change a
 * decision, the replay of the old journals fails, and recording them again accepts the new decisions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { record, recordedFiles, SCENARIOS } from './scenarios.js';

const dir = join(import.meta.dirname, 'journals');
mkdirSync(dir, { recursive: true });
for (const name of Object.keys(SCENARIOS)) {
  for (const { file, text } of recordedFiles(name, await record(name))) {
    writeFileSync(join(dir, file), text);
    console.log(`test/replay/journals/${file}`);
  }
}
