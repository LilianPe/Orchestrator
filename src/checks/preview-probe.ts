import type { SandboxProvider } from '../adapters/sandbox/types.js';
import { cappedCommand } from '../core/verify.js';

/** How long a found recipe has to answer on its port (ORC-386): a dev server that builds first gets a minute. */
export const PROBE_WAIT_S = 60;
/** What a failed probe says of the application's output: its tail. */
const LOG_TAIL_BYTES = 2000;

/**
 * Run by `bash` in the sandbox: the setup and the command in the background on `PORT`, their output to a file, then `GET /` on
 * `127.0.0.1:$PORT` from bash itself (`/dev/tcp`), no tool of the image needed, once a second until an HTTP status line comes
 * back. Anything that listens without speaking HTTP is no answer. The application is stopped before the script ends.
 */
const SCRIPT = `log="$(mktemp)"
PORT="$1" bash --norc -c "$3" >"$log" 2>&1 &
app=$!
for _ in $(seq 1 "$2"); do
  if timeout 5 bash --norc -c 'exec 3<>"/dev/tcp/127.0.0.1/$0" && printf "GET / HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n" >&3 && head -c 5 <&3 | grep -q "^HTTP/"' "$1" 2>/dev/null; then
    echo answered; kill "$app" 2>/dev/null; exit 0
  fi
  sleep 1
done
echo "nothing answers on port $1 after $2 s"
tail -c ${LOG_TAIL_BYTES} "$log"
kill "$app" 2>/dev/null
exit 1`;

export type Probed = { answered: true } | { answered: false; detail: string };

/**
 * The factory's own check of a start recipe the agent found (ORC-386), before anything uses it or the knowledge base keeps it:
 * the application answers HTTP on `port` in the sandbox `sandboxId`, its checkout set up, at network `none`. Its start is the last
 * word of the command, as a verification command's is.
 */
export async function probeStart(sandboxes: Pick<SandboxProvider, 'exec'>, sandboxId: string, req: { start: string; port: number; env: Record<string, string>; waitS?: number }): Promise<Probed> {
  const waitS = req.waitS ?? PROBE_WAIT_S;
  const argv = [...cappedCommand(SCRIPT, waitS * 6 + 30), 'probe', String(req.port), String(waitS), req.start];
  const r = await sandboxes.exec(sandboxId, argv, { env: req.env });
  if (r.code === 0 && r.stdout.trim().split('\n').at(-1) === 'answered') return { answered: true };
  return { answered: false, detail: `${r.stdout}${r.stderr}`.trim().slice(-LOG_TAIL_BYTES) || `the probe ended with code ${r.code}` };
}
