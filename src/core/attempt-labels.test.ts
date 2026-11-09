import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { buildRunSettings, posixPath, runSettingsTemplate, type Settings } from '../config/run-settings.js';
import { VERSION } from '../version.js';
import { buildPrompt, type PromptInput } from './prompt.js';
import {
  attemptLabels,
  configFingerprint,
  packFingerprints,
  pendingLabels,
  promptTemplate,
  skillsFingerprint,
  stableJson,
  workflowFingerprint,
  type PackFingerprints,
} from './attempt-labels.js';

const packDir = join(import.meta.dirname, '../../packs/standard');
const settingsPath = join(packDir, 'settings.json');
const SHA = /^sha256:[0-9a-f]{64}$/;

/** A dev prompt's input for a ticket. */
const promptFor = (identifier: string, title = 'Export CSV') => ({
  skill: 'factory:dev',
  issue: { identifier, title, description: `Description de ${identifier}`, url: `https://linear.app/t/${identifier}` },
  branch: `factory/${identifier.toLowerCase()}`,
});
const P = promptFor('REL-1');
/** The label input of a prompt: the prompt text and what it was built from. */
const prompted = (input: PromptInput) => ({ prompt: buildPrompt(input), promptInput: input });

const temps: string[] = [];
function tempPack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'labels-'));
  temps.push(dir);
  cpSync(join(packDir, 'skills'), join(dir, 'skills'), { recursive: true });
  cpSync(join(packDir, 'hooks'), join(dir, 'hooks'), { recursive: true });
  cpSync(join(packDir, '.claude-plugin'), join(dir, '.claude-plugin'), { recursive: true });
  cpSync(settingsPath, join(dir, 'settings.json'));
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('attempt labels', () => {
  const workflow = loadWorkflow({ packDir });
  const job = workflow.jobs['dev']!;
  let pack: PackFingerprints;
  beforeAll(async () => {
    pack = await packFingerprints(packDir);
  });

  it('labels the task, queue, model and factory version, with a fingerprint for each input', () => {
    const l = attemptLabels({ job, ...prompted(P), workflow, pack, factoryCommit: 'abc123' });
    expect(l).toMatchObject({ task: 'dev', queue: job.queue, model: job.model, factoryVersion: VERSION, factoryCommit: 'abc123' });
    expect(l.fingerprints.prompt).toMatch(SHA);
    expect(l.fingerprints.promptTemplate).toMatch(SHA);
    expect(l.fingerprints.skills).toMatch(SHA);
    expect(l.fingerprints.workflow).toMatch(SHA);
    expect(l.fingerprints.config).toMatch(SHA);
  });

  it('records the effort of the job, null for a job without one (ORC-136)', () => {
    expect(attemptLabels({ job, ...prompted(P), workflow, pack, factoryCommit: null }).effort).toBe(job.effort);
    expect(job.effort).toBe('medium');
    const { effort: _none, ...stepless } = job;
    expect(attemptLabels({ job: stepless, ...prompted(P), workflow, pack, factoryCommit: null }).effort).toBeNull();
  });

  it('leaves the labels nothing provides yet null, each with the tickets that will fill it', () => {
    const l = attemptLabels({ job, ...prompted(P), workflow, pack, factoryCommit: null });
    expect(l).toMatchObject({ factoryCommit: null, image: null, risk: null, registryCommit: null, deliveredFactIds: null });
    expect(l.fingerprints.knowledgeIndex).toBeNull();
    expect(pendingLabels(l)).toEqual({
      image: ['ORC-204'],
      risk: ['ORC-206'],
      registryCommit: ['ORC-257'],
      deliveredFactIds: ['ORC-257'],
      knowledgeIndex: ['ORC-232'],
    });
    expect(pendingLabels(attemptLabels({ job, ...prompted(P), workflow, pack, factoryCommit: 'abc' }))).not.toHaveProperty('factoryCommit');
  });

  it('takes the factory commit from FACTORY_COMMIT when none is given', () => {
    const before = process.env['FACTORY_COMMIT'];
    try {
      process.env['FACTORY_COMMIT'] = 'f00d';
      expect(attemptLabels({ job, ...prompted(P), workflow, pack }).factoryCommit).toBe('f00d');
      delete process.env['FACTORY_COMMIT'];
      expect(attemptLabels({ job, ...prompted(P), workflow, pack }).factoryCommit).toBeNull();
    } finally {
      if (before === undefined) delete process.env['FACTORY_COMMIT'];
      else process.env['FACTORY_COMMIT'] = before;
    }
  });

  it('gives the same fingerprints for the same inputs', async () => {
    const a = attemptLabels({ job, ...prompted(P), workflow, pack, factoryCommit: null });
    const again = await packFingerprints(packDir);
    const b = attemptLabels({ job, ...prompted(P), workflow: loadWorkflow({ packDir }), pack: again, factoryCommit: null });
    expect(b).toEqual(a);
  });

  it('gives two workflow versions two fingerprints', () => {
    const v1 = loadWorkflow({ packDir });
    const v2 = loadWorkflow({ packDir });
    v2.limits.parallelSessions += 1;
    expect(workflowFingerprint(v2)).not.toBe(workflowFingerprint(v1));
    expect(workflowFingerprint(loadWorkflow({ packDir }))).toBe(workflowFingerprint(v1));
    const a = attemptLabels({ job, ...prompted(P), workflow: v1, pack, factoryCommit: null });
    const b = attemptLabels({ job, ...prompted(P), workflow: v2, pack, factoryCommit: null });
    expect(b.fingerprints.workflow).not.toBe(a.fingerprints.workflow);
  });

  it('changes the prompt fingerprint with the ticket, and the template one with what the job asks only', () => {
    const a = attemptLabels({ job, ...prompted(P), workflow, pack, factoryCommit: null });
    const b = attemptLabels({ job, ...prompted(promptFor('REL-2', 'Import PDF')), workflow, pack, factoryCommit: null });
    expect(b.fingerprints.prompt).not.toBe(a.fingerprints.prompt);
    expect({ ...b.fingerprints, prompt: '' }).toEqual({ ...a.fingerprints, prompt: '' });
    const fix = attemptLabels({ job, ...prompted({ ...P, input: { kind: 'ci_failures', text: 'test rouge' } }), workflow, pack, factoryCommit: null });
    expect(fix.fingerprints.promptTemplate).not.toBe(a.fingerprints.promptTemplate);
    expect(promptTemplate(P)).not.toContain('REL-1');
  });

  it('changes the skills fingerprint when a skill file changes, and the config one when a hook or the settings change', async () => {
    const dir = tempPack();
    const skills = await skillsFingerprint(dir);
    const config = await configFingerprint(dir);
    expect(skills).toBe(pack.skills);
    expect(config).toBe(pack.config);

    writeFileSync(join(dir, 'skills', 'dev', 'extra.md'), 'one more line\n');
    expect(await skillsFingerprint(dir)).not.toBe(skills);
    expect(await configFingerprint(dir)).toBe(config);

    writeFileSync(join(dir, 'hooks', 'extra.mjs'), '// hook\n');
    const withHook = await configFingerprint(dir);
    expect(withHook).not.toBe(config);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
    const withSettings = await configFingerprint(dir);
    expect(withSettings).not.toBe(withHook);
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"factory"}\n');
    const withPlugin = await configFingerprint(dir);
    expect(withPlugin).not.toBe(withSettings);
    writeFileSync(join(dir, '.mcp.json'), '{}\n');
    expect(await configFingerprint(dir)).not.toBe(withPlugin);
  });

  it('gives null fingerprints for a pack it cannot read, and says why', async () => {
    const dir = tempPack();
    rmSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'skills'), 'not a directory');
    const errors: string[] = [];
    const prints = await packFingerprints(dir, (err) => errors.push(err.message));
    expect(prints.skills).toBeNull();
    expect(prints.config).toMatch(SHA);
    expect(errors).toHaveLength(1);
  });

  it('fingerprints the run settings without the instance home: two homes give one config fingerprint', () => {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    const homes = [join(tmpdir(), 'home-a'), '/srv/factory/home-b'];
    const built = homes.map((home) => buildRunSettings(settings, home));
    expect(stableJson(built[0])).not.toBe(stableJson(built[1]));
    // Each home's run settings are the template with that home in place of <HOME> (on Windows, written as is and in lower case).
    homes.forEach((home, i) => {
      const abs = `/${posixPath(resolve(home))}`;
      const own = built[i]!;
      const deny = [...new Set(own.permissions.deny!.map((r) => r.split(abs).join('<HOME>').split(abs.toLowerCase()).join('<HOME>')))];
      const homeless = { ...own, permissions: { ...own.permissions, deny } };
      expect(homeless).toEqual(runSettingsTemplate(settings));
    });
  });

  it('gives a text file the same fingerprint with CRLF and LF line ends, and leaves binary files as they are', async () => {
    const dir = tempPack();
    const skill = join(dir, 'skills', 'dev', 'SKILL.md');
    const hook = join(dir, 'hooks', 'session-start.mjs');
    const lf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(skill, lf(skill));
    writeFileSync(hook, lf(hook));
    const skills = await skillsFingerprint(dir);
    const config = await configFingerprint(dir);
    expect(skills).toBe(pack.skills);
    expect(config).toBe(pack.config);

    writeFileSync(skill, lf(skill).replace(/\n/g, '\r\n'));
    writeFileSync(hook, lf(hook).replace(/\n/g, '\r\n'));
    expect(readFileSync(skill, 'utf8')).toContain('\r\n');
    expect(await skillsFingerprint(dir)).toBe(skills);
    expect(await configFingerprint(dir)).toBe(config);

    writeFileSync(join(dir, 'skills', 'dev', 'blob.bin'), Buffer.from([0, 13, 10]));
    const binary = await skillsFingerprint(dir);
    writeFileSync(join(dir, 'skills', 'dev', 'blob.bin'), Buffer.from([0, 10]));
    expect(await skillsFingerprint(dir)).not.toBe(binary);
  });

  it('neither follows nor hashes a symbolic link in the pack', async (ctx) => {
    const dir = tempPack();
    const outside = mkdtempSync(join(tmpdir(), 'labels-out-'));
    temps.push(outside);
    writeFileSync(join(outside, 'secret.md'), 'outside the pack\n');
    try {
      symlinkSync(outside, join(dir, 'skills', 'linked'), 'junction');
      symlinkSync(join(outside, 'secret.md'), join(dir, 'skills', 'dev', 'linked.md'));
    } catch (err) {
      // Windows refuses file symlinks without Developer Mode or admin rights.
      if (['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return ctx.skip();
      throw err;
    }
    expect(await skillsFingerprint(dir)).toBe(pack.skills);
  });

  it('sorts object keys at every level', () => {
    expect(stableJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}');
  });
});
