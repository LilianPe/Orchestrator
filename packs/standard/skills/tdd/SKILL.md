---
name: tdd
description: Test-first method (red, green, clean up) for any behavior change: feature, bug fix, refactoring. To follow before writing production code.
---

# factory:tdd

**Rule: no production code without a test that failed first, and for the right reason.** A test you have not seen fail proves nothing: it may test something else, or nothing at all.

## When

Always when the behavior changes: new feature, bug, refactoring that touches logic, review feedback that describes a defect.

Exceptions (to write in your `submit_result` summary, with the reason): pure configuration file, text or translation, generated code, documentation. If the repository forbids a type of test (see `CLAUDE.md`), follow the repository and say so.

## The cycle

1. **Red — one test, one behavior.** Before writing the test, name the production change that would make it fail. A test name that describes the expected behavior ("rejects an empty email", not "test1"). An "and" in the name: two tests.
2. **Verify the red — mandatory.** For tests that a `tests` step wrote before you, the factory has already verified the red: do not verify it again. For the others: run that single test file (`npx vitest run <file>`, `pytest <file>::<test>`, etc.). It must **fail**, not crash: the failure message says the behavior is missing, not that an import is broken or that there is a typo. It already passes? You are testing existing behavior: fix the test. It crashes? Fix the error and rerun until a real failure.
3. **Green — the minimal code.** The simplest thing that makes the test pass. No option "for later", no neighboring refactoring, no improvement beyond the test.
4. **Verify the green — mandatory.** Rerun the test, then the neighboring tests (same file, same module, consumers of the changed code). Clean output: no new error or warning. A test fails: fix the code, not the test.
5. **Clean up.** Only when green: names, duplication, extraction. The tests stay green at every step. No new behavior here.
6. Next behavior: back to 1.

## Honest tests

- **Real code, not mocks.** A mock only at slow or external boundaries (network, clock, third-party service). An assertion on a mock ("was called 3 times") tests the mock, not the code.
- **The test must be able to fail.** A mock registered too late, a negative assertion ("does not throw") that passes from the first writing, a value the test bench would produce anyway (`undefined`, `0`, `""`): this test guards nothing. Check it: deliberately break the code (one line, with Edit), rerun, the test must turn red; then restore the code (Edit) and check that `git diff` no longer shows your mutation.
- **Place the test where the function is already tested** (`grep -rl "<function>" <tests folder>`), not according to the file name.
- **No test-only code in production.** Test helpers go in the test utilities.
- Before mocking a dependency, know what else it does (local transformation, side effect): the mock erases that too.

## Bug: the test first

A bug is fixed in two logical commits or a single one, but always in this order: a test that reproduces the symptom (red), then the fix (green). To find the cause, follow `factory:debugging`; the test comes before the fix.

## Stop signals

Start over with a test if you catch yourself: writing the code before the test; keeping code "for reference" while writing the test afterwards; seeing a test pass on the first try without understanding why; saying "tested by hand", "too simple for a test", "I'll test later". A test written after the fact passes right away and proves nothing.

Hard to test? It is often the design: a simpler interface, an injected dependency, rather than a scaffolding of mocks.

## Done when

- each new or fixed behavior has a test you saw fail for the right reason;
- the minimal code makes it pass, and the neighboring tests are green;
- you can cite the command run and its result (see `factory:verification`).
