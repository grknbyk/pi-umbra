import { visibleWidth } from "@earendil-works/pi-tui";
import { MAX_ROWS, countsOf, layoutList, linesFor, renderKey, renderLines, stateOf, windowOf, type View } from "./bar/bar-line.ts";
import type { BranchView, RunState } from "./skills/delegate/state.ts";

// The widget sits directly above the input box, so two things can hurt and both are checked
// here rather than argued in a comment:
//
//   1. a composed line one column too wide wraps in the terminal and pushes the box down
//   2. the `❯` column, the tree guides or the key hint pushing a row past the width does the same
//
// Everything under test is pure, so this needs no terminal, no theme and no pi.
// Run with: bun run bar.check.ts

// A function declaration, not a const arrow: TypeScript only narrows past a never-returning
// call when it is declared this way, and every assertion below relies on that narrowing.
function fail(message: string): never {
	throw new Error(message);
}

// SAFETY: only the fields the layouts read are populated; every one of them is here.
const branch = (over: Partial<BranchView> = {}): BranchView =>
	({
		phase: "map",
		name: "general-purpose",
		parent: null,
		index: 1,
		model: "Opus 5",
		pid: 4242,
		status: "running",
		activity: "Grepping localStorage keys in office-persist.ts",
		tokens: 56_500,
		startedAt: 0,
		updatedAt: 232_000,
		report: null,
		error: null,
		stem: "map-general-purpose",
		label: "map:general-purpose",
		depth: 0,
		elapsedMs: 232_000, // 3m 52s
		idleMs: 0,
		exitCode: null,
		timedOut: false,
		alive: true,
		settled: false,
		...over,
	}) as BranchView;

const run = (over: Partial<RunState> = {}): RunState =>
	({
		dir: ".pi-out/20260905-030000",
		name: "pi-toolcall-render",
		description: "Map how pi renders tool calls and whether an extension can override it",
		startedAt: 0,
		phases: ["map", "design"],
		activePhase: 0,
		branches: [],
		done: 2,
		total: 4,
		tokens: 397_800,
		live: true,
		...over,
	}) as RunState;

const now = 278_000; // 4m 38s

// A finished run inside its linger window, and the same run once it has faded.
const settled = run({ live: false, done: 4, branches: [branch({ updatedAt: now, settled: true, alive: false })] });

// One phase: plain subagents, so the branches are the top level. `general-purpose` has one
// agent under it, which stays folded until enter opens it.
const flat = run({
	phases: ["map"],
	done: 0,
	total: 3,
	branches: [
		branch(),
		branch({
			name: "Explore",
			stem: "map-explore",
			label: "map:Explore",
			depth: 1,
			parent: "map-general-purpose",
			index: 2,
			activity: "Confirming store.ts is unused",
			tokens: 86_300,
			elapsedMs: 172_000, // 2m 52s
			idleMs: 20_000,
		}),
		branch({ name: "routes", stem: "map-routes", label: "map:routes", index: 3, activity: "Reading src/server.ts", settled: true, alive: false, status: "done", exitCode: 0 }),
	],
});

// Two phases: a workflow, one row named after the run, phases under it, branches under those.
const phased = run({
	branches: [
		branch(),
		branch({ phase: "design", name: "proposal", stem: "design-proposal", label: "design:proposal", activity: "Writing it up" }),
	],
});

const ink = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text }; // measure the plain frame
const typing: View = { picking: false, cursor: "main", open: [] };
const pick = (cursor: string, open: string[] = []): View => ({ picking: true, cursor, open });

// ---------- the tree ----------

const top = linesFor(flat, now, []);
if (top.map((line) => line.node.label).join() !== "general-purpose,routes") fail(`top level: ${top.map((line) => line.node.label)}`);
if (!top[0]?.folded || top[1]?.folded) fail("only a row with agents under it is folded");
const opened = linesFor(flat, now, ["b:map-general-purpose"]);
if (opened.map((line) => `${line.guide}${line.node.label}`).join() !== "general-purpose,└ Explore,routes") fail(`opened: ${opened.map((line) => line.guide + line.node.label)}`);
if (opened[1]?.path.join() !== "b:map-general-purpose") fail("a child's path is its parent");
// The open path is one path: an id that is not on it opens nothing.
if (linesFor(flat, now, ["b:map-routes"]).length !== 2) fail("a leaf in the open path grew rows");

const workflow = linesFor(phased, now, []);
if (workflow.length !== 1 || workflow[0]?.node.label !== "pi-toolcall-render") fail("a phased run is one workflow row");
const phases = linesFor(phased, now, ["r:.pi-out/20260905-030000", "p:design"]);
if (phases.map((line) => `${line.guide}${line.node.label}`).join() !== "pi-toolcall-render,├ Map,└ Design,  └ proposal") {
	fail(`workflow open: ${phases.map((line) => line.guide + line.node.label)}`);
}
if (!phases[1]?.folded) fail("the phase that is not on the open path stays folded");

