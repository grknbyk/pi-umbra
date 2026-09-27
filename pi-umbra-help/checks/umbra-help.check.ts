// Everything a diagnostic gets wrong is a wrong answer someone acts on, so the two decisions it
// makes are pinned here: which patch is worth reporting missing, and who shadows whom.
//
//   bun run umbra-help.check.ts
import assert from "node:assert";
import { type Facts, PROBES, announcesTruecolor, diagnose, renderDoctor, renderHelp, shadowed } from "../extensions/umbra-help.ts";

const clean: Facts = {
	patches: Object.fromEntries(PROBES.map((probe) => [probe.id, true])),
	commands: ["umb-shimmer", "umb-bg", "umb-help"],
	skillRoots: [{ root: "/a", names: ["adhd"] }],
	truecolor: true,
	theme: "umbra-deep-current",
};

const at = (facts: Partial<Facts>): Facts => ({ ...clean, ...facts });

assert.deepEqual(diagnose(clean), [], "a healthy session says nothing");
assert.equal(renderDoctor([]), "umb-doctor: nothing to report.");

// A missing patch is reported only when something depends on it. Nobody wants to be told the
// shimmer patch is absent on a machine with no shimmer installed.
const noShimmerPatch = { ...clean.patches, shimmer: false };
assert.equal(diagnose(at({ patches: noShimmerPatch })).length, 1, "shimmer installed, patch gone");
assert.equal(
	diagnose(at({ patches: noShimmerPatch, commands: ["umb-bg"] })).length,
	0,
	"no shimmer command, so its patch is not a fault",
);

// mid-slash guards a feature with no command of its own, so it always counts.
for (const id of ["mid-slash"]) {
	const findings = diagnose(at({ patches: { ...clean.patches, [id]: false }, commands: [] }));
	assert.equal(findings.length, 1, `${id} must report with no command installed`);
	assert.match(findings[0]!.detail, /patch\.mjs/, "and must say how to fix it");
}

// --- collisions --------------------------------------------------------------------------------
// The first root to claim a name wins, which is pi's own rule. What matters is naming the loser,
// because the skipped copy is the one nobody knows is being skipped.
const roots = [
	{ root: "~/.pi/agent/skills", names: ["adhd", "picasso", "umb-huh"] },
	{ root: "~/.agents/skills", names: ["adhd", "picasso", "last30days"] },
];
assert.deepEqual(shadowed(roots), [
	{ name: "adhd", winner: "~/.pi/agent/skills", losers: ["~/.agents/skills"] },
	{ name: "picasso", winner: "~/.pi/agent/skills", losers: ["~/.agents/skills"] },
]);
assert.deepEqual(shadowed([roots[0]!]), [], "one root cannot collide with itself");
assert.deepEqual(
	shadowed([
		{ root: "/a", names: ["x"] },
		{ root: "/b", names: ["x"] },
		{ root: "/c", names: ["x"] },
	]),
	[{ name: "x", winner: "/a", losers: ["/b", "/c"] }],
	"every loser is named, not just the first",
);

const collided = diagnose(at({ skillRoots: roots }));
assert.equal(collided.length, 1);
assert.match(collided[0]!.title, /2 skill names/);
assert.match(collided[0]!.detail, /~\/\.agents\/skills is skipped|is skipped/);

// Five names at most, then a count, or the line is longer than the terminal.
const many = [
	{ root: "/a", names: ["a", "b", "c", "d", "e", "f", "g"] },
	{ root: "/b", names: ["a", "b", "c", "d", "e", "f", "g"] },
];
assert.match(diagnose(at({ skillRoots: many }))[0]!.detail, /\+2 more/);

// --- the rest ----------------------------------------------------------------------------------
const noColor = diagnose(at({ truecolor: false }))[0]!;
assert.match(noColor.title, /truecolor/);
assert.equal(noColor.level, "note", "a terminal that stays quiet is not a fault");

// COLORTERM is the only standard signal and most terminals never set it, so a positive from any
// terminal that is known to handle 24-bit colour counts.
assert.equal(announcesTruecolor({ COLORTERM: "truecolor" }), true);
assert.equal(announcesTruecolor({ COLORTERM: "24bit" }), true);
assert.equal(announcesTruecolor({ WT_SESSION: "abc" }), true, "Windows Terminal never sets COLORTERM");
assert.equal(announcesTruecolor({ TERM_PROGRAM: "WezTerm" }), true);
assert.equal(announcesTruecolor({ KITTY_WINDOW_ID: "1" }), true);
assert.equal(announcesTruecolor({ COLORTERM: "8bit" }), false);
assert.equal(announcesTruecolor({}), false, "unknown is unknown, and only earns a note");
const offTheme = diagnose(at({ theme: "dark" }));
assert.equal(offTheme[0]!.level, "note", "another theme is a remark, not a fault");
assert.equal(diagnose(at({ theme: "umbra-ember-ash" })).length, 0);

// A background the terminal kept is reported with the terminal's own fix; one it took, or one it
// never answered about, says nothing.
const kept = diagnose(at({ background: { wanted: "#0b0e14", ignored: true, howTo: "VS Code: add it." } }));
assert.equal(kept.length, 1);
assert.match(kept[0]!.detail, /#0b0e14.*VS Code: add it\./);
assert.equal(diagnose(at({ background: { wanted: "#0b0e14", ignored: false, howTo: "" } })).length, 0);

// --- help ----------------------------------------------------------------------------------
// Only umb- rows, sorted, with pi's own descriptions - so the list cannot drift from the commands.
const help = renderHelp(
	[
		{ name: "umb-shimmer", description: "Working indicator animation" },
		{ name: "help", description: "pi's own" },
		{ name: "umb-bg", description: "Terminal background" },
	],
	{ background: "auto" },
	"umbra-onyx-slate",
);
assert.ok(help.indexOf("/umb-bg") < help.indexOf("/umb-shimmer"), "sorted by name");
assert.doesNotMatch(help, /^ +\/help/m, "pi's own commands are not ours to list");
assert.match(help, /theme: umbra-onyx-slate/);
assert.match(help, /"background": "auto"/, "the live settings, not a description of them");
assert.match(help, /umb-doctor/, "and a pointer to the other half");
assert.match(renderHelp([], {}, "dark"), /No umb- command is registered/);

console.log("umbra-help.check.ts ok - diagnose 11 cases, truecolor 7, shadowed 4, help 6");
