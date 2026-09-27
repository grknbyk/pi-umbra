// umbra-toolbox: the pi-cc-extensions render layer under umbra's names. Proves the entry loads
// against pi's real packages, registers /umb-toolbox (and nothing under pi-cc's old names), keeps
// its settings in umbra-toolbox.json, and that shiki - its one dependency - resolves and
// highlights, which is what the rich diffs need.
//
// Run it with:  bun run umbra-toolbox.check.ts
import assert from "node:assert/strict";
import toolbox from "../extensions/umbra-toolbox/index.ts";
import { CONFIG_PATH } from "../extensions/umbra-toolbox/config/config.ts";
import { resolveShikiTheme } from "../extensions/umbra-toolbox/renderer/tool/diff/diff-palette.ts";
import { ShikiHighlightCache } from "../extensions/umbra-toolbox/renderer/tool/diff/shiki-highlight.ts";

const commands: string[] = [];
const events = new Set<string>();
toolbox({
	registerCommand: (name: string) => commands.push(name),
	on: (event: string) => events.add(event),
	registerTool() {},
	getAllTools: () => [],
} as never);
assert.deepEqual(commands, ["umb-toolbox"], "one command, under umbra's name");
for (const event of ["session_start", "session_shutdown", "tool_execution_start", "message_update"]) {
	assert.ok(events.has(event), `listens to ${event}`);
}
assert.ok(CONFIG_PATH.endsWith("/umbra-toolbox.json"), `settings file: ${CONFIG_PATH}`);

const cache = new ShikiHighlightCache();
const fallback = ["const x = 1;"];
const ready = new Promise<void>((resolve) => cache.get(fallback[0]!, "ts", "github-dark", fallback, resolve));
await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("shiki did not highlight in 10 s")), 10_000))]);
const lines = cache.get(fallback[0]!, "ts", "github-dark", fallback);
assert.ok(lines?.[0]?.includes("\x1b["), "shiki resolved and coloured the line");

// Code in a diff wears the pi theme's own syntax colours, not one github palette for every theme.
const rgb = (hex: string) => `\x1b[38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const piColours: Record<string, string> = { text: "#d5ced9", syntaxKeyword: "#c74ded", syntaxNumber: "#f39c12", syntaxOperator: "#e25822" };
const piTheme = {
	fg: (_slot: string, text: string) => text,
	getFgAnsi: (slot: string) => rgb(piColours[slot] ?? "#808080"),
	getBgAnsi: () => "\x1b[48;2;15;17;26m",
};
const syntax = resolveShikiTheme(piTheme);
assert.equal(typeof syntax, "object", "a 24-bit theme gets its own shiki theme");
const code = ["const PORT = 3000;"];
await new Promise<void>((resolve) => cache.get(code[0]!, "ts", syntax, code, resolve));
const coloured = cache.get(code[0]!, "ts", syntax, code)![0]!;
assert.ok(coloured.startsWith(rgb("#c74ded") + "const"), "const takes the theme's keyword colour");
assert.ok(coloured.includes(rgb("#e25822") + "="), "= takes its operator colour");
assert.ok(coloured.includes(rgb("#f39c12") + "3000"), "3000 takes its number colour");
assert.equal(resolveShikiTheme({ fg: (_s: string, t: string) => t, getFgAnsi: () => "", getBgAnsi: () => "\x1b[48;2;15;17;26m" }), "github-dark", "colours pi cannot report: github-dark");

console.log("umbra-toolbox.check.ts ok - loads, /umb-toolbox only, umbra-toolbox.json, shiki highlights in the pi theme's colours");
