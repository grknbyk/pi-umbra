// Runs skill-fuzzy against pi's REAL built-in provider, so a change in pi's prefix/value
// contract fails here instead of silently in the TUI.
//   bun run umbra-skill-matcher.check.ts
import assert from "node:assert";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import skillFuzzy, { midPromptWord } from "../extensions/umbra-skill-matcher.ts";

const COMMANDS = [
    { name: "huh", source: "skill", description: "Restate the last message plainly." },
    { name: "hula-hola", source: "skill", description: "dance" },
    { name: "what-the-hex", source: "skill", description: "hex" },
    { name: "picasso", source: "skill", description: "frontend" },
    { name: "call-council", source: "skill", description: "council skill" },
    { name: "call-council", source: "extension", description: "council extension" },
    { name: "help", source: "builtin", description: "help" },
];

let wrap: (current: unknown) => any;
const pi = {
    getCommands: () => COMMANDS,
    on: (_event: string, handler: (e: unknown, ctx: unknown) => void) =>
        handler({}, { ui: { addAutocompleteProvider: (factory: typeof wrap) => (wrap = factory) } }),
};
skillFuzzy(pi as never);

const builtin = new CombinedAutocompleteProvider(COMMANDS as never, process.cwd());
const provider = wrap!(builtin);
const labels = async (typed: string) => {
    const got = await provider.getSuggestions([typed], 0, typed.length, { signal: AbortSignal.timeout(5000) });
    return (got?.items ?? []).map((item: { label: string }) => item.label);
};

// The user's three examples: a shorter query lists more skills, all in the runnable form.
// pi's matcher is subsequence-based, not contains, so "/huh" also reaches "hula-hola" (h-u-h).
// That is pi's own ranking to own; all this checks is that the exact match leads.
assert.equal((await labels("/huh"))[0], "skill:huh");
assert.ok((await labels("/hu")).includes("skill:huh"), "/hu must offer skill:huh");
assert.ok((await labels("/hu")).includes("skill:hula-hola"), "/hu must offer skill:hula-hola");
assert.ok((await labels("/h")).includes("skill:what-the-hex"), "/h must reach a mid-word match");

// A skill is never offered under the bare name that does not run.
assert.ok(!(await labels("/pic")).includes("picasso"), "bare picasso must be gone");
assert.deepEqual(await labels("/pic"), ["skill:picasso"]);

// "skill:" typed by hand still finds it, which plain fuzzy on the bare name cannot.
assert.ok((await labels("/skill:pic")).includes("skill:picasso"), "explicit prefix must still match");

// call-council belongs to an extension too, so its bare form stays runnable and untouched.
assert.ok((await labels("/call")).includes("call-council"), "extension command must survive");

// Browsing the whole list with a bare "/" must show the runnable form too, not just a search.
const all = await labels("/");
assert.ok(all.includes("skill:huh"), "bare / must list skills in runnable form");
assert.ok(!all.includes("huh"), "bare / must not leak the name that does not run");
assert.ok(all.includes("help"), "bare / must keep non-skill commands");

// Selecting the row writes exactly "/skill:huh " — one slash, one trailing space.
const item = { value: "skill:huh", label: "skill:huh" };
const applied = provider.applyCompletion(["/huh"], 0, 4, item, "/huh");
assert.equal(applied.lines[0], "/skill:huh ");
assert.equal(applied.cursorCol, 11);

console.log("umbra-skill-matcher: all checks passed");

// --- mid-sentence ---------------------------------------------------------------------------
// The token test, first on its own. These are the shapes the repatch entries also decide with,
// so a change here without a change there means the menu opens on something it cannot fill.
assert.equal(midPromptWord("run this /pic"), "pic", "a token after real text is ours");
assert.equal(midPromptWord("run this /"), "", "an empty token is ours - that is the keystroke");
assert.equal(midPromptWord("/pic"), null, "the line-start form belongs to the built-in provider");
assert.equal(midPromptWord("   /pic"), null, "an indented line start is still a line start");
assert.equal(midPromptWord("open src/pic"), null, "a path is not a command");
assert.equal(midPromptWord("open ~/pic"), null, "nor is a home path");
assert.equal(midPromptWord("run /pic then"), null, "the token must end at the cursor");

// Mid-sentence rows carry the bare skill name, because nothing dispatches them: pi runs a command
// only when the message starts with a slash. The name is what pi's own <available_skills> block
// lists, so it is the form the model can act on.
const mid = async (typed: string) => {
    const got = await provider.getSuggestions([typed], 0, typed.length, { signal: AbortSignal.timeout(5000) });
    return (got?.items ?? []).map((item: { value: string }) => item.value);
};
assert.deepEqual(await mid("use the /pic"), ["/picasso"]);
assert.ok(!(await mid("use the /pic")).includes("/skill:picasso"), "no dispatcher prefix mid-sentence");
assert.ok((await mid("use the /call")).includes("/call-council"), "skills only, once");
assert.equal((await mid("use the /call")).length, 1, "the extension twin must not double the row");
assert.equal((await mid("use the /zzz")).length, 0, "no match means no menu");

// Selecting a mid-sentence row keeps the sentence and writes one slash.
const midItem = { value: "/picasso", label: "picasso" };
const midApplied = provider.applyCompletion(["use the /pic"], 0, 12, midItem, "/pic");
assert.equal(midApplied.lines[0], "use the /picasso");

console.log("umbra-skill-matcher: mid-sentence checks passed");
