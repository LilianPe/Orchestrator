# Publisher port

The factory pushes the verified sha and opens the branch's PR, or finds it again (ORC-125). The agent no longer pushes.

- Interface: `Publisher` (`src/adapters/publisher/types.ts`), new port (ORC-225).
- Implementations: `GitPublisher` (`src/publish/publish.ts`), `FakePublisher` (`src/adapters/publisher/fake.ts`).
- Suite: `test/contracts/publisher.contract.ts`, run by `src/adapters/publisher/fake.test.ts`. `GitPublisher` has its tests on a real git and a bare repository (`src/publish/publish.test.ts`), and under a real engine (`test/isolation/isolation-08-diff.test.ts`): it needs a `ForgeWriter`, a sandbox and a repository, which the suite does not set up.

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `publish(req)` | the branch carries `req.sha` and has an open PR, draft when created; returns its number, its `https://` URL and the pushed sha | same PR, same result, no push; a different sha updates the branch without opening a second PR | `PublishRefused` (`moved`, `rejected`, `diff`, `head`, `trunk`, `empty`): an answer, nothing is written to the forge, do not replay; any other rejection: replay, the push may have happened |

A branch has its own PR. When the branch's PR is merged or closed, publishing opens a new one, like GitHub.

## Idempotence

The key is the branch ("Push" and "PR" rows of ORC-162): the branch head is read before pushing, the existing PR looked up before creating one.

## Fencing

The push is done with `--force-with-lease` on the head that was read, and only if that head is part of the work: never over a commit the work does not have. `GitPublisher` is what proves it (on `--force-with-lease` refused after a move between the read and the push): the fake knows nothing of ancestry, it refuses on command (`refuseNext`).

## What the suite asks of the implementation

`PublisherSubject`: a request on a branch without a PR, and optionally `end(branch, n)`, which merges or closes that PR on the forge (the fake does it through `FakeForge.setPr`).

## Known gaps

`GitPublisher` does not run the suite (see above).
