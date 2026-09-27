import assert from "node:assert";
import type { RunSpec } from "./store.ts";

// The one text format a run is described in. `/umb-fan` opens it in an editor, and the fan
// skill tells the model to emit the same thing in a ```fan block, so there is one parser
// and no schema for the model to get wrong.
//
//   name: pi-toolcall-render
//   desc: Map how pi renders tool calls
//   # Map
//   core-render: Read the render path and report where a tool call becomes lines.
//   omp-intercept@openai/gpt-5: Check whether an extension can override it.
//   # Design
//   proposal: Given the Map phase, write the design.
//   prototype [write]: Build the smallest version of it and run the tests.
//
// Phases run in order; every branch inside one phase runs at the same time. A branch is
// read-only unless its key carries `[write]`: then it works in its own git worktree.

export const TEMPLATE = ["name: ", "desc: ", "# Phase one", "label: task", ""].join("\n");

export const parseSpec = (text: string): RunSpec | undefined => {
	const spec: RunSpec = { name: "", description: "", phases: [] };
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("//")) continue;
		if (line.startsWith("#")) {
			spec.phases.push({ title: line.replace(/^#+\s*/, "") || `Phase ${spec.phases.length + 1}`, branches: [] });
			continue;
		}
		// A task is full of colons (file:line, URLs), so the key ends at the first one. A model id
		// can carry colons too (`openrouter/x:free`, `openai/gpt-5:high`), so a key with `@` ends
		// at the first colon followed by a space instead, falling back to the first colon.
		const spaced = line.search(/:(\s|$)/);
		const colon = /^[^:\s]+@/.test(line) && spaced !== -1 ? spaced : line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!value) continue;
		if (key === "name") spec.name = value;
		else if (key === "desc") spec.description = value;
		else {
			// A branch before any "#" gets an implicit first phase, so the common
			// single-phase run needs no header at all.
			const phase = spec.phases[spec.phases.length - 1] ?? pushPhase(spec, "Branches");
			const write = /\s*\[write\]$/i.test(key);
			const [label, model] = key.replace(/\s*\[write\]$/i, "").split("@");
			if (label) phase.branches.push({ label, model, task: value, ...(write ? { write } : {}) });
		}
	}
	spec.phases = spec.phases.filter((phase) => phase.branches.length > 0);
	if (!spec.phases.length) return undefined;
	if (!spec.name) spec.name = spec.phases[0]?.branches[0]?.label ?? "run";
	return spec;
};

const pushPhase = (spec: RunSpec, title: string) => {
	const phase = { title, branches: [] as RunSpec["phases"][number]["branches"] };
	spec.phases.push(phase);
	return phase;
};

/** The fenced block the fan skill tells the model to write. */
export const findBlock = (text: string) => /```fan\s*\n([\s\S]*?)```/.exec(text)?.[1];

// One check for the two things that are easy to get wrong: a colon inside a task, and a
// branch written before any phase header.
const demo = () => {
	const spec = parseSpec(`
name: toolcall
desc: Map how pi renders tool calls
lone: Read tui.d.ts:68 and report.
# Design
plan@openai/gpt-5: Write it up.
free@openrouter/nvidia/nemotron-3-super-120b-a12b:free: Check src/a.ts:12.
fix [write]: Patch src/a.ts:12.
fast@openai/gpt-5 [write]: Patch it again.
`);
	if (!spec) throw new Error("parseSpec returned undefined for a valid spec");
	assert(spec.name === "toolcall", "name");
	assert(spec.description === "Map how pi renders tool calls", "desc");
	assert(spec.phases.length === 2, `expected 2 phases, got ${spec.phases.length}`);
	assert(spec.phases[0]?.title === "Branches", "implicit first phase");
	assert(spec.phases[0]?.branches[0]?.task === "Read tui.d.ts:68 and report.", "colon in task");
	assert(spec.phases[1]?.branches[0]?.model === "openai/gpt-5", "per-branch model");
	const free = spec.phases[1]?.branches[1];
	assert(free?.model === "openrouter/nvidia/nemotron-3-super-120b-a12b:free", "colon in model");
	assert(free?.task === "Check src/a.ts:12.", "task after a model with a colon");
	const [fix, fast] = [spec.phases[1]?.branches[2], spec.phases[1]?.branches[3]];
	assert(fix?.label === "fix" && fix.write === true && fix.task === "Patch src/a.ts:12.", "[write]");
	assert(fast?.label === "fast" && fast.model === "openai/gpt-5" && fast.write === true, "[write] after a model");
	assert(spec.phases[0]?.branches[0]?.write === undefined, "read-only by default");
	assert(parseSpec("name: empty") === undefined, "a spec with no branches is not a run");
	assert(findBlock("blah\n```fan\nx: y\n```\nblah") === "x: y\n", "block extraction");
	console.log("spec.ts ok");
};

if (process.argv[1]?.endsWith("spec.ts")) demo();
