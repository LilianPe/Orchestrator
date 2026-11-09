import type { FlowTicketView } from './types.js';

/** The host command of a shell in a take-over's container, as the server gives it. */
export interface ShellCommand {
  command: string[];
  env: Record<string, string>;
}

/** One word for a POSIX shell: as it is when nothing in it splits or expands, single-quoted otherwise. */
const word = (w: string): string => (/^[\w./:=@%+,-]+$/.test(w) ? w : `'${w.replaceAll("'", String.raw`'\''`)}'`);

/** The line to paste in a terminal of the server's host: the environment the command needs, then the command. */
export const shellLine = ({ command, env }: ShellCommand): string =>
  [...Object.entries(env).map(([k, v]) => `${k}=${word(v)}`), ...command.map(word)].join(' ');

/**
 * A ticket a human took over (ORC-234): its agent's run is stopped. The work goes on in its container, never on the server,
 * and goes out only through the factory: a reply relaunches the agent on it, or a bundle handed back is checked before any push.
 */
export function TakenOver({ ticket, shell, notice, onShell, onBundle }: {
  ticket: Pick<FlowTicketView, 'projectId' | 'ticketId' | 'title'>;
  /** The command of a shell in its container, once asked. */
  shell?: ShellCommand;
  /** The answer to the last action, when it was refused or is pending. */
  notice?: string;
  onShell: () => void;
  onBundle: (file: File) => void;
}) {
  return (
    <section className="inspection take-over">
      <h2>Taken over · {ticket.ticketId} · {ticket.title}</h2>
      <p>
        The agent's run is stopped. Work in the ticket's container (its worktree, no network, no secret), never on the server.
        Then reply on the ticket to relaunch the agent on your commits, or hand back a bundle of the whole ticket branch (<code>git bundle create work.bundle &lt;branch&gt;</code>):
        the factory verifies it in a fresh clone and checks its diff before any push.
      </p>
      <div className="actions">
        <button onClick={onShell}>Shell in its container</button>
        <label>
          Hand back a bundle <input type="file" accept=".bundle" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) onBundle(f); e.currentTarget.value = ''; }} />
        </label>
      </div>
      {shell && <pre className="shell">{shellLine(shell)}</pre>}
      {notice && <p className="flow-failed" role="alert">{notice}</p>}
    </section>
  );
}
