import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const projectSchema = z.object({ id: z.string().min(1), repoPath: z.string().min(1), linearTeamKey: z.string().min(1) });

const instanceSchema = z.object({
  port: z.number().int().positive().default(4100),
  host: z.string().default('127.0.0.1'),
  publicUrl: z.string().url().optional(),
  relay: z.discriminatedUnion('kind', [z.object({ kind: z.literal('smee'), url: z.string().url() }), z.object({ kind: z.literal('none') })]).default({ kind: 'none' }),
  projects: z.array(projectSchema).default([]),
  limits: z.object({ perDayUsd: z.number().positive().optional() }).default({}),
  knowledge: z.object({ repoPath: z.string() }).optional(),
});

export type ProjectConfig = z.infer<typeof projectSchema>;
export type InstanceConfig = z.infer<typeof instanceSchema>;

export interface LinearSecrets {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  appUserId?: string;
  organizationId?: string;
}

export interface Secrets {
  linear?: LinearSecrets;
}

export function relaisHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['RELAIS_HOME'] ?? join(env['HOME'] ?? homedir(), '.relais');
}

export function homePaths(home: string) {
  return {
    config: join(home, 'config.yaml'),
    secrets: join(home, 'secrets.json'),
    runSettings: join(home, 'run-settings.json'),
    db: join(home, 'relais.db'),
    transcripts: join(home, 'transcripts'),
    workspaces: join(home, 'workspaces'),
    logs: join(home, 'logs'),
  };
}

function ensureTree(home: string): void {
  const p = homePaths(home);
  for (const dir of [home, p.transcripts, p.workspaces, p.logs]) mkdirSync(dir, { recursive: true });
}

function validate(raw: unknown): InstanceConfig {
  const res = instanceSchema.safeParse(raw ?? {});
  if (!res.success) {
    const i = res.error.issues[0]!;
    throw new Error(`config.yaml invalide : ${i.path.join('.')}: ${i.message}`);
  }
  return res.data;
}

export function loadInstance(home: string): InstanceConfig {
  const file = homePaths(home).config;
  return validate(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {});
}

export function saveInstance(home: string, cfg: InstanceConfig): void {
  const valid = validate(cfg);
  ensureTree(home);
  writeFileSync(homePaths(home).config, stringify(valid));
}

export function loadSecrets(home: string): Secrets {
  const file = homePaths(home).secrets;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Secrets) : {};
}

export function saveSecrets(home: string, s: Secrets): void {
  ensureTree(home);
  const file = homePaths(home).secrets;
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
