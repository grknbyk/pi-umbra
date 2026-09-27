#!/usr/bin/env bash
# The mechanical half of the delegate skill: seed one state file per branch BEFORE the
# process exists, then launch that branch with the beacon attached to it.
#
# It is a sourced file rather than a block pasted into SKILL.md for two reasons. PI_BRANCH_STATE
# and `-e beacon.ts` have to travel together — a caller who copies one and forgets the other
# gets a run where every row sits at "starting" forever — and the check drives exactly the
# code the skill runs instead of a copy of it that drifts.
#
# Usage, from the SESSION cwd, before any `cd`:
#   . <this skill's directory>/run.sh
#   dstart <slug> "<one-line description>" <phase>...
#   branch <phase> <name> <model> "<task>"      # repeat, 2 to 6 per run
#   dwait                                       # writes run.json, then waits

# The directory this file is in, wherever the skill was installed. A caller may still set it.
delegate_skill=${delegate_skill:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}

# The packaged defaults, then the owner's own settings, which win: $FAST, $LOAD and
# $DELEGATE_TIMEOUT belong to the machine, not to the skill.
dconfig() {
    . "$delegate_skill/delegate.env"
    local own="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/delegate.env"
    [ -f "$own" ] && . "$own"
    return 0
}
# Only the check ever overrides this; it swaps in a stub so the whole block can run without pi.
PI=${PI:-pi}

# MSYS rewrites path-looking *arguments* on the way into a native Windows exe but never
# rewrites environment variables, so PI_BRANCH_STATE would reach node as "/c/Users/..." and
# fail every read. cygpath -m gives "C:/Users/..." instead. Absent off Windows, hence the
# fallback.
native() {
    if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# `timeout <seconds> cmd...`. Stock macOS has no timeout (Homebrew coreutils names it
# gtimeout); with neither, the branch runs without the cap rather than not at all.
dtimeout() {
    if command -v timeout >/dev/null 2>&1; then timeout "$@"
    elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"
    else shift; "$@"; fi
}

# The pid the panel checks for liveness. Under Git Bash $$ is an MSYS pid, which the Windows
# process table knows nothing about; /proc/<pid>/winpid holds the real one there.
dpid() {
    cat "/proc/$$/winpid" 2>/dev/null || printf '%s' "$$"
}

# The only free text in either file. Both name and description come from the model, so they
# are escaped rather than trusted; every other field is a constrained identifier or a number.
json() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r\t'
}

dstart() {   # slug  description  phase...
    d_slug=$1
    d_desc=$2
    shift 2
    d_phases=$(printf ',"%s"' "$@")
    d_phases="[${d_phases:1}]"
    # $PWD before the skill cd's anywhere: the panel watches the session cwd, so a run
    # computed after the cd would land in a directory nobody is looking at.
    d_cwd=$PWD
    # A branch that fans out again JOINS its parent's run instead of starting a rival one:
    # same directory, same state dir, same reader. That is the whole of the panel's `└`
    # nesting, and PI_BRANCH_RUN is exported to every child below, so it is set exactly when
    # this shell is running inside a branch.
    run=${PI_BRANCH_RUN:-"$PWD/.pi-out/$(date +%Y%m%d-%H%M%S)-$d_slug"}
    d_nested=${PI_BRANCH_RUN:+1}
    d_started=$(( $(date +%s) * 1000 ))
    d_index=0
    mkdir -p "$run/state" || return 1
    contract=$(cat "$delegate_skill/report.md")
    dconfig
}

