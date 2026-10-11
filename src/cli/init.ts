import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Exec } from '../adapters/exec.js';
import { loadInstance, loadSecrets, saveInstance, saveSecrets } from '../config/instance.js';
import { slugify } from '../core/naming.js';

export interface InitIO {
  ask(q: string, def?: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  print(s: string): void;
}

export interface InitDeps {
  io: InitIO;
  home: string;
  cwd: string;
  createSmee: () => Promise<string>;
  exec: Exec;
}

function detectVerify(repo: string): string[] {
  const pkgFile = join(repo, 'package.json');
  if (!existsSync(pkgFile)) return [];
  const scripts = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  return ['lint', 'typecheck', 'test'].filter((s) => scripts[s]).map((s) => `npm ${s === 'test' ? 'test' : `run ${s}`}`);
}

export async function runInit(d: InitDeps): Promise<void> {
  const { io } = d;
  const top = await d.exec('git', ['rev-parse', '--show-toplevel'], { cwd: d.cwd });
  const repoPath = top.code === 0 ? top.stdout.trim() : await io.ask('Chemin du dépôt git à confier à Relais');
  const teamKey = (await io.ask('Clé de l’équipe Linear (ex. REL)')).toUpperCase();

  const cfg = loadInstance(d.home);
  const id = slugify(basename(repoPath), 30);
  cfg.projects = [...cfg.projects.filter((p) => p.repoPath !== repoPath), { id, repoPath, linearTeamKey: teamKey }];
  if (!cfg.publicUrl && cfg.relay.kind === 'none') cfg.relay = { kind: 'smee', url: await d.createSmee() };
  const webhookUrl = cfg.publicUrl ? `${cfg.publicUrl}/webhooks/linear` : cfg.relay.kind === 'smee' ? cfg.relay.url : '';
  const callbackUrl = `${cfg.publicUrl ?? `http://localhost:${cfg.port}`}/oauth/callback`;

  io.print(
    [
      '',
      '1. Dans Linear : Settings → API → OAuth applications → New application.',
      '   - Name : relais (c’est le nom qu’on mentionnera avec @)',
      `   - Callback URL : ${callbackUrl}`,
      '   - Cochez « Webhooks », URL :',
      `     ${webhookUrl}`,
      '   - Catégories : Agent session events, Issues, Comments',
      '2. Créez l’application, puis copiez ci-dessous le client ID, le client secret et le webhook signing secret.',
      '',
    ].join('\n'),
  );
  const clientId = await io.ask('Client ID');
  const clientSecret = await io.ask('Client secret');
  const webhookSecret = await io.ask('Webhook signing secret');
  const secrets = loadSecrets(d.home);
  const keepTokens = secrets.linear?.clientId === clientId ? secrets.linear : {};
  saveSecrets(d.home, { ...secrets, linear: { ...keepTokens, clientId, clientSecret, webhookSecret } });

  if (!cfg.knowledge && (await io.confirm('Créer un dépôt GitHub privé « relais-knowledge » pour la base de connaissance ?', true))) {
    const kbPath = join(d.home, 'knowledge');
    const created = await d.exec('gh', ['repo', 'create', 'relais-knowledge', '--private', '--add-readme', '--clone'], { cwd: d.home });
    if (created.code === 0) {
      mkdirSync(join(kbPath, 'notes'), { recursive: true });
      writeFileSync(join(kbPath, 'INDEX.md'), '# Base de connaissance Relais\n\n');
      writeFileSync(join(kbPath, 'notes/.gitkeep'), '');
      await d.exec('git', ['-C', kbPath, 'add', '.'], {});
      await d.exec('git', ['-C', kbPath, 'commit', '-m', 'init knowledge base'], {});
      await d.exec('git', ['-C', kbPath, 'push'], {});
      cfg.knowledge = { repoPath: kbPath };
    } else {
      io.print(`Création impossible : ${created.stderr.trim()}. Vous pourrez renseigner knowledge.repoPath dans ${join(d.home, 'config.yaml')}.`);
    }
  }

  const wfFile = join(repoPath, '.relais/workflow.yml');
  if (!existsSync(wfFile)) {
    const detected = detectVerify(repoPath);
    const verify = (await io.ask('Commandes de vérification après chaque run (séparées par ;)', detected.join('; ')))
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const setup = existsSync(join(repoPath, 'package-lock.json')) ? ['npm ci'] : [];
    mkdirSync(join(repoPath, '.relais'), { recursive: true });
    writeFileSync(
      wfFile,
      [
        'version: 1',
        'extends: standard',
        'tracker:',
        '  kind: linear',
        `  team: ${teamKey}`,
        'workspace:',
        `  setup: ${JSON.stringify(setup)}`,
        'jobs:',
        '  dev:',
        `    verify: ${JSON.stringify(verify)}`,
        '',
      ].join('\n'),
    );
  }

  saveInstance(d.home, cfg);
  io.print(
    [
      '',
      'Configuration écrite.',
      'Ensuite :',
      '  1. relais up',
      `  2. ouvrez http://localhost:${cfg.port} et cliquez « Connecter Linear » (installe l’agent dans votre espace)`,
      '  3. déléguez un ticket à @relais dans Linear',
      '',
    ].join('\n'),
  );
}
