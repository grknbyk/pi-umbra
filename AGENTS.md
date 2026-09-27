# pi-umbra

## What runs it

- Each `pi-umbra-*` folder is one npm package; `pi-umbra/` is the meta package that bundles them.
- The source of truth is `~/.pi/agent/extensions` (and `~/.agents/skills/{delegate,fan}`). Edit there,
  then `node sync.mjs` copies into the package folders; `node sync.mjs --check` must say every package
  matches. `sync.mjs` never writes READMEs, `package.json` or `patch.mjs`: edit those here.

## Do not touch

- Line endings: the root `README.md`, `pi-umbra/README.md`, every `package.json` and every `patch.mjs`
  are CRLF. An editor or script that writes LF turns a few-line change into hundreds of lines of diff.
  Check with `git ls-files --eol | grep i/crlf | grep -v w/crlf` (must print nothing).
- Commits show only grknbyk (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`), no co-author lines. GitHub keeps one
  commit: amend and push with `--force-with-lease`.
- Publish order: the packages first, then the meta package once the registry serves them (it bundles
  whatever is in its `node_modules`).

## How to verify a change

- Every package's checks: `bun run <file>` for each `checks/*.check.ts`, and in
  `pi-umbra-subagents/extensions/umbra-subagents`: `bar.check.ts`, `panel.check.ts`, `fan/store.check.ts`,
  `fan/spec.ts`, `skills/delegate/state.check.ts`, `bash skills/delegate/run.check.sh`.
  `umbra-toolbox.check.ts` needs shiki, so run it from `~/.pi/agent/extensions/checks`.
- Bundle patches: `node pi-umbra-<pkg>/patch.mjs --check` for shimmer and subagents.
- Install: `NPM="bunx npm@11" node scripts/smoke.mjs`.

## Burns

- A check that stubs a pi or TUI method by name keeps passing after pi renames it: pi 1.0 renamed
  `queryTerminalBackgroundColor` and umbra-background crashed pi at start while its check was green.
  When pi updates, run `bash ~/.pi/agent/after-update.sh`, whose typecheck catches the rename.
- pi 1.0.1 only runs a skill typed as `/skill:<name>`; a bare `/huh` from the menu goes to the model
  as plain text. pi-umbra-skill-matcher made its menu offer `/huh` and was retired for it
  (2026-10-04): never rename pi's own `skill:` rows.
- `git apply` run from a subfolder silently skips every path outside it and exits 0. Run git commands
  that take repo paths with `git -C <root>`.
