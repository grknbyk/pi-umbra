// The status line, without a terminal. Everything worth checking is a pure function of the turn
// state, so the event wiring is the only part left untested - and that part is four assignments.
//
//   bun run umbra-working.check.ts
import assert from "node:assert";
import { humanizeToolLabel } from "../extensions/umbra-toolbox/renderer/tool/names.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compact, elapsed } from "../lib/umbra-format.ts";
import { type Turn, entryFor, indicatorFor, labelFor, newTurn, statusLine,
	streamingOf, syncedCycleMs } from "../extensions/umbra-working.ts";

const ON = { tokens: true, elapsed: true };
const TOOLS = ["read", "ls", "find", "grep", "write", "edit", "bash", "powershell"];
const KEYS = [...TOOLS, "thinking", "idle", "custom"];

// pi's eight typed tools collapse into four words. The mapping is the whole point of the file, so
// every name in `ToolCallEvent` is named here rather than sampled.
assert.equal(labelFor("read"), "Reading");
assert.equal(labelFor("ls"), "Listing");
assert.equal(labelFor("find"), "Searching");
assert.equal(labelFor("grep"), "Searching");
assert.equal(labelFor("write"), "Writing");
assert.equal(labelFor("edit"), "Editing");
assert.equal(labelFor("bash"), "Running");
assert.equal(labelFor("powershell"), "Running");
assert.equal(labelFor("thinking"), "Thinking");
assert.equal(labelFor("idle"), "Working");

// CustomToolCallEvent - anything an extension registered - shares one animation and shows the
// title its tool card shows, so the card and the line name the tool with the same words.
assert.equal(labelFor("fabric_exec"), "Fabric Exec");
assert.equal(labelFor("ask_user_question"), "Asking");
assert.deepEqual(indicatorFor("fabric_exec").frames, indicatorFor("custom").frames);
for (const name of ["web_search", "fetch_content", "fabric_exec", "codeSearch"]) {
	assert.equal(labelFor(name), humanizeToolLabel(name), `${name}: line and card agree`);
}
// Renaming `custom` still renames every tool umbra has no word for.
assert.equal(labelFor("web_search", { tools: { custom: { label: "Tool" } } }), "Tool");

// --- frames ----------------------------------------------------------------------------------
// Every glyph must measure one column: a two-column frame shifts the whole status line on every
// tick, which is what ruled the trigrams out of Listing.
for (const key of KEYS) {
	const { frames } = indicatorFor(key);
	assert.ok(frames.length >= 4, `${key} needs enough frames to read as motion`);
	for (const frame of frames) assert.equal(visibleWidth(frame), 1, `${key}: ${frame} is not one column`);
}

// Tools that share a word share its animation, and no two words look alike - otherwise the glyph
// says nothing the word did not already say.
assert.deepEqual(indicatorFor("find").frames, indicatorFor("ls").frames, "one word, one animation");
assert.deepEqual(indicatorFor("powershell").frames, indicatorFor("bash").frames);
const distinct = new Set(KEYS.map((key) => indicatorFor(key).frames.join("")));
assert.equal(distinct.size, 7, "seven words, seven animations");

// Listing bounces rather than sweeping one way: a vertical sweep that resets jumps the full cell
// height and reads as a stutter.
assert.deepEqual(indicatorFor("ls").frames, ["⎺", "⎻", "⎼", "⎽", "⎼", "⎻"]);
assert.deepEqual(indicatorFor("write").frames, ["▖", "▘", "▝", "▗"]);

// The sets are 4, 6 and 8 long, so a fixed per-frame interval would run them at three speeds. One
// full turn is the number held steady and the interval is derived from it.
assert.equal(indicatorFor("write").intervalMs, 120, "4 frames");
assert.equal(indicatorFor("read").intervalMs, 80, "6 frames");
assert.equal(indicatorFor("idle").intervalMs, 60, "8 frames");
for (const key of KEYS) {
	const { frames, intervalMs } = indicatorFor(key);
	assert.equal(frames.length * intervalMs, 480, `${key} must take the same time to come round`);
}

// --- settings --------------------------------------------------------------------------------
// Fields merge one by one, so naming a tool keeps the animation it already had.
const renamed = { tools: { fabric_exec: { label: "Fabric" } } };
assert.equal(labelFor("fabric_exec", renamed), "Fabric");
assert.deepEqual(indicatorFor("fabric_exec", renamed).frames, indicatorFor("custom").frames);
assert.equal(labelFor("read", renamed), "Reading", "an override must leave the other tools alone");

// A frames array replaces rather than merges, and the turn holds, so a shorter set runs slower per
// frame instead of running the whole animation faster.
const shell = { tools: { bash: { frames: ["$", "#", "%"] } } };
assert.deepEqual(indicatorFor("bash", shell).frames, ["$", "#", "%"]);
assert.equal(indicatorFor("bash", shell).intervalMs, 160, "3 frames, same 480ms turn");
assert.deepEqual(indicatorFor("powershell", shell).frames, indicatorFor("powershell").frames, "not its twin");
assert.deepEqual(indicatorFor("bash", { tools: { bash: { frames: [] } } }).frames.length, 4, "empty is no override");

// `cycleMs` is one full turn, so it survives a change of frame count.
assert.equal(indicatorFor("read", { tools: { read: { cycleMs: 1200 } } }).intervalMs, 200);
assert.deepEqual(entryFor("bash", { tools: { bash: { label: "Bash", cycleMs: 240 } } }), {
	label: "Bash",
	cycleMs: 240,
	frames: indicatorFor("bash").frames,
});

// --- the line --------------------------------------------------------------------------------
const at = (turn: Partial<Turn>): Turn => ({ ...newTurn(0), ...turn });

