---
name: fan
description: Fan independent work out to parallel pi branches and watch them live in the agent tree. Branches are read-only unless marked [write]. Use whenever a task splits into 2+ lookups that do not need each other, or when the user writes "fan", "delegate", "subagent", or "in parallel".
---

# Fan

There is no subagent tool and nothing is added to this prompt. A branch is a
separate `pi -p` process the fan extension spawns and owns; each one writes a
small live state file, so the agent tree under the input box shows what every branch
is doing while it does it, not only what it concluded.

## Run

Write one fenced `fan` block at the end of your message and stop. The extension
starts the branches when the message ends, and the answers arrive as a follow-up
message at the top of the next turn. Do not run bash for this, and do not write
anything after the block.

````
```fan
name: toolcall-render
desc: Map how pi renders tool calls
# Map
core-render: Read <paths> and report where a tool call becomes lines. Cite file:line.
omp-intercept: Check whether an extension can override it. Cite file:line.
# Design
proposal: Given the Map results, write the design.
```
````

- `name` and `desc` are the panel header. `# Title` starts a phase.
- `label: task` is one branch. Phases run in order; branches inside a phase run
  at the same time. Use a second phase only when it genuinely needs the first
  phase's answers.
- `label@provider/model: task` picks a model for that branch. Without it a
  branch runs on this session's model.
- `label [write]: task` (or `label@model [write]: task`) lets that branch edit
  files and run commands, in its own git worktree on a new `fan/<run>/<branch>`
  branch. See Write branches below.
- 2 to 6 branches per phase. Each task names the files or directory and says
  exactly what to return.

## Rules

- Branches are read-only by default: `read`, `grep`, `find`, `ls`, nothing else.
  Work that edits files stays in this session, unless the user asked for
  parallel implementation; then use `[write]`.
- A branch has an empty context. Repeating what you already know in the task
  text is the only way it learns it.
- One run at a time. A second block while a run is live is ignored.
- Every branch writes its answer to `.pi-out/<run>/<phase>-<name>.md` as it goes,
  and its errors to the matching `.err`. Quitting pi kills the branches, but what
  they had already written stays on disk. `.pi-out/` is gitignored scratch.
- A branch gets 5 minutes and is then cut off, so one wedged branch cannot
  hold the run open. Keep each task small enough to finish in that time.

## Write branches

- Use `[write]` only when the user wants work done in parallel and each branch's
  change is independent. Most runs stay read-only.
- The worktree starts from the user's working tree, uncommitted work included,
  and only works inside a git repository; outside one the run does not start.
- A write branch gets `edit`, `write` and `bash`. It must not push, publish or
  commit; its changes are committed to its branch when it ends, and its row
  shows `Changed +N −M · K files on fan/...`.
- Nothing is merged. When the results arrive, ask the user, one question per
  branch, whether to merge it, and only then run the command the follow-up gives.
- A write branch cannot stop on a question: its worktree closes when it ends.
  Put every decision it needs in its task.
- Every write branch starts from the same snapshot, taken when the run starts:
  a later phase does not see an earlier phase's changes. Work that builds on
  another branch's change waits for that change to be merged, in a new run.
