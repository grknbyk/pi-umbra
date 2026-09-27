// The one runnable check for ask.ts, the measured 375-token win. It asserts the three
import { readFileSync } from "node:fs";
// things a pi upgrade can silently break: the tool registers under its name with the
// schema the model is prompted with, it drops itself from the active set when there is
// no UI to answer in, and a call with no TUI returns a sentence rather than hanging.
//
// Run it with:  bun run umbra-ask.check.ts     (or: node --experimental-strip-types ask.check.ts)
import assert from "node:assert/strict";
import ask, { dropLast } from "../extensions/umbra-ask.ts";

type Tool = {
	name: string;
	parameters: { properties: Record<string, any> };
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
};

let tool: Tool | undefined;
let activeSet: string[] | undefined;
const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
const pi = {
	on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => (handlers[name] = fn),
	registerTool: (t: Tool) => (tool = t),
	getActiveTools: () => ["read", "ask_user_question", "bash"],
	setActiveTools: (names: string[]) => (activeSet = names),
};

ask(pi as never);
assert.ok(tool, "registers a tool");
assert.equal(tool!.name, "ask_user_question");

const questions = tool!.parameters.properties.questions;
assert.equal(questions.minItems, 1);
assert.equal(questions.maxItems, 4, "up to four questions");
const options = questions.items.properties.options;
assert.equal(options.minItems, 2);
assert.equal(options.maxItems, 8, "eight options: the open row makes nine, the last single digit");
assert.equal(questions.items.properties.recommended.minimum, 0, "recommended is 0-based");

// Headless: the tool costs 405 prompt tokens nobody can answer, so it deactivates itself.
handlers.before_agent_start({}, { hasUI: false });
assert.deepEqual(activeSet, ["read", "bash"], "no UI: removed from the active set, nothing else touched");
activeSet = undefined;
handlers.before_agent_start({}, { hasUI: true });
assert.equal(activeSet, undefined, "with a UI: left alone");

// Called outside the TUI it answers in one sentence instead of opening a dialog.
const result = await tool!.execute(
	"call-1",
	{ questions: [{ question: "Which?", header: "Pick", options: [{ label: "a" }, { label: "b" }], recommended: 1 }] },
	undefined,
	undefined,
	{ mode: "rpc" },
);
assert.match(result.content[0].text, /No interactive UI/);

console.log("umbra-ask.check.ts ok - name, schema bounds, headless deactivation, no-TUI answer");

// --- preview column ---------------------------------------------------------------------------
// The one piece of arithmetic the preview added. Rows carry ANSI colour, so their length in
// characters is not their width on screen; getting that wrong tilts the whole right column.
{
    const { beside, padTo } = await import("../extensions/umbra-ask.ts");
    const RED = "\x1b[31m";
    const OFF = "\x1b[39m";

    assert.equal(padTo(`${RED}abc${OFF}`, 6), `${RED}abc${OFF}   `, "padding must count visible width, not bytes");
    assert.equal(padTo("abcdef", 3), "abcdef", "an over-wide line is left alone rather than cut here");

    const merged = beside([`${RED}one${OFF}`, "two"], ["A"], 5, (gap: string) => gap);
    assert.equal(merged.length, 2, "the taller column decides the height");
    assert.equal(merged[0], `${RED}one${OFF}   \u2502 A`, `row 0 misaligned: ${JSON.stringify(merged[0])}`);
    assert.equal(merged[1], "two", "past the last preview row the separator stops rather than trailing");

    // The row under the cursor is often "none of these", which has no sample. An empty right
    // column must produce no separator at all, not a column of bars with nothing after them.
    assert.deepEqual(beside(["a", "b"], [], 5, (gap: string) => gap), ["a", "b"], "no sample means no rule");

    const tall = beside(["x"], ["A", "B", "C"], 3, (gap: string) => gap);
    assert.equal(tall.length, 3, "a taller preview also decides the height");
    assert.equal(tall[2], `    │ C`, "left stays padded under its last row");

    console.log("umbra-ask.check.ts ok - preview column alignment");
}

// --- wrapping ---------------------------------------------------------------------------------
// A narrow column is the point of wrapping, so the cases that matter are the awkward ones: a word
// that does not fit at all, and a column too small to be a column.
{
    const { wrap } = await import("../extensions/umbra-ask.ts");

    assert.deepEqual(wrap("one two three", 7), ["one two", "three"], "breaks at the space");
    assert.deepEqual(wrap("one two three", 40), ["one two three"], "a line that fits is left whole");
    assert.deepEqual(wrap("", 10), [""], "empty text stays one empty line, never zero");

    // No line may exceed the column, which is the invariant the preview alignment depends on.
    const long = wrap("supercalifragilistic word", 8);
    assert.ok(long.every((line) => line.length <= 8), `over-wide line: ${JSON.stringify(long)}`);
    assert.equal(long.join("").replace(/ /g, ""), "supercalifragilisticword", "no character is lost");

    // Turkish is measured, not assumed: these are single-cell characters and must not wrap early.
    assert.deepEqual(wrap("ışık ığdır", 9), ["ışık", "ığdır"], "Turkish letters count as one column");

    // A column of zero cannot wrap anything, so the text comes back untouched rather than sliced
    // into an infinite list of empty strings.
    assert.deepEqual(wrap("abc", 0), ["abc"], "a zero column returns the text unwrapped");

    console.log("umbra-ask.check.ts ok - wrapping");
}

// A preview survives sanitisation, and reaches the renderer at all.
{
    const { clean, cleanBlock } = await import("../lib/clean.ts");
    const art = "+---+\n| a |\n+---+";

    // Why cleanBlock has to exist: \n sits inside the C0 range clean sweeps, so the plain filter
    // folds an ASCII mockup onto one row.
    assert.equal(clean(art), "+---+| a |+---+", "clean is expected to drop newlines");
    assert.equal(cleanBlock(art), art, "cleanBlock must keep the block a block");
    assert.equal(cleanBlock("a\x1b[31mb\rc"), "a[31mbc", "everything else in C0/C1 still goes");

    // The trap this check exists for: execute() rebuilds each option from a whitelist, so a field
    // added to the schema and to the renderer but not to that line arrives as undefined and draws
    // nothing, with no error anywhere. That is what happened to `preview`.
    const source = readFileSync(new URL("../extensions/umbra-ask.ts", import.meta.url), "utf8");
    const whitelist = /options: q\.options\.map\(\(o\) => \(\{([^]*?)\}\)\)/.exec(source)?.[1];
    assert.ok(whitelist, "the option whitelist must be findable, or this check asserts nothing");
    for (const field of ["label", "consequence", "preview"]) {
        assert.ok(whitelist.includes(field + ":"), "the whitelist drops " + field + " before the renderer sees it");
    }

    console.log("umbra-ask.check.ts ok - preview reaches the renderer");
}

// Backspace takes one drawn character: a whole emoji or flag, never half of one.
assert.equal(dropLast("evet👍"), "evet", "an emoji goes whole");
assert.equal(dropLast("🇹🇷"), "", "a flag is one character");
assert.equal(dropLast("Değiş"), "Deği", "Turkish letters one at a time");
assert.equal(dropLast(""), "", "nothing to drop");