// ---------- states and counts ----------

if (stateOf(branch()) !== "running") fail("a branch that just wrote is running");
if (stateOf(branch({ idleMs: 20_000 })) !== "idle") fail("a quiet branch is idle");
if (stateOf(branch({ settled: true, exitCode: 0, status: "done" })) !== "done") fail("a clean exit is done");
if (stateOf(branch({ settled: true, exitCode: 143 })) !== "stopped") fail("a killed branch is stopped");
if (stateOf(branch({ status: "error", settled: true })) !== "stopped") fail("a failed branch is stopped");
if (stateOf(branch({ pid: null, status: "starting" })) !== "waiting") fail("a branch with no process yet is waiting");
if (countsOf(flat.branches) !== "1 done · 1 running · 1 idle") fail(`counts: ${countsOf(flat.branches)}`);

// ---------- the window ----------

// The cursor is always inside, and the window plus its "more" rows never outgrow the room.
for (let n = 0; n <= 30; n++) {
	for (let room = 0; room <= 10; room++) {
		for (let at = 0; at < Math.max(1, n); at++) {
			const [first, end] = windowOf(n, at, room);
			if (n && room && (at < first || at >= end)) fail(`window ${n}/${room}/${at}: cursor outside [${first}, ${end})`);
			const arrows = room >= 3 ? Number(first > 0) + Number(end < n) : 0;
			if (end - first + arrows > room) fail(`window ${n}/${room}/${at}: ${end - first} rows + ${arrows} arrows over ${room}`);
			if (n > room && room >= 3 && end - first + arrows !== room) fail(`window ${n}/${room}/${at}: a row left empty`);
		}
	}
}

// ---------- the list ----------

for (let width = 8; width <= 200; width++) {
	for (const [state, view] of [
		[flat, typing],
		[flat, pick("b:map-explore", ["b:map-general-purpose"])],
		[phased, pick("p:design", ["r:.pi-out/20260905-030000", "p:design"])],
		[undefined, typing],
		[settled, typing],
	] as [typeof flat | undefined, View][]) {
		const rows = layoutList(width, state, now, MAX_ROWS, view);
		if (rows.length === 0) fail(`list width ${width}: zero rows un-mounts the widget`);
		for (const row of rows) {
			const used = visibleWidth(row.head) + visibleWidth(row.activity) + row.fill.length + visibleWidth(row.right);
			if (used !== width - 2) fail(`list width ${width}: row composed ${used}, expected ${width - 2}`);
		}
		// The activity column has to start in the same place on every row, or the sentences
		// stagger and the list stops being readable at a glance.
		const heads = new Set(rows.map((row) => visibleWidth(row.head)));
		if (heads.size !== 1) fail(`list width ${width}: ragged head column ${[...heads].join()}`);
	}
}

const list = layoutList(120, flat, now, MAX_ROWS);
if (list.length !== 3) fail(`expected main + two top-level agents, got ${list.length}`);
// SAFETY: length checked immediately above.
const [main, parent, leaf] = list as [(typeof list)[0], (typeof list)[0], (typeof list)[0]];
if (main.head.trimEnd() !== "● main") fail(`main row: ${JSON.stringify(main.head)}`);
if (main.activity !== "" || main.right.trim() !== "") fail("the main row carries counters it cannot stand behind");
if (parent.head.trimEnd() !== "○ general-purpose (+1)") fail(`folded row: ${JSON.stringify(parent.head)}`);
if (!parent.activity.includes("1 idle · Grepping localStorage keys")) fail(`folded activity: ${parent.activity}`);
if (parent.right !== "3m 52s · ↓ 56.5k tokens") fail(`right column: ${JSON.stringify(parent.right)}`);
if (parent.tone !== "accent") fail(`a running row is accent: ${parent.tone}`);
if (leaf.tone !== "success") fail(`a done row is green: ${leaf.tone}`);
// However tight the width, a truncated sentence keeps two columns before the clock.
for (let width = 40; width <= 120; width++) {
	for (const row of layoutList(width, flat, now, MAX_ROWS).slice(1)) {
		if (row.activity && row.right.trim() && !/\S {2,}\S/.test(row.activity + row.fill + row.right)) fail(`width ${width}: the sentence runs into the clock`);
	}
}

const quiet = layoutList(100, run({ phases: ["map"], branches: [branch({ idleMs: 60_000 })] }), now, MAX_ROWS);
if (quiet[1]?.tone !== "warning") fail(`an idle branch is yellow: ${quiet[1]?.tone}`);

