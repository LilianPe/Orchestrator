// Reads the unified diff of `git diff baseSha..SHA` (default `a/` and `b/` prefixes) into files and added lines.
// No git call here: the checks stay pure, the caller produces the text.

export interface AddedLine {
  /** Line number in the new version of the file. */
  line: number;
  text: string;
}

export interface DiffFile {
  /** Path after the change (before it, for a deleted file). */
  path: string;
  /** Path before the change, when it differs: a rename, or a copy. */
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  added: AddedLine[];
  removed: number;
}

// Git quotes a path with special characters C-style: "b/caf\303\251.ts".
function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw.split('\t')[0]!;
  const bytes: number[] = [];
  const body = raw.slice(1, raw.lastIndexOf('"'));
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      const next = body[++i] ?? '';
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

// `diff --git a/x b/y` is ambiguous with spaces in the paths; it is only read when no ---/+++ or rename line names the file.
function fromGitHeader(line: string): { a: string; b: string } {
  const rest = line.slice('diff --git '.length);
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (quoted) return { a: stripPrefix(unquote(quoted[1]!)), b: stripPrefix(unquote(quoted[2]!)) };
  const half = rest.indexOf(' b/');
  return half === -1 ? { a: rest, b: rest } : { a: stripPrefix(rest.slice(0, half)), b: stripPrefix(rest.slice(half + 1)) };
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: (DiffFile & { from?: string; to?: string }) | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;

  const finish = (): void => {
    if (!file) return;
    const { from, to, path: headerB, oldPath: headerA, ...rest } = file;
    const path = to ?? from ?? headerB;
    const oldPath = from ?? headerA;
    files.push({ path, ...(oldPath !== undefined && oldPath !== path ? { oldPath } : {}), ...rest });
    file = undefined;
  };

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        file!.added.push({ line: next++, text: line.slice(1) });
        newLeft--;
      } else if (line.startsWith('-')) {
        file!.removed++;
        oldLeft--;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file"
      } else {
        next++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      finish();
      const { a, b } = fromGitHeader(line);
      file = { path: b, oldPath: a, status: 'modified', added: [], removed: 0 };
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      next = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
    } else if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) [file.status, file.from] = ['renamed', unquote(line.slice('rename from '.length))];
    else if (line.startsWith('rename to ')) file.to = unquote(line.slice('rename to '.length));
    else if (line.startsWith('copy from ')) file.from = unquote(line.slice('copy from '.length));
    else if (line.startsWith('copy to ')) [file.status, file.to] = ['added', unquote(line.slice('copy to '.length))];
    else if (line.startsWith('--- ')) {
      const p = unquote(line.slice(4));
      if (p !== '/dev/null') file.from ??= stripPrefix(p);
    } else if (line.startsWith('+++ ')) {
      const p = unquote(line.slice(4));
      if (p !== '/dev/null') file.to ??= stripPrefix(p);
    }
  }
  finish();
  return files;
}
