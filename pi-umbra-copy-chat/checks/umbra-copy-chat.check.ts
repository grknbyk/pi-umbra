// The three things in copy-chat.ts that go wrong silently: a rewound session copies both the
// abandoned branch and the live one, a fence inside a tool result closes the wrapper early and
// turns the rest of the transcript into prose, and the clock drops the day it belongs to.
//
//   bun run umbra-copy-chat.check.ts
import assert from "node:assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fence, stamp, transcribe } from "../extensions/umbra-copy-chat.ts";

// A fence has to outlast whatever it wraps. Two backticks is the floor, so ordinary prose still
// gets three and reads as a normal code block.
assert.ok(fence("plain").startsWith("```\n"), "ordinary text gets the usual three backticks");
assert.ok(fence("a ``` b").startsWith("````\n"), "a three-run inside pushes the wrapper to four");
assert.ok(fence("a ````` b").startsWith("``````\n"), "and a five-run pushes it to six");
assert.equal(fence("x", "json").split("\n")[0], "```json", "the language tag rides on the opening fence");
assert.ok(fence("a ``` b").endsWith("\n````"), "the closing fence matches the opening one");

// The branch comes from pi, so a rewind and a /tree with no new message yet copy what is on
// screen, not the turns a /tree walked back over.
const session = SessionManager.inMemory();
const say = (role: "user" | "assistant", text: string) =>
	session.appendMessage(
		(role === "user"
			? { role, content: text, timestamp: 0 }
			: { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }) as never,
	);
const asked = say("user", "first question");
say("assistant", "first answer");
say("user", "WRONG attempt");
session.branch(asked);
say("assistant", "second try");
const copied = () => transcribe(session.getBranch() as never);
assert.ok(copied().includes("second try") && !copied().includes("WRONG"), "a rewind drops the abandoned turn");
session.branch(asked);
assert.ok(!copied().includes("second try"), "a /tree back copies only what is on screen");

// The day is written once, then only when it changes, so a session that runs past midnight still
// says which side of it a turn is on.
const [first, day] = stamp("2026-09-07T00:31:00", undefined);
assert.equal(first, "2026-09-07 00:31", "the first stamp carries the full date");
assert.equal(stamp("2026-09-07T00:33:00", day)[0], "00:33", "the same day is time only");
assert.equal(stamp("2026-09-08T01:00:00", day)[0], "2026-09-08 01:00", "a new day carries the date again");

// End to end: what goes in, and what is left out for belonging to the process rather than to
// the conversation.
const entries = [
	{ type: "session", id: "s", message: undefined },
	{ type: "message", id: "a", timestamp: "2026-09-07T00:31:00", message: { role: "user", content: "hi" } },
	{ type: "model_change", id: "b", parentId: "a" },
	{
		type: "message",
		id: "c",
		parentId: "b",
		timestamp: "2026-09-07T00:31:00",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "weigh it" },
				{ type: "toolCall", name: "read", arguments: { path: "x.md" } },
				{ type: "text", text: "done" },
			],
		},
	},
	{
		type: "message",
		id: "d",
		parentId: "c",
		timestamp: "2026-09-07T00:32:00",
		message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] },
	},
]

const out = transcribe(entries as never);
assert.ok(out.startsWith("# user · 2026-09-07 00:31"), "the transcript opens on the first user message");
assert.ok(out.includes("## thinking · 00:31"), "thinking is kept");
assert.ok(out.includes('"path": "x.md"'), "tool arguments are kept in full");
assert.ok(out.includes("## result (error) · read"), "a failed result says so in its heading");
assert.ok(out.includes("ENOENT"), "and still carries its output");
assert.ok(!out.includes("model_change"), "model_change belongs to the process, not the conversation");
assert.equal(transcribe([]), "", "an empty session copies nothing rather than a bare heading");

console.log("umbra-copy-chat.check.ts ok - fence 5 cases, branch 2 cases, clock 3 cases, transcript 7 cases");
