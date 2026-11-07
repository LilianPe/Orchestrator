# Relais acceptance run (test Linear)

Prerequisites: Node 24, `gh` logged in, `claude` logged in, a test Linear workspace you are an admin of, a small GitHub repository with tests, with **branch protection on the default branch** (PR required, force-push forbidden): the pack's refusals are only a first barrier, GitHub is what guarantees that only humans merge.

## 0. Installation
```bash
git clone git@github.com:lilianperthuis/relais.git && cd relais
npm ci && npm run build && npm link
```

## 1. init (criterion 1, < 15 min)
In the test repository: `relais init`. Follow the instructions (Linear OAuth app, webhook = displayed smee URL, categories Agent session events + Issues + Comments). Check `~/.relais/config.yaml`, `~/.relais/secrets.json` (mode 600), `.relais/workflow.yml`.

## 2. up and connection (criterion 2)
`relais up`, open http://localhost:4100, click « Connecter Linear ». Expected: page « Linear est connecté », statuses Human Review / AI Review and labels agent:* and Bloqué created in the team, button replaced by the « en direct » state.
If Linear refuses the localhost callback URL: note the error, use `cloudflared tunnel --url http://localhost:4100` for the duration of the installation and put the public URL in `publicUrl`.

## 3. Delegation (criterion 3)
Create a clear ticket (≥ 30 characters of description), delegate it to @relais. Expected in < 10 s: the comment « Bien reçu. » on the ticket, then the plan in the session (`comprendre · questions · spec · tests · build · vérif · PR`). Then: status In Progress, live output in the UI, PR opened, status Human Review, summary in French in the session.
Check in `~/.relais/relais.db` that no event was rejected for its signature (otherwise: the smee relay modifies the body → switch to `publicUrl` via a tunnel).

## 4. Grouped feedback (criterion 4)
Write two remarks in the thread less than a minute apart. Expected: a single resume 3 minutes after the last one, same Claude session (same id in the UI), reply with the commit.

## 5. AI review then merge (criterion 5)
Move the ticket to AI Review. Expected: fresh session, summary, status Human Review. Merge the PR on GitHub. Expected in < 1 min: status Done, worktree removed from `~/.relais/workspaces`, learn run started.

## 6. Questions and memory (criterion 6)
On another ticket: `@relais où est géré X ?` → read-only answer. `@relais retiens <fait>` → PR in relais-knowledge. Merge it, then ask a related question: the answer cites the note.

## 7. Stop (criterion 7)
Delegate a ticket, during the run click "Send stop request" in Linear. Expected in < 10 s: « Arrêté… », ticket blocked, run `stopped`.

