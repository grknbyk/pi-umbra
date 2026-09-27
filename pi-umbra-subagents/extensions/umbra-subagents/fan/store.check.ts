// The one runnable check for the producer's spawning half. It runs real child processes —
// a nine-line stub standing in for pi — because everything worth getting wrong here is a
// process fact: does phase two wait for phase one, does a killed branch actually die, does a
// branch that ignores the clock get cut off at the timeout, and does the run directory say
// so afterwards. None of that is observable in a mocked spawn.
//
// Run it with:  bun run store.check.ts     (or: node --experimental-strip-types store.check.ts)
// It never starts pi: PI_BIN points at the stub, and the stub is the only thing spawned.

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fan-check-"));

// A branch that appends its task to one shared file, so the ORDER phases ran in is a fact on
// disk rather than a guess from timestamps. "hang" never exits, which is how the stop and the
// timeout paths get something real to kill.
const stub = join(root, "fake-pi.mjs");
writeFileSync(
    stub,
    [
        'import { appendFileSync } from "node:fs";',
        "const task = process.argv[process.argv.length - 1];",
        'if (process.env.FAN_CHECK_ORDER) appendFileSync(process.env.FAN_CHECK_ORDER, `${task}\\n`);',
        'if (task === "hang") setInterval(() => {}, 1000);',
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
assert.deepEqual(readFileSync(order, "utf8").trim().split("\n"), ["alpha", "beta", "gamma"], "phase two waits for phase one");
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

store.stopAll();
console.log("store.check.ts ok");
