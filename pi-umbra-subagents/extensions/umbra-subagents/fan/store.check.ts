// The one runnable check for the producer's spawning half. It runs real child processes —
// a nine-line stub standing in for pi — because everything worth getting wrong here is a
// process fact: does phase two wait for phase one, does a killed branch actually die, does a
// branch that ignores the clock get cut off at the timeout, and does the run directory say
// so afterwards. None of that is observable in a mocked spawn.
//
// Run it with:  bun run store.check.ts     (or: node --experimental-strip-types store.check.ts)
// It never starts pi: PI_BIN points at the stub, and the stub is the only thing spawned.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fan-check-"));

// A branch that appends its task to one shared file, so the ORDER phases ran in is a fact on
// disk rather than a guess from timestamps. "hang" never exits, which is how the stop and the
// timeout paths get something real to kill.
const stub = join(root, "fake-pi.mjs");
writeFileSync(
    stub,
    [
        'import { execFileSync } from "node:child_process";',
        'import { appendFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const task = process.argv[process.argv.length - 1];",
        'if (process.env.FAN_CHECK_ORDER) appendFileSync(process.env.FAN_CHECK_ORDER, `${task}\\n`);',
        'if (task === "hang") setInterval(() => {}, 1000);',
        // A write branch's edits: two in its cwd, which must be the session's folder inside its
        // worktree, one binary, and one at the worktree's root, outside that folder.
        'else if (task === "edit") {',
        '  writeFileSync("edited.txt", "from the branch\\n");',
        '  writeFileSync("logo.bin", Buffer.from([0, 255, 0, 10, 13, 0]));',
        '  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();',
        '  appendFileSync(join(top, "a.txt"), "three\\n");',
        "}",
        'else process.stdout.write(`report for ${task}\\nSTATUS: OK\\n`);',
        "",
    ].join("\n"),
);

process.env.PI_BIN = stub;
// Read once at module load, so it has to be set before the import below. Longer than the whole
// kill ladder, or the stop below would be recorded as a timeout instead of a stop.
process.env.FAN_TIMEOUT_MS = "4000";
process.env.FAN_LOAD = "";

const { reportOf, store } = await import("./store.ts");
const { readRun } = await import("../skills/delegate/state.ts");
const { mergeCommand } = await import("./worktree.ts");

