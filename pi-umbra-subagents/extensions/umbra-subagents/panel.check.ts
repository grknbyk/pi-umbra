import { strict as assert } from "node:assert";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BranchView, RunState } from "./skills/delegate/state.ts";
import { createPanel, type PanelSource } from "./panel.ts";

// The one runnable check for the panel. Run it with:
//   node --experimental-strip-types build/panel.check.ts
// (node resolves "@earendil-works/*" through build/node_modules, a junction to the copy pi
// already has: mklink /J build\node_modules %USERPROFILE%\.bun\install\global\node_modules)
//
// It renders the component against a stub theme, a stub TUI and a stub source, so it never
// starts pi, never reads a run directory and never kills anything. What it protects is the
// arithmetic: the height and the two box widths must be identical on every frame whatever
// the data does, because a line that wraps or a box that disagrees costs a row and moves
// everything under it. The keys are checked for what they promise in the footer and
// nothing more.

// SAFETY: the panel only ever calls fg, bold and terminal.rows. Uncoloured output also
// makes every assertion below a plain string comparison.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
let renders = 0;
// SAFETY: same, for requestRender and terminal.rows.
const tui = { terminal: { rows: 40 }, requestRender: () => renders++ } as unknown as TUI;

const now = Date.now();
const branch = (phase: string, name: string, index: number, over: Partial<BranchView> = {}): BranchView => ({
	phase,
	name,
	index,
	parent: null,
	model: "Opus 5",
	pid: 1000 + index,
	status: "running",
	activity: "Reading vite.config.ts",
	tokens: 72_700,
	startedAt: now - 195_000,
	updatedAt: now,
	report: null,
	error: null,
	stem: `${phase}-${name}`,
	label: `${phase}:${name}`,
	depth: 0,
	elapsedMs: 195_000,
	idleMs: 0,
	exitCode: null,
	timedOut: false,
	alive: true,
	settled: false,
	...over,
});

const run: RunState = {
	dir: "/tmp/.pi-out/20260905-030000-pi-toolcall-render",
	name: "pi-toolcall-render",
	description: "Map how pi renders tool calls and whether an extension can override it",
	startedAt: now - 196_000,
	phases: ["map", "design"],
	activePhase: 0,
	branches: [
		branch("map", "core-render", 1, { idleMs: 53_000 }),
		branch("map", "omp-intercept", 2, { tokens: 89_600 }),
		branch("map", "api-surface", 3, { tokens: 108_600 }),
		branch("map", "flicker", 4, { tokens: 106_900 }),
	],
	done: 0,
	total: 4,
	tokens: 397_800,
	live: true,
};

const stopped: string[] = [];
const source: PanelSource = {
	run: () => run,
	stop: (dead) => stopped.push(dead.stem),
	subscribe: () => () => {},
};

let closed = 0;
const panel = createPanel(tui, theme, source, () => closed++);
// handleInput is optional on Component, so bind it once here rather than asserting non-null at
// each of the fourteen call sites. A panel that did not implement it is a failure worth naming.
if (!panel.handleInput) throw new Error("the panel implements no handleInput; ↑↓, x and esc cannot work");
const press = panel.handleInput.bind(panel);
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", escape: "\x1b", stop: "x" };
const WIDTH = 88;
const height = panel.render(WIDTH).length;

const boxLines = (lines: string[]) => lines.filter((line) => /[┌│└]/.test(line));
// Height and width are one assertion, not two: a line one column too wide wraps in the
// terminal, which costs a row the array cannot show. So the header, the footer and every
// other piece of chrome is measured, not just the box.
const fits = (lines: string[], width: number, label: string) => {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `${label}: a line is ${visibleWidth(line)} wide, over ${width}`);
	}
	const widths = new Set(boxLines(lines).map(visibleWidth));
	assert.equal(widths.size, 1, `${label}: box lines disagree on width: ${[...widths]}`);
	return [...widths][0];
};

const frame = (label: string) => {
	const lines = panel.render(WIDTH);
	assert.equal(lines.length, height, `${label}: height changed`);
	fits(lines, WIDTH, label);
	return lines.join("\n");
};

// The reference-1 frame: header, sidebar, four rows, footer.
const first = frame("initial");
assert.match(first, /pi-toolcall-render\s+0\/4 agents · 3m16s/);
assert.match(first, /> 1 Map 0\/4/);
assert.match(first, /2 Design/);
assert.match(first, /Map · 4 agents/);
assert.match(first, /● map:core-render\s+Opus 5 · 72\.7k tok · idle 53s\s+3m15s/);
assert.match(first, /↑↓ phase · → agents · x stop phase · esc back/);
assert.ok(!first.includes("pause") && !first.includes("save"), "the dropped keys are back in the footer");
assert.ok(!/> ● /.test(first), "no agent cursor while the phase list has the focus");

// With the phase list focused, ↑↓ move between phases and the right box previews the one
// under the cursor.
run.branches.push(branch("design", "api", 5));
run.total = 5;
press(KEY.down);
const crossed = frame("after moving to Design");
assert.match(crossed, /> 2 Design 0\/1/);
assert.match(crossed, /Design · 1 agents/);
assert.equal(renders, 1, "every handled key asks for exactly one render");

