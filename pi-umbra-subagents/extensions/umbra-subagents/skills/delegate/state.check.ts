// The one runnable check for the producer. It builds a run directory by hand — two runs, a
// half-built third, a nested branch, a timeout, a torn file and a leftover .tmp — and asserts
// what the panel reads back out of it. It exists as a separate file so state.ts, which the
// panel imports on every tick, never carries node:assert or a tmpdir fixture with it.
//
// Run it with:  bun run state.check.ts     (or: node --experimental-strip-types state.check.ts)
// It never starts pi.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import beacon, { describe } from "./beacon.ts";
import { type BranchState, readRun } from "./state.ts";

const NOW = 1_700_000_000_000;
// Pids on Windows are small multiples of 4, so this one has never existed and process.kill
// answers ESRCH for it. Verified on this machine before it was written down.
const DEAD = 2_147_483_644;

const seed = (stateDir: string, over: Partial<BranchState> & Pick<BranchState, "phase" | "name" | "index">) => {
    const state: BranchState = {
        parent: null,
        model: "commandcode/minimax/minimax-m3-free",
        pid: null,
        status: "starting",
        activity: "Starting",
        tokens: null,
        startedAt: NOW - 195_000,
        updatedAt: NOW - 195_000,
        report: null,
        error: null,
        ...over,
    };
    writeFileSync(join(stateDir, `${state.phase}-${state.name}.json`), JSON.stringify(state));
};

const run = (dir: string, name: string, phases: string[]) =>
    writeFileSync(
        join(dir, "run.json"),
        JSON.stringify({ name, description: "Map how pi renders tool calls", cwd: dir, startedAt: NOW - 196_000, phases }),
    );

const cwd = mkdtempSync(join(tmpdir(), "delegate-check-"));
assert.equal(readRun(cwd, NOW), undefined, "no .pi-out at all is not a run");

const older = join(cwd, ".pi-out", "20260101-000000-older");
const newest = join(cwd, ".pi-out", "20260101-010000-newest");
const building = join(cwd, ".pi-out", "20260101-020000-building");
for (const dir of [older, newest, building]) mkdirSync(join(dir, "state"), { recursive: true });

run(older, "older", ["map"]);
seed(join(older, "state"), { phase: "map", name: "leftover", index: 1 });

run(newest, "newest", ["map", "design"]);
const state = join(newest, "state");
seed(state, { phase: "map", name: "core-render", index: 1, pid: process.pid, status: "running", tokens: 72_700, updatedAt: NOW - 53_000 });
seed(state, { phase: "map", name: "omp-intercept", index: 2, pid: DEAD, status: "running", tokens: 89_600 });
seed(state, { phase: "design", name: "review", index: 3, parent: "map-core-render" });
seed(state, { phase: "map", name: "flicker", index: 4, pid: process.pid, status: "running" });
writeFileSync(join(state, "map-flicker.exit"), "124");
// Neither of these may ever become a row: one is a file we did not write, the other is the
// unfinished half of a tmp + rename.
writeFileSync(join(state, "map-broken.json"), "{oops");
writeFileSync(join(state, "map-core-render.json.tmp"), "{");

// The newest directory has no run.json yet, so the panel must fall through to the newest
// complete run rather than blanking for a frame.
seed(join(building, "state"), { phase: "map", name: "unseen", index: 1 });

const view = readRun(cwd, NOW);
assert.ok(view, "a complete run directory is a run");
assert.equal(view.name, "newest", "newest run by name, never by mtime, and never a half-built one");
assert.deepEqual(
    view.branches.map((branch) => `${branch.stem}@${branch.depth}`),
    ["map-core-render@0", "design-review@1", "map-omp-intercept@0", "map-flicker@0"],
    "parents immediately above their children, siblings by launch index",
);
assert.equal(view.branches[0]?.label, "map:core-render", "the colon is a render-time join");
assert.equal(view.total, 4, "the torn file and the .tmp are not rows");
// core-render is alive (our own pid), review has not booted yet; omp-intercept's pid is gone
// and flicker has an exit file, so both are finished without ever saying so themselves.
assert.equal(view.done, 2, "a dead pid and an exit file both settle a branch that still reads 'running'");
assert.equal(view.branches[1]?.settled, false, "a seeded branch with no pid yet is pending, not done");
assert.equal(view.branches[3]?.timedOut, true, "exit code 124 is a timeout, not a crash");
assert.equal(view.tokens, 162_300, "null token counts contribute nothing rather than a fake 0");
assert.equal(view.branches[0]?.idleMs, 53_000, "idle is measured from updatedAt");
assert.equal(view.activePhase, 0, "the first phase still holding an unsettled branch");
assert.equal(view.live, true);

