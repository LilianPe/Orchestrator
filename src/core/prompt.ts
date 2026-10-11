import type { FeedbackItem, InputKind, VerifyFailure } from './types.js';

export interface PromptIssue {
  identifier: string;
  title: string;
  description: string;
  url: string;
}

export interface PromptInput {
  skill: string;
  issue: PromptIssue;
  branch?: string;
  prUrl?: string;
  promptContext?: string;
  input?: { kind: InputKind; text: string };
  reviewRounds: number;
}

const HEADINGS: Record<InputKind, string> = {
  feedback: 'Retours à traiter',
  ci_failures: 'CI en échec',
  verify_failures: 'Vérifications en échec',
  thread: 'Message',
};

export function buildPrompt(p: PromptInput): string {
  const lines = [`/${p.skill}`, '', `## Ticket ${p.issue.identifier} — ${p.issue.title}`, `URL : ${p.issue.url}`];
  if (p.branch) lines.push(`Branche : ${p.branch}`);
  if (p.prUrl) lines.push(`PR : ${p.prUrl}`);
  if (p.skill.endsWith(':review')) lines.push(`Rounds de review max : ${p.reviewRounds}`);
  lines.push('', p.issue.description.trim() || '(pas de description)', '');
  if (p.promptContext) lines.push('## Contexte Linear', p.promptContext, '');
  if (p.input) lines.push(`## ${HEADINGS[p.input.kind]}`, p.input.text, '');
  return lines.join('\n');
}

function utc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function formatFeedback(items: FeedbackItem[]): string {
  return items.map((i) => `- **${i.author}** (${utc(i.at)}) : ${i.body}`).join('\n');
}

const TAIL = 8000;

export function formatVerifyFailures(failures: VerifyFailure[]): string {
  return failures
    .map((f) => `### \`${f.command}\` (code ${f.exitCode ?? 'timeout'})\n\`\`\`\n${f.output.slice(-TAIL)}\n\`\`\``)
    .join('\n\n');
}