// → enters the phase's agents, and x there stops the selected branch, and only an unsettled
// one: a finished branch's pid belongs to whatever the OS handed it to next.
press(KEY.right);
const inside = frame("inside Design");
assert.match(inside, /↑↓ agent · ← phases · x stop agent · esc back/);
assert.match(inside, /> ● design:api/);
press(KEY.stop);
assert.deepEqual(stopped, ["design-api"]);
run.branches[4] = branch("design", "api", 5, { status: "done", settled: true, alive: false, exitCode: 0, report: "OK" });
press(KEY.stop);
assert.deepEqual(stopped, ["design-api"], "a settled branch must not be killed twice");

// A branch arriving mid-run must not slide the cursor onto another row, and the panel must
// not grow a line for it either: the box scrolls instead.
run.branches.unshift(branch("design", "late", 6));
run.total = 6;
const arrived = frame("after a branch arrives");
assert.match(arrived, /Design · 2 agents/, "the new branch joined the shown phase");
assert.match(arrived, /> ● design:api/, "the selection is still on its own row");

// Inside a phase ↑↓ wrap within it and never cross into the next one.
for (let n = 0; n < 5; n++) press(KEY.down);
assert.match(frame("wrapping inside Design"), /> 2 Design 1\/2/);

// A nested branch gets reference 3's marker here too, and the marker is part of the label
// column, so the model column stays aligned with its parent's.
run.branches[0] = branch("design", "late", 6, { parent: "design-api", depth: 1 });
assert.match(frame("nested branch"), /└ design:late\s+Opus 5/);

// The honest dash, not a fake 0, and the three states that are not "running".
run.branches[0] = branch("design", "late", 6, { tokens: null });
assert.match(frame("no usage reported yet"), /design:late\s+Opus 5 · –/);
run.branches[0] = branch("design", "late", 6, { timedOut: true, exitCode: 124, settled: true, status: "running" });
assert.match(frame("timed out"), /design:late\s+Opus 5 · 72\.7k tok · timeout/);
run.branches[0] = branch("design", "late", 6, { status: "error", error: "no credentials", settled: true });
assert.match(frame("errored"), /design:late\s+Opus 5 · 72\.7k tok · error/);

// ← goes back to the phase list, and x there stops every unsettled branch of that phase.
press(KEY.left);
assert.match(frame("back on the phases"), /↑↓ phase · → agents · x stop phase · esc back/);
press(KEY.up);
stopped.length = 0;
press(KEY.stop);
assert.deepEqual(stopped, ["map-core-render", "map-omp-intercept", "map-api-surface", "map-flicker"]);

// A phase that run.json never declared still gets its own place in the phase list, so no
// row can vanish into another phase's box.
run.branches[0] = branch("verify", "late", 6);
press(KEY.down);
press(KEY.down);
const undeclared = frame("undeclared phase");
assert.match(undeclared, /> 3 Verify 0\/1/);
assert.match(undeclared, /Verify · 1 agents/);
assert.match(undeclared, /● verify:late/);

// Every width the boxes claim to support draws to exactly that width. One column too wide
// wraps, and a wrapped line costs a row that everything below it then moves by.
for (let width = 13; width <= 200; width++) {
	const lines = panel.render(width);
	assert.equal(lines.length, height, `width ${width}: height changed`);
	assert.equal(fits(lines, width, `width ${width}`), width, `width ${width}: the boxes are not ${width} wide`);
}

// Nothing to draw is not a crash, and neither is a run that ends under the panel: an empty
// list must not reach Math.max() with no seed, which is the -Infinity the seed extension
// still carries.
run.branches.length = 0;
run.done = 0;
frame("empty run");
run.live = false;
frame("ended run");
press(KEY.stop);
press(KEY.down);

// esc closes, and closing is the only thing that closes.
press("q");
assert.equal(closed, 0);
press(KEY.escape);
assert.equal(closed, 1);
panel.dispose();

// One phase is a plain set of subagents, not a workflow: no phase list, no `phase:` prefix,
// and the agents have the cursor from the start.
const lone: RunState = { ...run, phases: ["Branches"], activePhase: 0, live: true,
	branches: [branch("Branches", "alpha", 1), branch("Branches", "beta", 2)], total: 2 };
stopped.length = 0;
const flat = createPanel(tui, theme, { ...source, run: () => lone }, () => {});
const flatLines = flat.render(WIDTH).join("\n");
assert.ok(!flatLines.includes("Phases"), "a single phase draws no phase list");
assert.match(flatLines, /2 agents/);
assert.match(flatLines, /> ● alpha\s/);
assert.match(flatLines, /↑↓ agent · x stop agent · esc back/);
flat.handleInput?.(KEY.down);
flat.handleInput?.(KEY.left);
flat.handleInput?.(KEY.stop);
assert.deepEqual(stopped, ["Branches-beta"], "← has no phase list to go back to");
flat.dispose();

// Opened from the bar's `❯`: the panel starts inside that agent's phase, on that row.
const aimedRun: RunState = { ...run, live: true, branches: [branch("map", "core", 1), branch("design", "api", 2)] };
const aimed = createPanel(tui, theme, { ...source, run: () => aimedRun }, () => {}, () => {}, "design-api");
const aimedFrame = aimed.render(WIDTH).join("\n");
assert.match(aimedFrame, /> 2 Design/);
assert.match(aimedFrame, /> ● design:api/);
assert.match(aimedFrame, /↑↓ agent · ← phases/);
aimed.dispose();

console.log(`ok - panel: ${height} lines, ${WIDTH} columns, ${renders} renders`);
