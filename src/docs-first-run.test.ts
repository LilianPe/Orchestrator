import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The first-run guide (ORC-429) must not drift from the CLI: every `factory` command it quotes, with its flags, is one
// src/cli/factory.ts dispatches and lists in its usage.
const root = join(import.meta.dirname, '..');
const guide = readFileSync(join(root, 'docs/first-run.md'), 'utf8');
const cli = readFileSync(join(root, 'src/cli/factory.ts'), 'utf8');

/** The commands of the CLI's usage, each with the flags its line names, and the flags `parseArgs` accepts. */
function cliDefinitions(source: string) {
  const usage = /const USAGE = `([\s\S]*?)`;/.exec(source)?.[1] ?? '';
  const usageFlags = new Map<string, Set<string>>();
  for (const line of usage.split('\n').slice(1)) {
    const head = /^\s+(\w[\w-]*)(?: \| (\w[\w-]*))?/.exec(line);
    if (!head) continue;
    const flags = new Set([...line.matchAll(/--[\w-]+/g)].map((m) => m[0]));
    for (const name of head.slice(1).filter(Boolean)) usageFlags.set(name!, flags);
  }
  // Those with a parser of their own are dispatched before parseArgs, on process.argv[2].
  const ownParser = new Set([...source.matchAll(/process\.argv\[2\] === '([\w-]+)'/g)].map((m) => m[1]!));
  // The options object, on one line or several.
  const options = /parseArgs\(\{[\s\S]*?options: \{([\s\S]*?)\},?\s*\}\)/.exec(source)?.[1] ?? '';
  const parsed = new Set([...options.matchAll(/'?([\w-]+)'?: \{\s*type:/g)].map((m) => `--${m[1]}`));
  return { usageFlags, ownParser, parsed };
}

const defs = cliDefinitions(cli);

/** Why a quoted command line does not exist in the CLI, or undefined when it does. */
function problem(line: string): string | undefined {
  const [, cmd, rest = ''] = /^factory(?:\s+([^\s-][^\s]*))?(.*)$/.exec(line) ?? [];
  // `factory` alone prints the help; with a flag, parseArgs refuses it.
  if (cmd === undefined) return rest.trim() ? `${line}: no command before ${rest.trim()}` : undefined;
  const usage = defs.usageFlags.get(cmd);
  if (!usage) return `${line}: \`${cmd}\` is not a command of src/cli/factory.ts`;
  for (const flag of rest.match(/--[\w-]+/g) ?? []) {
    if (!usage.has(flag)) return `${line}: ${flag} is not in the usage of \`${cmd}\``;
    if (!defs.ownParser.has(cmd) && !defs.parsed.has(flag)) return `${line}: ${flag} is not a parseArgs option`;
  }
  return undefined;
}

const SHELLS = ['bash', 'sh', 'shell', 'console'];

/**
 * The `factory` commands the guide quotes: inline code that starts with `factory `, and the lines of shell blocks that do
 * (a `$ ` prompt dropped), their comment and what follows a `&&`, `;` or `|` left out.
 */
function quotedCommands(markdown: string): string[] {
  const found: string[] = [];
  const fences = /^```(\w*)\n([\s\S]*?)^```/gm;
  for (const [, lang, body] of markdown.matchAll(fences)) {
    if (!SHELLS.includes(lang!)) continue;
    for (const line of body!.split('\n')) {
      for (const part of line.replace(/#.*$/, '').split(/&&|;|\|/)) {
        const cmd = part.trim().replace(/^\$\s+/, '');
        if (/^factory(\s|$)/.test(cmd)) found.push(cmd);
      }
    }
  }
  const prose = markdown.replace(fences, '');
  for (const [, , code] of prose.matchAll(/(`+)\s?([\s\S]*?[^`])\s?\1(?!`)/g)) {
    if (/^factory(\s|$)/.test(code!)) found.push(code!.trim());
  }
  return found;
}

describe('docs/first-run.md', () => {
  const quoted = quotedCommands(guide);

  it('quotes the commands of a first run, flags included', () => {
    for (const cmd of ['factory init', 'factory init --dev', 'factory validate', 'factory doctor', 'factory doctor --json', 'factory up', 'factory plan', 'factory status', 'factory stop <ID>']) {
      expect(quoted).toContain(cmd);
    }
  });

  it('quotes only commands and flags the CLI defines', () => {
    expect(quoted.map(problem).filter(Boolean)).toEqual([]);
  });

  it('reads the CLI definitions it checks against', () => {
    // A command or a flag the CLI does not define is told, so the check above cannot pass for want of reading.
    expect(problem('factory teleport')).toMatch(/not a command/);
    expect(problem('factory doctor --fix')).toMatch(/--fix is not in the usage of `doctor`/);
    expect(problem('factory up --json')).toMatch(/--json is not in the usage of `up`/);
    expect(problem('factory up --fake-runner')).toBeUndefined();
    expect(problem('factory validate')).toBeUndefined();
    expect(problem('factory pause')).toBeUndefined();
    expect(problem('factory resume')).toBeUndefined();
    expect(problem('factory --json')).toMatch(/no command before --json/);
    expect(problem('factory')).toBeUndefined();
    expect(quotedCommands('```sh\n$ factory dry-run\n```')).toEqual(['factory dry-run']);
    expect(quotedCommands('```bash\nfactory up --nope   # comment: factory nothing\n```\nand `factory stop <ID>`')).toEqual(['factory up --nope', 'factory stop <ID>']);
  });
});
