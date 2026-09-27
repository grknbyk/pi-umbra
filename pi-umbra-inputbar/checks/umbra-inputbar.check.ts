// inputbar.ts: the title splice, the colour resolver, and the editor itself - pi's real
// CustomEditor under stub tui/theme/keybindings - to prove the name lands on the top border
// and the /umb-color override outlives pi's own borderColor assignments.
//
// Run it with:  bun run umbra-inputbar.check.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import inputbar, { InputBar, NAMED, paintWith, resolvePaint, withTitle } from "../extensions/umbra-inputbar.ts";

assert.equal(withTitle("─".repeat(20), undefined), "─".repeat(20), "no name, no change");
const titled = withTitle("─".repeat(20), "π - repo");
assert.equal(visibleWidth(titled), 20, "same width after the splice");
assert.ok(titled.endsWith(" π - repo ──"), "label at the right, two dashes after it");
assert.equal(withTitle("─".repeat(8), "π - a long name"), "─".repeat(8), "no room: untouched");
const wrapped = withTitle(`\x1b[34m${"─".repeat(30)}\x1b[39m`, "x");
assert.ok(wrapped.startsWith("\x1b[34m") && wrapped.endsWith(" x ──\x1b[39m"), "label lands inside the colour wrap");
assert.ok(withTitle("── ✻ working ─────────────────", "s").startsWith("── ✻ working "), "the left-side spinner is left alone");
// The label carries the footer's colour, so its reset has to be followed by the border's own.
const painted = withTitle("─".repeat(20), "n", (t) => `[${t}]`, (t) => `{${t}}`);
assert.ok(painted.endsWith("[ n ]{──}"), "label painted, and the two dashes after it repainted");
assert.equal(visibleWidth(withTitle("─".repeat(20), "n")), 20, "unpainted by default, so width is unchanged");

assert.equal(resolvePaint("off"), undefined, "off restores the theme");
assert.equal(resolvePaint("orange")!("ab"), "\x1b[38;2;255;137;4mab\x1b[39m", "a palette name paints its fixed truecolor");
assert.equal(resolvePaint("#ff8800")!("ab"), "\x1b[38;2;255;136;0mab\x1b[39m", "a raw hex still works");
assert.deepEqual(Object.keys(NAMED), ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"], "the eight names");
assert.throws(() => resolvePaint("nope"), /unknown colour "nope" - one of: off, red/, "an unknown name lists the palette");

// The editor. The stub pi only has to answer getSessionName; on/registerCommand are recorded.
const commands: Record<string, object> = {};
const emitted: string[] = [];
inputbar({
	on() {},
	registerCommand: (name: string, def: object) => (commands[name] = def),
	getSessionName: () => "π - t",
	events: { emit: (name: string) => emitted.push(name) },
} as never);
assert.ok(commands["umb-color"], "registers /umb-color");
const bar = new InputBar({ requestRender() {} } as never, { borderColor: (s: string) => `<${s}>`, selectList: {} } as never, {} as never);
const render = bar as unknown as { renderTopBorder(w: number, h: number): string; renderBottomBorder(w: number, h: number): string };
// borderColor is the stub `<...>`: the label sits unpainted (no ui yet), the two dashes after it
// carry a wrap of their own, and pi's own wrap still closes the line.
assert.ok(render.renderTopBorder(24, 0).endsWith(" π - t <──>>"), "session name on the top border, tail repainted");
assert.equal(visibleWidth(render.renderTopBorder(24, 0).replace(/[<>]/g, "")), 24, "top border keeps its width");

bar.borderColor = (s) => `[${s}]`; // what pi does on a thinking-level change
assert.equal(render.renderBottomBorder(4, 0), "[────]", "pi's assignment is honoured while no override is set");
paintWith("orange");
assert.equal(render.renderBottomBorder(4, 0), "\x1b[38;2;255;137;4m────\x1b[39m", "/umb-color paints the border");
bar.borderColor = (s) => `(${s})`; // pi assigns again...
assert.equal(render.renderBottomBorder(4, 0), "\x1b[38;2;255;137;4m────\x1b[39m", "...and the override still wins");
paintWith("off");
assert.equal(render.renderBottomBorder(4, 0), "(────)", "off hands the border back to pi's last colour");

// The chevron. pi's multi-line Editor takes no `prompt` option, so it is a gutter around the rows:
// every row keeps the full width, and a click still lands on the character under the pointer.
const tui = { requestRender() {}, terminal: { rows: 40 } };
for (const [paddingX, first] of [[0, "❯ hello"], [1, "❯ hello"]] as const) {
	const editor = new InputBar(tui as never, { borderColor: (s: string) => s, selectList: {} } as never, {} as never, { paddingX });
	editor.setText("hello");
	const rows = editor.render(20);
	assert.equal(rows.length, 3, "top border, one text row, bottom border");
	assert.ok(rows[1]!.startsWith(first), `paddingX ${paddingX}: chevron then the text, got ${JSON.stringify(rows[1])}`);
	for (const row of rows) assert.equal(visibleWidth(row), 20, `paddingX ${paddingX}: every row keeps the width`);
	assert.ok(rows[2]!.startsWith("──"), "the bottom border runs under the gutter");
	editor.handleMouse({ type: "click", button: "left", x: 3, y: 1, width: 20, height: 3 } as never);
	assert.equal(editor.getCursor().col, 1, `paddingX ${paddingX}: a click on the "e" puts the cursor before it`);
}

// Down where the editor has nowhere to go is announced once per fresh press; a press that moved
// the cursor, and the repeats of a held key, are not.
const DOWN = "\x1b[B";
const keys = { matches: (data: string, id: string) => id === "tui.editor.cursorDown" && data === DOWN };
const probe = new InputBar(tui as never, { borderColor: (s: string) => s, selectList: {} } as never, keys as never);
const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
probe.setText("ab");
probe.handleInput(DOWN);
assert.deepEqual(emitted, ["editor:down-at-end"], "cursor already at the end: announced");
probe.handleInput(DOWN);
assert.equal(emitted.length, 1, "the next repeat within 150 ms is part of the same press");
await pause();
probe.handleInput("\x1b[A");
await pause();
probe.handleInput(DOWN);
assert.equal(emitted.length, 1, "up then down on one line moved the cursor, so nothing is announced");
await pause();
probe.handleInput(DOWN);
assert.equal(emitted.length, 2, "a fresh press at the end is announced again");

console.log("umbra-inputbar.check.ts ok - title splice 8 cases, paint 5 cases, editor: name on border, override beats 2 reassignments, chevron gutter at 2 paddings, down-at-end probe 4 cases");
