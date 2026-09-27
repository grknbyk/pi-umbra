---
name: delegate
description: Fan out independent read-only work (find usages across many files, summarize several modules, run tests and report, compare options) to separate cheap pi processes and read back their result files. Use whenever a task splits into 2+ lookups that do not need each other, or when the user writes "delegate", "fan out", "subagent", or starts a message with "delegate:".
---

# Delegate

pi has no subagent tool. A branch is a separate `pi -p` process with an empty
context and read-only tools; its result is a file this session reads. Nothing
is added to this session's prompt. Each branch keeps its session under
`$run/sessions/<stem>`, so a finished branch can be continued with `dresume`.

Each branch also writes a small live state file, so the agent panel can show
what it is doing while it runs instead of only what it concluded at the end.
That is handled by `run.sh` — do not hand-roll the `pi -p` command line.

## Run

One bash call. `dstart` records the session cwd and must run **before** any
`cd`, because the panel watches the directory pi started in. The smart tier is
this session's own model, `$PI_PROVIDER/$PI_MODEL`; `$FAST` and `$LOAD` come
from `delegate.env`, then from `~/.pi/agent/delegate.env` when it exists.

```bash
. <skill dir>/run.sh   # <skill dir>: the directory this SKILL.md is in
dstart <slug> "<one line describing the whole run>" map
cd <deepest folder the branches touch>   # optional, and only after dstart

branch map explorer-1 "$FAST" "Find every file that imports X. List file:line."
branch map explorer-2 "$FAST" "..."
dwait
grep -L '^STATUS: OK' "$run"/*.md
```

`dstart <slug> <description> <phase>...` names every phase up front, in the
order the panel lists them. `branch <phase> <name> <model> <task>` seeds and
launches one branch. `dwait` publishes the run and waits for all of them.

`<slug>`, phase names and branch names must all match `^[a-z0-9][a-z0-9._-]*$`:
they become filenames. A duplicate `<phase>-<name>` is refused rather than
silently sharing one state file with another branch.

Every branch defaults to `$FAST`. Use `$PI_PROVIDER/$PI_MODEL` when the user
asks for the smart tier or the same model, or any `provider/id` from `/model`
when they name one.

## Read

Read `$run/*.md`. The `grep -L` line lists branches that did not report
`STATUS: OK` (PARTIAL, NEED_STRONGER, ASKING, or a malformed answer). Re-run
each PARTIAL or NEED_STRONGER one with the same task on
`$PI_PROVIDER/$PI_MODEL`. A missing STATUS line is NEED_STRONGER, never
success. Check FILES paths with `ls` before relying on them.

`STATUS: ASKING` means the branch stopped on a decision, with `QUESTION:` and
`OPTIONS:` lines. Answer it yourself from this conversation when you can;
only when the user alone can decide, ask them with `ask_user_question` first.
Then continue the branch in its own session and read the new report:

```bash
. <skill dir>/run.sh
dresume "$run" <stem> "<answer>"   # one per asking branch
wait; cat "$run/<stem>.md"
```

A second wave is a second batch of `branch` calls on the next phase name
followed by another `dwait`, in the same bash call.

## Rules

- Branches are read-only (`--tools read,grep,find,ls`). Add `bash` only for
  a test-and-report branch. Work that must edit files stays in this session.
- A branch given `bash` may source `run.sh` and fan out again. It joins THIS run
  directory instead of starting a rival one, keeps this branch's phase, and the
  panel draws its children indented under it. Two levels is the sensible limit.
- A branch that needs one more extension gets it explicitly, e.g.
  `-e $HOME/.pi/agent/npm/node_modules/pi-web-access-lean` for research —
  append it to `$LOAD` before the first `branch` call, because
  `--no-extensions` drops provider extensions too.
- 2 to 6 branches per run. Each task is self-contained: name the files or
  directory, say exactly what to return.
- `.pi-out/` is gitignored scratch. Follow-up to a branch: same `branch` call,
  a new name, new task text.
- Read `$run/<phase>-<name>.err` when a branch reports nothing; that is where
  a bad model id or a missing provider extension lands.

## Files

- `run.sh` — `dstart` / `branch` / `dwait` / `dresume`. Check: `bash run.check.sh`.
- `beacon.ts` — loaded into each branch with `-e`, writes its state file.
- `state.ts` — the on-disk schema and `readRun()`, which the panel imports.
  Check: `bun run state.check.ts`.
- `report.md` — the report contract, appended to every branch's system prompt.
- `delegate.env` — defaults for `$FAST`, `$LOAD` and `$DELEGATE_TIMEOUT`. The owner's
  own values go in `~/.pi/agent/delegate.env`, which is read after it.
