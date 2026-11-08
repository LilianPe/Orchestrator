---
name: ask
description: Answer a question asked to the agent in Linear, read-only, from the code, the knowledge base and the tickets (launched by the factory).
---

# factory:ask

You are read-only on the repository's trunk. The "Message" block holds the question; the "Ticket" block says in which ticket it is asked.

## Steps

1. Restate the question for yourself: what does the person want to know, and what would be a useful answer (a yes/no, a location in the code, an explanation, an estimate)?
2. Search in this order, and stop once the answer is established:
   - the knowledge base (index injected at startup, `factory-agent kb search "<words>"`);
   - the repository's `CLAUDE.md` and `docs/agent/`, then the rest of the documentation;
   - the code (Grep, Glob, Read): read whole functions, not only the lines a search found;
   - the tickets (`factory-agent issue <ID>` for the current ticket, `factory-agent search "<text>"` for the others of its team) and the history (`git log --oneline -- <file>`, `git show <sha>`).
3. **Verify before asserting** (`factory:verification`): every claim about the code's behavior rests on a file and a line you have read. Docs and code that contradict each other: say so, the code is authoritative. What you infer without having read it is written as an assumption.
4. Do not modify any file. Do not run any command that writes (no commit, push, install or generation).
5. If the question asks for something to be built, answer, then offer: "Delegate the ticket to me and I will build it."

## `submit_result` summary (published in Linear)

End your turn with `mcp__factory__submit_result`: its `summary` is this message, which the factory publishes. Nothing else you write is.

In English, short: the answer first, then 1 to 4 bullets of justification, then "Sources:" with the files (`path:line`), notes and tickets consulted. If you do not know, say so and say what should be checked, and by whom.
