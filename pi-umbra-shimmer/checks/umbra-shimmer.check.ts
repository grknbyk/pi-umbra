// What goes wrong here without anything failing: the band never reaches an end of the line, the
// two halves of the indicator drift into different coordinate spaces, and `off` quietly keeps
// animating. All three look like a working shimmer until you watch it.
//
//   bun run umbra-shimmer.check.ts
import assert from "node:assert";
import shimmer, { blend, highlight, middleAt, painters, parseSpec, periodMs, strength, toneOf } from "../extensions/umbra-shimmer.ts";

const RGB = { muted: [128, 128, 128], text: [255, 255, 255], accent: [0, 200, 255] } as const;
const CLASSIC = { mode: "classic", speed: 1 } as const;
const theme = {
	fg: (color: string, text: string) => {
		const rgb = RGB[color as keyof typeof RGB] ?? [10, 20, 30];
		return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
	},
};

// pi exposes no raw theme values, so the colour is read back out of a painted character.
assert.deepEqual(toneOf(theme, "muted"), [128, 128, 128], "the tone comes back out of the escape");
assert.equal(toneOf({ fg: (_c, t) => t }, "muted"), undefined, "a theme that paints nothing has no tone");

assert.deepEqual(blend([0, 0, 0], [10, 20, 30], 0), [0, 0, 0], "no highlight is the base colour");
assert.deepEqual(blend([0, 0, 0], [10, 20, 30], 1), [10, 20, 30], "full highlight is the tone itself");
assert.deepEqual(blend([0, 0, 0], [10, 20, 40], 0.5), [5, 10, 20], "and halfway is halfway");

assert.equal(strength(10, 10, 4), 1, "the middle of the band gets all of it");
assert.equal(strength(14, 10, 4), 0, "its edge gets none");
assert.equal(strength(40, 10, 4), 0, "and nothing outside goes negative");

// classic has to enter from off the left edge and leave past the right one, or the wave appears
// and vanishes mid-line instead of running through it.
const classic = [0, 500, 1000, 1500, 1999].map((ms) => middleAt("classic", ms, 30, 1));
assert.ok(classic[0]! < 0, "the pass starts off the left edge");
assert.ok(classic[4]! > 30, "and ends past the right one");
assert.deepEqual(classic, [...classic].sort((a, b) => a - b), "it only ever moves one way");

// kitt has to turn around, and reach both ends while doing it.
const kitt = Array.from({ length: 45 }, (_, i) => middleAt("kitt", i * 50, 30, 1));
assert.ok(Math.min(...kitt) < 1, "the scanner reaches the left end");
assert.ok(Math.max(...kitt) > 29, "and the right one");
assert.ok(kitt.some((v, i) => i > 0 && v < kitt[i - 1]!), "and comes back");

// One tone per pass, cycling: a highlight that never changes is the thing this replaces.
// The ramp runs white -> the accent lifted toward white -> lifted a little -> the accent, and
// it is walked rather than stepped: two frames a moment apart must not jump colour.
const ACCENT: [number, number, number] = [0, 200, 255];
assert.deepEqual(highlight(ACCENT, 0, 1), [255, 255, 255], "the ramp starts at white");
assert.deepEqual(highlight(ACCENT, 3300, 1), ACCENT, "and reaches the theme's own colour");
assert.deepEqual(highlight(ACCENT, 6600, 1), [255, 255, 255], "then comes back rather than cutting");
assert.deepEqual(highlight(ACCENT, 0, 1, [1, 2, 3]), [1, 2, 3], "a theme peak replaces white at the top");
const near = highlight(ACCENT, 1000, 1);
const later = highlight(ACCENT, 1080, 1);
assert.notDeepEqual(near, later, "the tone moves between frames");
assert.ok(Math.max(...[0, 1, 2].map((i) => Math.abs(near[i]! - later[i]!))) < 20, "but never jumps");

// The speed multiplier has to reach both halves: the sweep and the colour.
assert.equal(parseSpec("classic 3")?.speed, 3, "a second argument is the speed");
assert.equal(parseSpec("kitt")?.speed, 1, "no argument is speed 1");
assert.equal(parseSpec("classic x")?.speed, 1, "and so is a speed that is not a number");
assert.equal(parseSpec("classic 99")?.speed, 8, "an absurd speed is clamped, not refused");
assert.equal(parseSpec("nope"), undefined, "an unknown mode is refused");
assert.deepEqual(highlight(ACCENT, 1650, 2), highlight(ACCENT, 3300, 1), "speed 2 gets there twice as fast");
assert.equal(middleAt("classic", 500, 30, 2), middleAt("classic", 1000, 30, 1), "and sweeps twice as fast");

// off is off. It also takes the footer's colour rather than pi's own accent for the spinner.
const dark = painters(theme, { mode: "off", speed: 1 });
assert.equal(dark.spinner("x"), theme.fg("muted", "x"), "off paints the spinner in the footer colour");
assert.equal(dark.message("y"), theme.fg("muted", "y"), "and the message in the same one");

// The message is what tells the spinner how long the line is; without that they shimmer as two
// separate waves that meet in the middle.
const live = painters(theme, CLASSIC);
const message = live.message("Working... (esc to interrupt)");
assert.equal([...message.matchAll(/38;2;/g)].length, 29, "every character is painted on its own");
assert.ok(live.spinner("⠾").includes("38;2;"), "and so is the glyph");
assert.ok(!message.includes("\x1b[39m\x1b[39m"), "no character is painted twice");

// pi reads `label` when it applies a completion. An item with only `value` is an
// uncaughtException on the first Tab, which takes pi down rather than logging anything.
const commands: Record<string, { getArgumentCompletions(text: string): { value: string; label: string }[] | null }> = {};
shimmer({ on() {}, registerCommand: (name: string, def: never) => (commands[name] = def) } as never);
const complete = commands["umb-shimmer"]!.getArgumentCompletions.bind(commands["umb-shimmer"]);
for (const item of complete("") ?? []) {
	assert.equal(typeof item.value, "string", "every completion carries a value");
	assert.equal(typeof item.label, "string", "and a label, which is the one pi reads");
}
assert.equal((complete("k") ?? []).length, 1, "a prefix narrows the list");
assert.equal(complete("zzz"), null, "no match is null, not an empty list");

console.log("umbra-shimmer.check.ts ok - tone 2 cases, blend 3, band 3, classic 3, kitt 3, ramp 5, speed 7, off 2, span 3, completions 4");

// The period umbra-working locks the spinner to.
assert.equal(periodMs({ mode: "classic", speed: 1 }), 2000, "classic: one sweep");
assert.equal(periodMs({ mode: "kitt", speed: 2 }), 1100, "kitt: there and back, scaled by speed");
assert.equal(periodMs({ mode: "off", speed: 1 }), undefined, "off has no period");