// Finish the map phase and the sidebar marker has to move on by itself.
seed(state, { phase: "map", name: "core-render", index: 1, pid: DEAD, status: "done", report: "OK", tokens: 72_700 });
const advanced = readRun(cwd, NOW);
assert.equal(advanced?.activePhase, 1, "the marker follows the first unsettled phase");
assert.equal(advanced?.done, 3);
assert.equal(advanced?.live, true, "the nested branch is still pending");

assert.equal(describe("read", { path: "src/hooks.server.ts" }), "Reading hooks.server.ts");
assert.equal(describe("grep", { pattern: "localStorage", path: "src/lib/office-persist.ts" }), "Grepping localStorage in office-persist.ts");
assert.equal(describe("grep", { pattern: "localStorage", glob: "**/*.ts" }), "Grepping localStorage in **/*.ts");
assert.equal(describe("grep", { pattern: "x".repeat(50) }), `Grepping ${"x".repeat(31)}…`, "a runaway pattern cannot widen the row");
assert.equal(describe("find", { pattern: "**/*.svelte" }), "Finding **/*.svelte");
assert.equal(describe("ls", {}), "Listing .", "a default argument still reads as a sentence");
assert.equal(describe("bash", { command: "npm test -- --run" }), "Running npm");
assert.equal(describe("read", {}), "read", "a missing argument falls back to the tool name");
assert.equal(describe("web_search", { query: "pi extension api" }), "web_search pi extension api", "an unknown tool still names its subject");
assert.equal(describe("edit", { file_path: "src/lib/office-persist.ts" }), "edit office-persist.ts", "a path-shaped argument shows as its basename");
assert.equal(describe("web_search", {}), "web_search", "an unknown tool with nothing readable is named, not narrated");

// The beacon itself, driven by hand. Two tool calls overlap and the older one outlives the
// newer: clearing the sentence on the first `end` is the bug this asserts against, because it
// leaves the row reading "Thinking" while the branch is still mid-grep.
const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
const branchFile = join(cwd, "branch.json");
seed(cwd, { phase: "map", name: "beacon", index: 1 });
writeFileSync(branchFile, readFileSync(join(cwd, "map-beacon.json"), "utf8"));
process.env.PI_BRANCH_STATE = branchFile;
// SAFETY: the beacon only ever calls pi.on, so this is the whole surface it uses.
beacon({ on: (event: string, handler: (e: unknown, c: unknown) => void) => handlers.set(event, handler) } as never);
const fire = (event: string, payload: unknown, ctx: unknown = {}) => handlers.get(event)?.(payload, ctx);

fire("session_start", {}, { model: { name: "Opus 5" } });
fire("tool_execution_start", { toolCallId: "a", toolName: "grep", args: { pattern: "localStorage", path: "src/lib/office-persist.ts" } });
fire("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "src/hooks.server.ts" } });
fire("tool_execution_end", { toolCallId: "b", toolName: "read" });
// Tool writes are coalesced at 100 ms, so the row is read after that window rather than inside it.
await new Promise((resolve) => setTimeout(resolve, 200));
const live = JSON.parse(readFileSync(branchFile, "utf8")) as BranchState;
assert.equal(live.pid, process.pid, "the pid is pi's own, not the launching shell's");
assert.equal(live.model, "Opus 5", "session_start replaces the requested id with the display name");
assert.equal(live.activity, "Grepping localStorage in office-persist.ts", "an end clears its own call, never the row");

fire("tool_execution_end", { toolCallId: "a", toolName: "grep" });
await new Promise((resolve) => setTimeout(resolve, 200));
assert.equal((JSON.parse(readFileSync(branchFile, "utf8")) as BranchState).activity, "Thinking", "with nothing running the row says so");

console.log("state.check.ts ok");
