#!/usr/bin/env bash
# Proves the bash half without ever starting pi. A stub stands in for the binary, records the
# argv and the environment it was handed, and exits the way its task text asks; then every
# file the skill claims to write is checked for being real JSON with the right contents.
#
# Run it with:  bash run.check.sh
set -u

skill=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
cd "$work" || exit 1

fail() { echo "FAIL: $*" >&2; exit 1; }

cat > fake-pi <<'STUB'
#!/usr/bin/env bash
# Ignores every flag; the task is the last argument and decides how this branch ends.
for arg in "$@"; do task=$arg; done
printf '%s\n' "$PI_BRANCH_STATE" "$*" >> "$RECORD"
[ "$task" = boom ] && exit 3
[ "$task" = slow ] && exit 124
printf 'STATUS: OK\nSUMMARY: fake\nFILES: none\n'
STUB
chmod +x fake-pi

desc='A description with "quotes", a \ backslash
and a newline'

PI=$work/fake-pi
delegate_skill=$skill
export RECORD=$work/argv.log
. "$skill/run.sh"

dstart check "$desc" map design || fail "dstart"
branch map core-render "$FAST" ok || fail "first branch"
branch map broken "$FAST" boom || fail "second branch"
branch map slow "$FAST" slow || fail "third branch"
branch design review "$FAST" ok || fail "fourth branch"
branch map core-render "$FAST" again 2>/dev/null && fail "duplicate branch name was accepted"
dwait

[ -f "$run/run.json" ] || fail "run.json missing"
node -e 'const fs=require("fs");for(const p of process.argv.slice(1))JSON.parse(fs.readFileSync(p,"utf8"))' \
    "$run/run.json" "$run"/state/*.json || fail "a seed or run.json is not valid JSON"

node -e '
const fs = require("fs");
const run = JSON.parse(fs.readFileSync(process.argv[1] + "/run.json", "utf8"));
const want = process.argv[2].replace(/[\n\r\t]/g, "");
if (run.description !== want) throw new Error("description mangled: " + JSON.stringify(run.description));
if (run.phases.join(",") !== "map,design") throw new Error("phases: " + run.phases);
if (!/^\d+$/.test(String(run.startedAt))) throw new Error("startedAt: " + run.startedAt);
const seed = (stem) => JSON.parse(fs.readFileSync(process.argv[1] + "/state/" + stem + ".json", "utf8"));
const order = ["map-core-render", "map-broken", "map-slow", "design-review"];
order.forEach((stem, i) => {
    const s = seed(stem);
    if (s.index !== i + 1) throw new Error(stem + " index " + s.index + ", expected " + (i + 1));
    if (s.status !== "starting" || s.pid !== null || s.tokens !== null || s.parent !== null) throw new Error(stem + " seed fields");
    if (s.activity !== "Starting") throw new Error(stem + " activity");
});
' "$run" "$desc" || fail "run.json or a seed has the wrong contents"

for pair in map-core-render:0 map-broken:3 map-slow:124 design-review:0; do
    stem=${pair%%:*}; want=${pair##*:}
    got=$(cat "$run/state/$stem.exit" 2>/dev/null)
    [ "$got" = "$want" ] || fail "$stem exited $got, expected $want"
done

# The failure this guards is silent from the panel's side: a branch launched without the
# beacon writes nothing and sits at "starting" until it exits.
grep -q -- "-e .*beacon\.ts" "$RECORD" || fail "the beacon was not passed to the branch"
grep -q -- "--session-dir .*/sessions/map-core-render" "$RECORD" || fail "the branch session is not kept per branch"
grep -q -- "--tools read,grep,find,ls" "$RECORD" || fail "the read-only tool list was dropped"
grep -q "map-core-render\.json" "$RECORD" || fail "PI_BRANCH_STATE did not reach the branch"
[ "$(grep -c "state" "$RECORD")" -ge 4 ] || fail "a branch ran without a state path"

# A branch that fans out again: same environment run.sh hands its children, in a subshell so
# the outer run's variables are untouched. It must join the run above it rather than start a
# rival one, or the panel draws two runs and nests neither.
parent_run=$run
(
    export PI_BRANCH_RUN="$parent_run" PI_BRANCH_PARENT="map-core-render" PI_BRANCH_PHASE="map"
    . "$skill/run.sh"
    dstart nested "a nested run" other || exit 1
    [ "$run" = "$parent_run" ] || exit 2
    branch design child "$FAST" ok || exit 3
    dwait
) || fail "the nested run did not join its parent (code $?)"

[ -f "$run/state/map-child.json" ] || fail "the nested branch did not land in its parent's phase"
node -e '
const fs = require("fs");
const child = JSON.parse(fs.readFileSync(process.argv[1] + "/state/map-child.json", "utf8"));
if (child.parent !== "map-core-render") throw new Error("parent link: " + child.parent);
if (child.phase !== "map") throw new Error("phase: " + child.phase);
const run = JSON.parse(fs.readFileSync(process.argv[1] + "/run.json", "utf8"));
if (run.name !== "check") throw new Error("a nested run overwrote run.json: " + run.name);
' "$run" || fail "the nested branch is not nested under its parent"

# A finished branch continued with an answer: same state file, same session dir, --continue,
# the answer as the message, and a fresh exit code. A beacon-written row is what dresume resets.
node -e '
const fs = require("fs"); const p = process.argv[1] + "/state/map-broken.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
fs.writeFileSync(p, JSON.stringify({ ...s, pid: 4242, status: "done", report: "ASKING", activity: "Asking: \"which\" one?" }));
' "$run"
dresume "$run" map-broken "use the second" || fail "dresume refused a finished branch"
wait
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1] + "/state/map-broken.json", "utf8"));
if (s.status !== "starting" || s.pid !== null || s.report !== null || s.activity !== "Resuming") throw new Error(JSON.stringify(s));
' "$run" || fail "dresume did not reset the row"
[ "$(cat "$run/state/map-broken.exit")" = 0 ] || fail "dresume did not write a new exit code"
grep -q -- "--session-dir .*/sessions/map-broken --continue" "$RECORD" || fail "dresume did not continue the branch session"
grep -q -- "-- use the second$" "$RECORD" || fail "dresume did not pass the answer as the message"
grep -q "^STATUS: OK" "$run/map-broken.md" || fail "dresume did not write the new report"
dresume "$run" nope "x" 2>/dev/null && fail "dresume accepted an unknown branch"

rm -rf "$work"
echo "run.check.sh ok"
