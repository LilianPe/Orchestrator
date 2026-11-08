---
name: learn
description: Add to the shared knowledge base what is worth remembering after a ticket or on request (the "retiens" command), as notes committed on a dedicated branch (launched by the factory).
---

# factory:learn

Your working directory is a worktree of the knowledge repository, on a dedicated `learn/...` branch. The repository contains `INDEX.md` (one line per note) and `notes/*.md`. Nobody answers during your turn.

## What deserves a note

A durable, non-obvious fact, reusable by another dev or another ticket: a project convention, a pitfall encountered and its workaround, a decision and its reason, a useful command. Not the ticket's summary, not what the repository's code or docs already say clearly, not a detail that will only serve once.

Quick test: would a dev opening a neighboring ticket in three months lose time without this note? No: no note.

## Steps

1. If the "Message" block exists (the "retiens" command), it is the knowledge to record: restate it faithfully, adding nothing the person did not say.
2. Otherwise (ticket finished), read the PR: `gh pr view <PR url> --comments` and `gh pr diff <PR url>`. Review feedback and CI fixes are often where the pitfalls are. Pick 0 to 3 facts. Zero is a good answer.
3. **Verify each fact** in the PR or the code before writing it: a wrong note is worse than no note, because every later run reads it.
4. Before writing, look for an existing note on the same subject (`grep -ril "<word>" notes/`) and complete it rather than creating a new one. An existing note that the PR contradicts: fix it and say so.
5. One note = `notes/<slug>.md`:
   ```
   ---
   title: <short title>
   tags: [<project>, <topic>]
   source: <ticket ID or "request from <author>">
   ---
   <3 to 10 lines: the fact, why, how to apply it>
   ```
6. Add or update the line in `INDEX.md`: `- [<title>](notes/<slug>.md) — <one-line summary>`. The index is injected into every run: the line must say when the note is useful.
7. Commit (`learn: <title>`) on the current branch. You do not push and you do not open a PR: you do not write to the forge.

Never merge.

## Last message (published in Linear)

In English: "Remembered: <title> — commit <short sha> on <branch>", one line per note, or "Nothing durable to remember from this ticket."