// A throw inside a child-process listener never reaches an assert; it is counted here instead.
const uncaught: string[] = [];
process.on("uncaughtException", (error) => uncaught.push(String(error)));
// A promise chain that stalls lets the loop drain and bun exit 0 without a word.
let completed = false;
process.on("exit", () => {
    if (completed) return;
    console.error("store.check.ts did not finish");
    process.exitCode = 1;
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (label: string, ready: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await delay(25);
    }
};

const phase = (title: string, branches: { label: string; task: string }[]) => ({
    title,
    branches: branches.map((branch) => ({ ...branch, model: "stub/one" })),
});

// ---------- phases run in order, and the run directory is complete before it is read ----------

const runCwd = mkdtempSync(join(tmpdir(), "fan-run-"));
const order = join(runCwd, "order.txt");
writeFileSync(order, "");
process.env.FAN_CHECK_ORDER = order;

// Verbatim, including the blank line and the colon — the two things a paraphrase loses first.
const BRIEF = ["Map how pi renders tool calls.", "", "The part a task line cannot carry: colon: in it, and a second paragraph."].join("\n");

const dir = store.start(
    { name: "toolcall render", description: "Map how pi renders tool calls", phases: [
        phase("Map", [{ label: "core-render", task: "alpha" }, { label: "omp-intercept", task: "beta" }]),
        phase("Design", [{ label: "proposal", task: "gamma" }]),
    ] },
    "stub/default",
    runCwd,
    BRIEF,
);
assert.ok(dir, "start returns the run directory it owns");

// The brief goes to disk untouched: no model in the path, so the bytes out are the bytes in.
assert.equal(existsSync(join(dir as string, "brief.md")), true, "the run wrote a brief.md");
assert.equal(readFileSync(join(dir as string, "brief.md"), "utf8"), BRIEF, "brief.md is byte-for-byte");

// Seeded whole, before anything is spawned: the M in "N/M agents" is final in frame one.
const seeded = readRun(runCwd);
assert.equal(seeded?.total, 3, "every branch of every phase is seeded up front");
assert.equal(seeded?.done, 0, "nothing is settled before it has run");
assert.deepEqual(
    seeded?.branches.map((branch) => branch.stem),
    ["map-core-render", "map-omp-intercept", "design-proposal"],
    "stems are phase-name, slugged, in launch order",
);
assert.equal(seeded?.branches[0]?.label, "map:core-render", "the colon is a render-time join");
assert.equal(seeded?.branches[0]?.model, "One", "the seed carries a display model until the beacon replaces it");
assert.equal(seeded?.name, "toolcall render", "the run name is the spec's, not the slug");

await until("the run to finish", () => {
    store.refresh(runCwd);
    return store.run()?.live === false;
});

const finished = store.run();
assert.equal(finished?.done, 3, "every branch settles");
// The two phase-one branches race each other; only gamma's place is a fact.
const ran = readFileSync(order, "utf8").trim().split("\n");
assert.deepEqual([...ran.slice(0, 2).sort(), ran[2]], ["alpha", "beta", "gamma"], "phase two waits for phase one");
assert.equal(readFileSync(join(dir, "state", "map-core-render.exit"), "utf8"), "0", "a clean exit is recorded as 0");
assert.equal(finished?.branches.every((branch) => !branch.timedOut), true, "nothing timed out");
assert.match(reportOf(finished!), /report for alpha[\s\S]*report for gamma/, "the reports are read back in launch order");

// ---------- a branch that will not exit is killed, and the row never lies about it ----------

const stopCwd = mkdtempSync(join(tmpdir(), "fan-stop-"));
delete process.env.FAN_CHECK_ORDER;
store.start(
    { name: "stop", description: "", phases: [phase("Map", [{ label: "stuck", task: "hang" }]), phase("Design", [{ label: "later", task: "hang" }])] },
    "stub/one",
    stopCwd,
);
store.refresh(stopCwd);
assert.equal(store.run()?.branches[0]?.settled, false, "a live branch is not settled");

// A branch of a later phase is stopped before it starts: out of the queue, read as stopped,
// and never launched when the phase before it ends.
assert.equal(await store.stop("design-later"), true);

const killed = await store.stop("map-stuck");
assert.equal(killed, true, "the kill ladder reports what actually happened to the process");
store.refresh(stopCwd);
const stopped = store.run()?.branches[0];
assert.equal(stopped?.settled, true, "a killed branch settles");
assert.equal(stopped?.alive, false);
assert.notEqual(stopped?.exitCode, 0, "a killed branch did not succeed");
assert.equal(stopped?.timedOut, false, "a user stop is not a timeout");
const later = store.run()?.branches.find((branch) => branch.stem === "design-later");
assert.equal(later?.pid, null, "a queued branch that was stopped never starts");
assert.equal(later?.exitCode, 130, "a queued branch that was stopped reads as stopped");
assert.equal(store.run()?.live, false, "with its last phase stopped, the run is over");

// ---------- the same branch left alone is cut off by the timeout, as 124 ----------

const slowCwd = mkdtempSync(join(tmpdir(), "fan-slow-"));
store.start({ name: "slow", description: "", phases: [phase("Map", [{ label: "stuck", task: "hang" }])] }, "stub/one", slowCwd);
await until(
    "the timeout to fire",
    () => {
        store.refresh(slowCwd);
        return store.run()?.live === false;
    },
    20_000,
);
assert.equal(store.run()?.branches[0]?.timedOut, true, "exit code 124 is a timeout, not a crash");
assert.equal(existsSync(join(slowCwd, ".pi-out")), true, "the run directory outlives the run");

// ---------- a [write] branch edits its own worktree, and its work waits on a git branch ----------

assert.throws(
    () => store.start({ name: "nogit", description: "", phases: [{ title: "Build", branches: [{ label: "fix", task: "edit", model: "stub/one", write: true }] }] }, "stub/one", mkdtempSync(join(tmpdir(), "fan-nogit-"))),
    /need a git repository/,
    "a write branch outside git refuses to start",
);

const repo = mkdtempSync(join(tmpdir(), "fan-write-"));
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q", "-b", "main");
git("config", "user.name", "check");
git("config", "user.email", "check@localhost");
writeFileSync(join(repo, "a.txt"), "one\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); // the user's uncommitted work
// What used to stop a write run before it started: an untracked nested repo, a symlink to a
// folder, a post-checkout hook that fails. And a post-commit hook that must never run.
execFileSync("git", ["init", "-q", join(repo, "vendor", "lib")]);
symlinkSync("vendor", join(repo, "link"));
writeFileSync(join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
writeFileSync(join(repo, ".git", "hooks", "post-commit"), `#!/bin/sh\ntouch '${repo}/hooked'\n`, { mode: 0o755 });
// The session sits in a folder no commit has, so no checkout has it either.
const session = join(repo, "newpkg");
mkdirSync(session);

const writeDir = store.start(
    {
        name: "write",
        description: "",
        phases: [
            { title: "Build", branches: [{ label: "fix", task: "edit", model: "stub/one", write: true }, { label: "look", task: "read", model: "stub/one" }] },
            // Dots in a label made a branch name git refuses.
            { title: "Later", branches: [{ label: "v1..lock", task: "edit", model: "stub/one", write: true }] },
        ],
    },
    "stub/one",
    session,
) as string;
const worktrees = join(repo, ".git", "fan-worktrees", basename(writeDir));
assert.ok(existsSync(join(worktrees, "later-v1-lock")), "every write branch gets its worktree at start, under .git");
assert.equal(await store.stop("later-v1-lock"), true);
assert.equal(existsSync(join(worktrees, "later-v1-lock")), false, "a stopped queued write branch drops its worktree");
await until("the write run to end", () => {
    store.refresh(session);
    return store.run()?.live === false;
});
const fix = store.run()?.branches.find((branch) => branch.stem === "build-fix")?.git;
assert.ok(fix && !fix.error, `the branch's work is committed: ${JSON.stringify(fix)}`);
assert.equal(fix.stat, "+2 −0 · 3 files", "the branch's own change only");
assert.equal(fix.root, repo);
assert.equal(existsSync(join(session, "edited.txt")), false, "the user's tree is untouched");
assert.equal(git("show", `${fix.branch}:newpkg/edited.txt`), "from the branch", "the branch worked in the session's folder");
assert.equal(git("show", `${fix.branch}:a.txt`), "one\ntwo\nthree", "the branch started from the uncommitted work");
assert.match(git("ls-tree", fix.base, "link"), /^120000 /, "a symlink stays a symlink");
assert.equal(existsSync(join(repo, "hooked")), false, "no hook ran");
assert.equal(existsSync(join(worktrees, "build-fix")), false, "a finished worktree is removed");
assert.doesNotMatch(git("status", "--porcelain"), /pi-out|fan-worktrees/, "neither the run nor the worktrees show in git status");
assert.equal(store.run()?.branches.find((branch) => branch.stem === "build-look")?.git, undefined, "a read-only branch has no git");
assert.equal(git("branch", "--list", "fan/*/later-*"), "", "the stopped one leaves no branch");
assert.ok(reportOf(store.run()!).includes(mergeCommand(fix)), "the report carries the merge command");

// The merge the session is offered, run where the session's bash runs: from the subfolder, over
// the user's own unstaged edit to the same file, with a binary file, staging nothing.
execFileSync("bash", ["-c", mergeCommand(fix)], { cwd: session, stdio: "pipe" });
assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\ntwo\nthree\n", "a change outside the subfolder lands on the user's edit");
assert.equal(readFileSync(join(session, "edited.txt"), "utf8"), "from the branch\n");
assert.deepEqual([...readFileSync(join(session, "logo.bin"))], [0, 255, 0, 10, 13, 0], "a binary change lands");
assert.equal(git("diff", "--cached", "--name-only"), "", "nothing is staged");
assert.equal(git("branch", "--list", fix.branch), "", "the merged branch is gone");

// A branch whose process never starts gets "error" and "close" both; its worktree is closed once.
process.env.PI_BIN = join(root, "missing-pi");
// The repo root, not the session folder: a run in the same second there would sort by name.
store.start({ name: "nospawn", description: "", phases: [{ title: "Build", branches: [{ label: "fix", task: "edit", model: "stub/one", write: true }] }] }, "stub/one", repo);
await until("the failed spawn to settle", () => {
    store.refresh(repo);
    return store.run()?.live === false;
});
// "close" comes a tick after "error"; give it the time to do damage.
await delay(300);
store.refresh(repo);
const failed = store.run()?.branches[0];
assert.equal(failed?.exitCode, 127, "a spawn that failed reads as 127");
assert.equal(failed?.git?.error, undefined, `a spawn that failed closes its worktree once: ${JSON.stringify(failed?.git)}`);
assert.deepEqual(uncaught, [], "nothing threw outside a handler: in pi that ends the process");
process.env.PI_BIN = stub;

store.stopAll();
completed = true;
console.log("store.check.ts ok");
