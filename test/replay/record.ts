/**
 * Writes the recorded journals the CI replays (ORC-174): `npm run replay:record`.
 *
 * Run it only on purpose: once a change of the engine or of the preset is meant to change a
 * decision, the replay of the old journals fails, and recording them again accepts the new decisions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asVersion1, record, SCENARIOS } from './scenarios.js';

const dir = join(import.meta.dirname, 'journals');
mkdirSync(dir, { recursive: true });
const write = (name: string, journal: unknown) => {
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(journal, null, 2)}\n`);
  console.log(`test/replay/journals/${name}.json`);
};
for (const name of Object.keys(SCENARIOS)) {
  const journal = await record(name);
  write(name, journal);
  if (name === 'review-merge-done') write(`${name}.v1`, asVersion1(journal));
}