const many = run({ phases: ["map"], branches: Array.from({ length: 40 }, (_, i) => branch({ stem: `map-b${i}` })) });
const capped = layoutList(100, many, now, MAX_ROWS);
if (capped.length !== MAX_ROWS) fail(`row budget ignored: ${capped.length}`);
if (!capped[MAX_ROWS - 1]?.head.startsWith("↓ 33 more")) fail(`no "more" row: ${capped[MAX_ROWS - 1]?.head}`);
if (capped[MAX_ROWS - 1]?.dotAt !== -1) fail("the more row was given a status dot");
const scrolled = layoutList(100, many, now, MAX_ROWS, pick("b:map-b20"));
if (!scrolled[1]?.head.startsWith("↑ ") || !scrolled.some((row) => row.id === "b:map-b20")) fail("the window did not follow the cursor");
// A budget of one is `● main` and nothing else.
if (layoutList(100, many, now, 1).length !== 1) fail("a one-row budget grew a second row");

// ---------- the frame ----------

for (let width = 0; width <= 200; width++) {
	for (const [label, lines] of [
		["panel open", renderLines(width, phased, now, MAX_ROWS, ink, true)],
		["idle", renderLines(width, undefined, now, MAX_ROWS, ink)],
		["typing", renderLines(width, flat, now, MAX_ROWS, ink)],
		["picking", renderLines(width, flat, now, MAX_ROWS, ink, false, pick("b:map-explore", ["b:map-general-purpose"]))],
		["workflow", renderLines(width, phased, now, MAX_ROWS, ink, false, pick("r:.pi-out/20260905-030000"))],
		["faded", renderLines(width, settled, now + 31_000, MAX_ROWS, ink)],
	] as [string, string[]][]) {
		// idle and faded draw NOTHING, at every width. The slot is belowEditor, where pi passes
		// spacerWhenEmpty and leadingSpacer both false, so zero lines is zero rows.
		if (label === "idle" || label === "faded") {
			if (lines.length !== 0) fail(`${label} drew ${lines.length} lines at width ${width}, expected none`);
		} else if (lines.length < 1) {
			fail(`${label} rendered nothing at width ${width}`);
		}
		for (const line of lines) {
			if (visibleWidth(line) !== Math.max(0, width)) fail(`${label} overflowed at width ${width}: ${visibleWidth(line)}`);
		}
	}
}
if (renderLines(80, phased, now, MAX_ROWS, ink, true)[0]?.trim() !== "") fail("the open panel did not blank the widget");

// ---------- the cursor ----------

// Typing: no `❯` and no hint. Picking: one `❯`, on the cursor's row, and the hint on top.
const typed = renderLines(100, flat, now, MAX_ROWS, ink);
if (typed.some((line) => line.includes("❯")) || typed.some((line) => line.includes("esc back"))) fail("typing drew the cursor or the hint");
const picked = renderLines(100, flat, now, MAX_ROWS, ink, false, pick("b:map-explore", ["b:map-general-purpose"]));
if (!picked[0]?.includes("↑↓ select") || picked[0]?.includes("enter")) fail(`hint on a leaf: ${picked[0]}`);
if (!picked[3]?.startsWith(" ❯ └ ○ Explore")) fail(`cursor not on the chosen agent: ${picked[3]}`);
if (picked.filter((line) => line.includes("❯")).length !== 1) fail("more than one cursor");
const onMain = renderLines(100, flat, now, MAX_ROWS, ink, false, pick("main", ["b:map-general-purpose"]));
if (!onMain[1]?.startsWith(" ❯ ● main") || !onMain[0]?.includes("enter collapse all")) fail(`cursor on main: ${onMain.slice(0, 2)}`);
if (!renderLines(100, flat, now, MAX_ROWS, ink, false, pick("b:map-general-purpose"))[0]?.includes("enter expand")) fail("a folded row does not offer enter");

// A declared phase with no branches yet has not run: grey, not a green "done".
const declared = layoutList(120, run({ phases: ["map", "design"], branches: [branch()] }), now, MAX_ROWS, pick("p:design", ["r:.pi-out/20260905-030000"]));
if (declared.find((row) => row.id === "p:design")?.tone !== "dim") fail("an empty phase looks finished");
// An open path that matches nothing opens nothing, so main does not offer to fold it.
if (renderLines(100, flat, now, MAX_ROWS, ink, false, pick("main", ["b:gone"]))[0]?.includes("collapse all")) fail("main offered to fold a tree that is not open");

// ---------- the no-op frame ----------

if (renderKey(flat, now) !== renderKey(flat, now)) fail("render key is not stable");
if (renderKey(undefined, now) !== "-") fail("an empty screen is not one key");
if (renderKey(settled, now + 31_000) !== "-") fail("a faded run is not the empty screen");
if (renderKey(flat, now) === renderKey(flat, now + 1_000)) fail("the clock moved and the key did not");
const rewritten = run({ ...flat, branches: [branch({ activity: "Reading hooks.server.ts and app.d.ts" }), ...flat.branches.slice(1)] });
if (renderKey(flat, now) === renderKey(rewritten, now)) fail("the activity sentence changed and the key did not");

console.log("ok");