branch() {   # phase  name  model  task
    # Inside a nested run the phase is the parent's: the sidebar lists the phases the
    # top-level run declared, and a child's work belongs to the phase its parent is in.
    local phase=${PI_BRANCH_PHASE:-$1}
    local stem="$phase-$2"
    local file="$run/state/$stem.json"
    # Two branches sharing a name would share a state file, and a file with two writers is the
    # one corruption this design cannot detect. A duplicate name is a caller bug, so it is
    # refused rather than auto-renamed.
    [ -e "$file" ] && { echo "delegate: duplicate branch $stem" >&2; return 1; }
    d_index=$(( d_index + 1 ))
    local parent=null
    [ -n "${PI_BRANCH_PARENT:-}" ] && parent="\"$PI_BRANCH_PARENT\""
    local now=$(( $(date +%s) * 1000 ))
    # Every field is populated here, so no column appears for the first time three seconds in
    # and reflows the row.
    cat > "$file" <<JSON
{"phase":"$phase","name":"$2","parent":$parent,"index":$d_index,"model":"$3","pid":null,
"status":"starting","activity":"Starting","tokens":null,
"startedAt":$now,"updatedAt":$now,"report":null,"error":null}
JSON
    # $LOAD is deliberately unquoted: it carries an `-e <path>` pair that has to word-split.
    # PI_BRANCH_PARENT, PI_BRANCH_RUN and PI_BRANCH_PHASE are set for the CHILD, so a branch
    # given `bash` that sources this file again lands in this run directory, under this row.
    # PI_BRANCH_RUN stays an MSYS path: its only reader is bash inside the branch.
    # stdin is /dev/null because `pi -p` waits on an open stdin pipe until it closes.
    ( PI_BRANCH_STATE=$(native "$file") PI_BRANCH_PARENT="$stem" \
        PI_BRANCH_RUN="$run" PI_BRANCH_PHASE="$phase" \
        dtimeout "${DELEGATE_TIMEOUT:-300}" "$PI" -p --session-dir "$(native "$run/sessions/$stem")" --no-skills --no-extensions $LOAD \
            -e "$(native "$delegate_skill/beacon.ts")" \
            --tools "${DELEGATE_TOOLS:-read,grep,find,ls}" --model "$3" --append-system-prompt "$contract" "$4" \
            < /dev/null > "$run/$stem.md" 2> "$run/$stem.err"
      # The one signal that survives a branch dying before its extensions ever bound, and the
      # only place a `timeout` (124) can be told apart from a crash.
      printf '%s' "$?" > "$run/state/$stem.exit" ) &

    # After the seed, so the directory is never half-built when the panel first reads it.
    write_run_json
}

# The panel treats a missing run.json as "no run", so this file is what makes a run visible at
# all. It is written after the first seed exists — never before, or a half-built directory
# would render — and rewritten by every later `branch`, which costs one tiny write and removes
# the failure this had in real use: a caller who ran `dstart` and `branch` but forgot `dwait`
# got working reports and a panel that never showed the run, with nothing saying why.
#
# A nested run never writes it: the file belongs to the top-level run, and overwriting it would
# rename the run and drop the phases the sidebar is drawing.
write_run_json() {
    [ -n "$d_nested" ] && return 0
    cat > "$run/run.json" <<JSON
{"name":"$(json "$d_slug")","description":"$(json "$d_desc")","cwd":"$(json "$(native "$d_cwd")")","startedAt":$d_started,"phases":$d_phases,"pid":$(dpid)}
JSON
}

dwait() {
    write_run_json
    wait
}

# A branch that ended on STATUS: ASKING keeps its session under $run/sessions/<stem>, so the
# answer is simply its next message: `--continue` reopens that session on the same model.
# Any finished branch can be continued this way, not only an asking one.
dresume() {   # run  stem  answer
    run=$1
    local stem=$2
    local file="$run/state/$stem.json"
    [ -f "$file" ] || { echo "delegate: no branch $stem in $run" >&2; return 1; }
    [ -e "$run/state/$stem.exit" ] || { echo "delegate: $stem is still running" >&2; return 1; }
    # Joining an existing run: its run.json belongs to whoever started it, so a later dwait in
    # this shell must not rewrite it.
    d_nested=${d_nested-1}
    contract=$(cat "$delegate_skill/report.md")
    dconfig
    local phase
    phase=$(sed -n 's/.*"phase":"\([^"]*\)".*/\1/p' "$file")
    # Back to a live row before the process exists, the same order the seed uses. The beacon
    # writes the pid and the rest at session_start.
    rm "$run/state/$stem.exit"
    # No `sed -i`: BSD sed reads the -E after it as a backup suffix.
    sed -E 's/"status":"[a-z]+"/"status":"starting"/; s/"pid":[0-9]+/"pid":null/;
        s/"report":("[A-Z_]+"|null)/"report":null/; s/"activity":"(\\.|[^"\\])*"/"activity":"Resuming"/' "$file" > "$file.tmp" &&
        mv "$file.tmp" "$file"
    ( PI_BRANCH_STATE=$(native "$file") PI_BRANCH_PARENT="$stem" \
        PI_BRANCH_RUN="$run" PI_BRANCH_PHASE="$phase" \
        dtimeout "${DELEGATE_TIMEOUT:-300}" "$PI" -p --session-dir "$(native "$run/sessions/$stem")" --continue \
            --no-skills --no-extensions $LOAD -e "$(native "$delegate_skill/beacon.ts")" \
            --tools "${DELEGATE_TOOLS:-read,grep,find,ls}" --append-system-prompt "$contract" -- "$3" \
            < /dev/null > "$run/$stem.md" 2>> "$run/$stem.err"
      printf '%s' "$?" > "$run/state/$stem.exit" ) &
}
