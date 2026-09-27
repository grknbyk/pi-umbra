// /umb-rename writes two names through two different APIs, and the terminal title is built from
// a third value. A fake pi is enough to pin all three, because the command is the whole extension.
//
//   bun run umbra-rename.check.ts
import assert from "node:assert";
import rename from "../extensions/umbra-rename.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;

const load = (sessionName?: string) => {
	const calls = { name: undefined as string | undefined, title: undefined as string | undefined, notice: "" };
	let handler: Handler | undefined;
	const pi = {
		registerCommand: (_name: string, options: { handler: Handler }) => void (handler = options.handler),
		getSessionName: () => sessionName,
		setSessionName: (value: string) => void (calls.name = value),
	};
	rename(pi as never);
	const ctx = {
		ui: {
			setTitle: (value: string) => void (calls.title = value),
			notify: (value: string) => void (calls.notice = value),
			input: async () => prompted,
		},
		sessionManager: { getCwd: () => "/home/me/projects/real-estate" },
	};
	return { calls, run: (args: string) => handler!(args, ctx) };
};

let prompted: string | undefined;

// The argument form. The prefix goes on the terminal title only: pi already spells the session
// name on the input bar, so a π in the name itself would show up three times in two places.
const given = load();
await given.run("  ledger  ");
assert.equal(given.calls.name, "ledger", "the name is trimmed and carries no prefix");
assert.equal(given.calls.title, "π - ledger - real-estate", "the title carries the prefix and the cwd");
assert.equal(given.calls.notice, "renamed: ledger");

// No argument: pi asks, and the current name is the prefill.
prompted = "ledger";
const asked = load("old-name");
await asked.run("");
assert.equal(asked.calls.name, "ledger", "the answer to the prompt is the new name");

// Nothing typed, or the prompt dismissed, must leave both names alone rather than blanking them.
for (const answer of [undefined, "", "   "]) {
	prompted = answer;
	const cancelled = load("old-name");
	await cancelled.run("");
	assert.equal(cancelled.calls.name, undefined, `"${answer}" must not rename`);
	assert.equal(cancelled.calls.title, undefined, `"${answer}" must not retitle`);
}

console.log("umbra-rename.check.ts ok - argument form, prompt form, 3 cancel cases");
