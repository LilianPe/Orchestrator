import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';

export interface KbHit {
  file: string;
  line: number;
  text: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class KnowledgeBase {
  constructor(
    private repoPath: string,
    private exec: Exec = execCmd,
  ) {}

  async pull(): Promise<void> {
    const remotes = await this.exec('git', ['-C', this.repoPath, 'remote']);
    if (!remotes.stdout.trim()) return;
    await mustExec(this.exec, 'git', ['-C', this.repoPath, 'fetch', 'origin']);
    const head = await this.exec('git', ['-C', this.repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const trunk = head.code === 0 ? head.stdout.trim() : 'origin/main';
    await mustExec(this.exec, 'git', ['-C', this.repoPath, 'merge', '--ff-only', trunk]);
  }

  readIndex(maxChars = 8000): string {
    const f = join(this.repoPath, 'INDEX.md');
    return existsSync(f) ? readFileSync(f, 'utf8').slice(0, maxChars) : '';
  }

  async search(query: string, limit = 20): Promise<KbHit[]> {
    const terms = norm(query).split(/\s+/).filter((t) => t.length >= 3);
    const dir = join(this.repoPath, 'notes');
    if (!terms.length || !existsSync(dir)) return [];
    const hits: (KbHit & { score: number })[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const lines = readFileSync(join(dir, name), 'utf8').split('\n');
      lines.forEach((text, i) => {
        const n = norm(text);
        const score = terms.filter((t) => n.includes(t)).length;
        if (score > 0) hits.push({ file: `notes/${name}`, line: i + 1, text, score });
      });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line)
      .slice(0, limit)
      .map(({ score: _s, ...h }) => h);
  }
}
