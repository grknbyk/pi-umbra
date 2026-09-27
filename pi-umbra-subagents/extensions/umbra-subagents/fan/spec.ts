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
//
// Phases run in order; every branch inside one phase runs at the same time.

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
			const [label, model] = key.split("@");
			if (label) phase.branches.push({ label, model, task: value });
		}
	}
	spec.phases = spec.phases.filter((phase) => phase.branches.length > 0);
	if (!spec.phases.length) return undefined;
	if (!spec.name) spec.name = spec.phases[0]?.branches[0]?.label ?? "run";
	return spec;
};

const pushPhase = (spec: RunSpec, title: string) => {
	const phase = { title, branches: [] as { label: string; model?: string; task: string }[] };
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
`);
	if (!spec) throw new Error("parseSpec returned undefined for a valid spec");
	console.assert(spec.name === "toolcall", "name");
	console.assert(spec.description === "Map how pi renders tool calls", "desc");
	console.assert(spec.phases.length === 2, `expected 2 phases, got ${spec.phases.length}`);
	console.assert(spec.phases[0]?.title === "Branches", "implicit first phase");
	console.assert(spec.phases[0]?.branches[0]?.task === "Read tui.d.ts:68 and report.", "colon in task");
	console.assert(spec.phases[1]?.branches[0]?.model === "openai/gpt-5", "per-branch model");
	const free = spec.phases[1]?.branches[1];
	console.assert(free?.model === "openrouter/nvidia/nemotron-3-super-120b-a12b:free", "colon in model");
	console.assert(free?.task === "Check src/a.ts:12.", "task after a model with a colon");
	console.assert(parseSpec("name: empty") === undefined, "a spec with no branches is not a run");
	console.assert(findBlock("blah\n```fan\nx: y\n```\nblah") === "x: y\n", "block extraction");
	console.log("spec.ts ok");
};

if (process.argv[1]?.endsWith("spec.ts")) demo();
