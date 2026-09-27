// The one runnable check for footer.ts: it renders every frame, so an API drift in ctx,
// footerData or the theme fails silently as a blank or a thrown line nobody sees. This
// drives the extension through a stub pi and asserts the six columns land on one line
// of exactly the width asked for.
//
// Run it with:  bun run umbra-footer.check.ts     (or: node --experimental-strip-types footer.check.ts)
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import footer from "../extensions/umbra-footer.ts";
import { homedir } from "node:os";

const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
const pi = { on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => (handlers[name] = fn) };

let factory: ((tui: unknown, theme: unknown, footerData: unknown) => { render(width: number): string[] }) | undefined;
let renders = 0;
const usage = { input: 6800, output: 33, cacheRead: 128_000, cacheWrite: 0, cost: { total: 1.23 } };
const ctx = {
	model: { name: "MiniMax: MiniMax M3 (CC)" },
	thinkingLevel: "medium",
	getContextUsage: () => ({ tokens: 147_000, contextWindow: 1_000_000 }),
	sessionManager: {
		getCwd: () => `${homedir()}/.pi`,
		getBranch: () => [{ type: "message", message: { role: "assistant", usage } }],
	},
	ui: { setFooter: (f: typeof factory) => (factory = f) },
};
const tui = { requestRender: () => renders++ };
const theme = { fg: (_color: string, text: string) => text };
const footerData = {
	onBranchChange: () => () => {},
	getExtensionStatuses: () => new Map<string, string>([["ponytail", "ponytail: full"]]),
	getGitBranch: () => "main",
};

footer(pi as never);
assert.ok(handlers.session_start && handlers.agent_end, "registers session_start and agent_end");
await handlers.session_start({}, ctx);
assert.ok(factory, "session_start installs the footer");
const view = factory!(tui, theme, footerData);

const [line, ...rest] = view.render(160);
assert.deepEqual(rest, [""], "one line plus a blank row under it - the rule above belongs to the editor");
assert.equal(visibleWidth(line), 160, "fills the width exactly, one column of padding left and two right");
for (const column of ["MiniMax M3 [medium]", "147k/1M", "$1.23", "R128k W0 CH95.0%", "↑ 6.8k ↓ 33", "pt:full", "~/.pi", "main"]) {
	assert.ok(line.includes(column), `shows ${column}`);
}
assert.ok(!line.includes("MiniMax:") && !line.includes("(CC)"), "provider prefix and parenthetical stripped");

// A narrow terminal takes as many rows as the groups need. The count is not the assertion - the
// assertion is that nothing is cut off the end and nothing runs past the edge. Truncating instead
// always lost whichever group came last, and the groups are ordered by how often they are read.
const rows = view.render(40);
assert.ok(rows.length > 1, "narrow: one row cannot hold all of it");
for (const row of rows) {
	assert.ok(visibleWidth(row) <= 40, `narrow: a row ran past the edge: ${JSON.stringify(row)}`);
}
const joined = rows.join("\n");
for (const column of ["MiniMax M3 [medium]", "147k/1M", "$1.23", "R128k W0 CH95.0%", "pt:full", "~/.pi", "main"]) {
	assert.ok(joined.includes(column), `narrow: ${column} survives the wrap`);
}

// The lag fix: agent_end re-reads the branch and asks for a repaint itself.
const before = renders;
await handlers.agent_end({}, ctx);
assert.equal(renders, before + 1, "agent_end requests exactly one repaint");

// A free model prices every turn at zero, and then the cost column must be absent.
usage.cost.total = 0;
await handlers.agent_end({}, ctx);
assert.ok(!view.render(160)[0].includes("$"), "zero cost hides the $ column");

console.log("umbra-footer.check.ts ok - one row at 160, wraps at 40 with nothing lost, repaint on agent_end");

// A long run must not wait for agent_end: each finished assistant message moves the cache group and
// repaints, and a user message leaves the footer alone.
const streamed = renders;
await handlers.message_end({ message: { role: "assistant", usage: { ...usage, cacheRead: 64_000 } } }, ctx);
assert.equal(renders, streamed + 1, "a finished assistant message repaints");
assert.ok(view.render(160)[0].includes("R64"), "the cache group follows the finished message");
assert.ok(view.render(160)[0].includes("↑ 13.6k ↓ 66"), "session totals: a finished message adds its fresh input, cache writes and output");
await handlers.message_end({ message: { role: "user" } }, ctx);
assert.equal(renders, streamed + 1, "a user message does not repaint");
assert.equal(handlers.message_update, undefined, "a streaming message does not touch the footer");

assert.ok(!view.render(160)[0].includes(homedir()), "the home directory is written as ~");

// The context reading is reused for a second, then read again.
{
	const { everyMs } = await import("../extensions/umbra-footer.ts");
	let reads = 0;
	let clock = 0;
	const cached = everyMs(1000, () => ++reads, () => clock);
	assert.equal(cached(), 1);
	clock = 999;
	assert.equal(cached(), 1, "within the second: reused");
	clock = 1000;
	assert.equal(cached(), 2, "a second on: read again");
	assert.equal(reads, 2);
}