## 8. Docker (criterion 8)
On the server, images built ([`deploiement.md`](deploiement.md#first-start)), as an automated test, under its own project name and ports:

```bash
FACTORY_ISOLATION=1 FACTORY_COMPOSE=1 FACTORY_CONTAINER_CLI=docker FACTORY_RUNNER_IMAGE=<image> \
  FACTORY_ENGINE_SOCKET=/run/user/1000/docker.sock \
  npx vitest run --project isolation test/isolation/compose-stack.test.ts
```

Expected: the 4 services started on a rootless engine; TLS through `caddy`, 401 without the password; a runner created from `factoryd`, without the engine socket, with `--network none`, with pnpm and uv installing through the proxy, and the refusals in the log. Without a real `claude` or ticket.

`FACTORY_ALLOW_ROOTFUL_ENGINE=1` lets this test run on a workstation (Docker Desktop): it then skips the "rootless" check and checks the refusal. This result proves nothing for the server.

Claude Code authentication is required: `ANTHROPIC_API_KEY`, or `CLAUDE_TOKEN_1` with an active account in `factory.yml`.

Then, by hand: `docker compose up -d`, UI at `https://<domain>`, same behavior as 3. With `concurrency: 1`, delegate two tickets: only one runner runs (`docker ps --filter label=factory.attempt`).

With `host` other than `127.0.0.1`, the daemon refuses to start without `FACTORY_UI_PASSWORD`: the UI, `/api/*` and `/oauth/start` then require HTTP Basic authentication (any username, password = `FACTORY_UI_PASSWORD`). Still open: `POST /webhooks/linear` (signed), `GET /oauth/callback` and `/agent/*` (run token). Check: `curl -i https://<domain>/api/state` answers 401.

## Optional live checks
- `LINEAR_API_KEY=<personal key> npx vitest run src/adapters/tracker/linear/queries.live.test.ts`: all queries validate against the Linear schema.
- `FACTORY_E2E=1 npx vitest run test/e2e/pack.e2e.test.ts`: the pack loads the hook and refuses `gh pr merge`.

## Points to check during the acceptance run
1. Does Claude Code `stream-json` repeat `message.id` on the `assistant` lines of the same message (the turn cap counts distinct `id`s, ORC-136)? Observe: the number of turns displayed for a run matches the number of real assistant messages.
2. Does the signature of webhooks relayed by smee match the raw body (HMAC check)? Observe: no event rejected for its signature in `~/.relais/relais.db`.
3. Does Linear accept an OAuth callback URL on `http://localhost` (otherwise the cloudflared procedure already described)? Observe: the connection in step 2 succeeds, or Linear's error.
4. The daemon announces `http://localhost:4100` but listens on `127.0.0.1`: if `localhost` resolves to `::1` first, the link does not answer. Observe: if the link does not answer, use `http://127.0.0.1:4100`.
5. The knowledge base repository (`knowledge.repoPath`) must stay on its default branch: Relais does a `fetch` + `merge --ff-only` there before each run. Observe: no `merge --ff-only` failure in a run's logs.
6. Does the installed Claude Code version apply wildcards at the start of a pattern? Observe: in a test worktree, a session launched with `--settings ~/.relais/run-settings.json`: same check for the leading wildcard of `Bash(*secrets.json*)`: `cat ~/.relais/secrets.json` must be refused.
7. In `--permission-mode plan` (`trunk-readonly` runs), does Claude Code allow calling `mcp__factory__submit_result` and `mcp__factory__ask`, permitted by the pack's `allow`? Observe: a question (`@Relais …`) that calls `submit_result` has no permission refusal in its transcript. Otherwise, these runs answer with their last message only.
8. Does `claude -p --effort <low|medium|high>` accept these values, also with `--resume` (ORC-136)? Observe: a `dev` run starts, and the `init` event reports no refused option. Tested only on a fake `claude`; `--effort` was only read in `claude --help` (2.1.318).
9. Does a failed `Bash` call arrive in `stream-json` with `is_error: true`, `tool_use_id` and its output in `content` (ORC-136)? Observe: an agent made to rerun a failing command 3 times, without changing anything, ends up Bloqué on « Boucle : ». Otherwise the loop detector sees nothing, and only turns and duration bound it.
10. Does a real `dev` run call `mcp__factory__submit_result` from its sandbox (ORC-136)? Observe: the run ends in success. The pack requires it for `dev`: without that call, or if the factory's MCP is not reachable, every build ends up Bloqué on « Le run dev a échoué. ».
11. Do the `assistant` lines of `stream-json` carry the message's real `output_tokens`, or a provisional value (ORC-136)? Observe: on a real run, the sum per `message.id` compared with the `usage` of the `result` line. If it undercounts, the `budgets.per_step_tokens` cap triggers too late, and it must be calibrated on what is counted.

## Security: known limits
- At startup, Relais writes `<RELAIS_HOME>/run-settings.json` (the pack's settings + read refusals on `secrets.json`, `relais.db`, `transcripts/` and `logs/` of the real `RELAIS_HOME`) and passes it to each run via `--settings`. Check: the file exists and contains the real path (`/data/...` in Docker).
- A run's environment contains neither `LINEAR_*` nor the daemon's `RELAIS_*` (only `RELAIS_API`, `RELAIS_RUN_TOKEN`, `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT` are set).
- Residual risk: the pack allows `Bash(node:*)`, `Bash(npx:*)`, `Bash(npm:*)`. An agent (or an injection in a ticket) can therefore read `secrets.json` through a script (`node -e "…readFileSync(…)"`): Claude Code's deny lists are advisory, not a security boundary. The agent runs as the same user as the daemon. Do not deploy Relais on tickets coming from untrusted people as long as runs do not run under a separate user.