// A turn that has produced nothing yet shows no arrow, because "↓ 0 tokens" is noise.
assert.equal(statusLine(at({}), 1_000, ON), "Working… (1s)");
assert.equal(statusLine(at({ key: "read", settled: 180 }), 5_000, ON), "Reading… (5s · ↓ 180 tokens)");
assert.equal(statusLine(at({ key: "bash", settled: 1_200 }), 12_000, ON), "Running… (12s · ↓ 1.2k tokens)");
assert.equal(statusLine(at({ key: "fabric_exec" }), 1_000, ON), "Fabric Exec… (1s)");
assert.equal(statusLine(at({ key: "fabric_exec" }), 1_000, ON, renamed), "Fabric… (1s)");

// Streaming output counts before the message ends, or the number stands still mid-answer.
assert.equal(statusLine(at({ settled: 100, streaming: 80 }), 5_000, ON), "Working… (5s · ↓ 180 tokens)");
// A message in flight marks the count, which a provider may not move until the message ends.
assert.equal(statusLine(at({ settled: 17_700, streaming: 6, open: true }), 5_000, ON), "Working… (5s · ↓ ~17.7k tokens)");
assert.equal(statusLine(at({ open: true }), 1_000, ON), "Working… (1s)", "nothing counted yet: no arrow, no ~");
const streamed = (usage: number, content: unknown[]) => ({ role: "assistant", usage: { output: usage }, content }) as never;
assert.equal(streamingOf(streamed(4, [{ type: "thinking", thinking: "x".repeat(4000) }])), 1000, "the bridge's stale 4 loses to the text");
assert.equal(streamingOf(streamed(4, [{ type: "text", text: "abcdefgh" }, { type: "toolCall", arguments: { a: 1 } }])), 4, "text 8 + args 7 chars");
assert.equal(streamingOf(streamed(900, [{ type: "text", text: "short" }])), 900, "a larger reported count wins");

// "thought for" belongs to the Thinking line alone and counts from zero at the block, so the two
// numbers on that line are the turn and this thought - not the turn twice.
const thinking = at({ key: "thinking", thinkingAt: 9_000, settled: 50 });
assert.equal(statusLine(thinking, 12_000, ON), "Thinking… (12s · ↓ 50 tokens · thought for 3s)");
assert.doesNotMatch(statusLine(at({ key: "read", thinkingAt: 9_000 }), 12_000, ON), /thought for/);
assert.doesNotMatch(statusLine(at({ key: "thinking" }), 12_000, ON), /thought for/);

// Switches, and the both-off case, which must still say what is happening.
assert.equal(statusLine(at({ settled: 180 }), 5_000, { tokens: false, elapsed: true }), "Working… (5s)");
assert.equal(statusLine(at({ settled: 180 }), 5_000, { tokens: true, elapsed: false }), "Working… (↓ 180 tokens)");
assert.equal(statusLine(at({ settled: 180 }), 5_000, { tokens: false, elapsed: false }), "Working…");

// Past a minute, seconds alone stop reading as a duration.
assert.equal(elapsed(59_400), "59s");
assert.equal(elapsed(60_000), "1m 0s");
assert.equal(elapsed(205_000), "3m 25s");
assert.equal(elapsed(-5), "0s", "a clock that went backwards must not print a negative");
assert.equal(compact(695), "695");
assert.equal(compact(7_013), "7.0k");
assert.equal(compact(224_310), "224k");
assert.equal(compact(999_600), "1M", "no 1000k: the context window reads 1M");
assert.equal(compact(1_697_000), "1.7M");
assert.equal(compact(88_149_651), "88.1M");
assert.equal(compact(250_000_000), "250M");

console.log(`umbra-working.check.ts ok - ${KEYS.length} keys, frames 8 cases, settings 9, line 12, format 7`);

// Spinner locked to the shimmer: whole loops per wave, and the shimmer speed scales both.
assert.equal(syncedCycleMs(2000, 1), 500, "classic: 4 loops per 2000 ms wave");
assert.equal(syncedCycleMs(4000, 0.5), 1000, "classic 0.5: same 4 loops, each twice as long");
assert.equal(syncedCycleMs(2200, 1), 440, "kitt: 5 loops per 2200 ms round trip");
const classic = { periodMs: 2000, speed: 1 };
assert.equal(indicatorFor("idle", {}, classic).intervalMs, 63, "8 frames share the synced loop");
assert.equal(indicatorFor("bash", {}, classic).intervalMs, 125, "4 frames share the same loop");
assert.equal(indicatorFor("bash", { tools: { bash: { cycleMs: 900 } } }, classic).intervalMs, 225, "a set cycleMs still wins");
// classic 2 once ran the 8-frame set at 31 ms a frame; it now turns twice per wave, not four times.
assert.equal(syncedCycleMs(1000, 2, 8), 500, "8 frames: loops drop until a frame takes >= 60 ms");
assert.equal(syncedCycleMs(1000, 2, 4), 250, "4 frames already fit four loops");
assert.equal(indicatorFor("idle", {}, { periodMs: 1000, speed: 2 }).intervalMs, 63);
assert.equal(syncedCycleMs(250, 8, 8), 250, "one loop per wave is the floor; the wave itself is that fast");
for (const [period, speed] of [[2000, 1], [1000, 2], [500, 4], [4400, 0.5], [2200, 1]] as const) {
	for (const frames of [3, 4, 6, 8]) {
		const loop = syncedCycleMs(period, speed, frames);
		assert.ok(Number.isInteger(Math.round((period / loop) * 1e9) / 1e9), `${period}/${speed}/${frames}: whole loops per wave`);
	}
}
