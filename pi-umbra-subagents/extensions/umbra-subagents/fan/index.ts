import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installBar, setRun } from "../bar.ts";
import { openPanel, type PanelSource } from "../panel.ts";
import { canReach, describeOffer, fanSettings, forget, offerModels, reachableModels, RUN_SH, type Offer } from "./models.ts";
import { findBlock, parseSpec, TEMPLATE } from "./spec.ts";
import { piCommand, reportOf, store, type RunSpec } from "./store.ts";
import type { RunState } from "../skills/delegate/state.ts";

// Wiring only. store.ts owns the branches, bar.ts and panel.ts render them.
//
// Three ways in, all free: `/umb-fan` for the user, a fenced ```fan block in the model's own
// answer, and a bash call that turns out to be the delegate skill — the same run directory
// either way, so the panel does not care which one started it. No pi.registerTool anywhere,
// so the prompt is byte-for-byte unchanged.

// A branch that stopped on a question goes to the model first: most questions are answered by
// the conversation the branch never saw, and only the rest reach the user.
const askingNote = (run: RunState): string => {
	const asking = run.branches.filter((branch) => branch.report === "ASKING");
	if (!asking.length) return "";
	return (
		`\n\n${asking.map((branch) => branch.stem).join(", ")} stopped on a question. Answer it from this ` +
		"conversation if you can; if only the user can decide, ask them with ask_user_question first. " +
		"Then continue each one in a single bash call and read its new report:\n\n" +
		`. '${RUN_SH}'; ${asking.map((branch) => `dresume '${run.dir}' ${branch.stem} '<answer>'`).join("; ")}; wait; ` +
		asking.map((branch) => `cat '${run.dir}/${branch.stem}.md'`).join("; ")
	);
};

// A branch starts with --no-extensions, so a model that only an extension provides is not there
// for it. Rather than guess another one, the model asks the user: which model to spend on is
// theirs to choose.
const modelNote = (missing: string[], offer: Offer): string =>
	`The fan run did not start: branches run without extensions, so ${missing.join(", ")} is not ` +
	"available to them. Ask the user with ask_user_question which model the branches should use, " +
	`offering ${describeOffer(offer)}. Then write the fan block again with \`label@provider/model\` ` +
	"on each branch.";

const modelOf = (ctx: ExtensionContext) =>
	process.env.FAN_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");

// The one adapter between the producer and the two renderers. store keys a branch by its
// stem because that is its filename; the panel hands back the whole BranchView it drew,
// because a row it did not draw must not be stoppable. Converting here keeps both sides
// honest instead of widening either signature to meet the other.
const source: PanelSource = {
	run: () => store.run(),
	stop: (branch) => void store.stop(branch.stem),
	subscribe: (fn) => store.subscribe(fn),
};

export default function (pi: ExtensionAPI) {
	// The widget above the editor, the alt+a shortcut, the /umb-agents command and the down arrow
	// out of the last editor line. All four open the same panel over the same source.
	installBar(pi, (ctx, stem) => openPanel(ctx, source, stem), source.stop);
	// The bar is pushed to rather than polling a second time: store already ticks once a
	// second while branches are live, and a second reader could only disagree with it.
	store.subscribe(() => setRun(store.run()));

	// The run directory this session started, and has therefore promised to report back on.
	// A run the delegate skill started in bash is left alone: that caller reads $run/*.md
	// itself, and a follow-up would hand the model the same text twice.
	let awaiting: string | undefined;

	// Branches must not outlive the pi that started them: nothing would be watching, and a
	// branch left running keeps spending. Their reports are already on disk.
	pi.on("session_shutdown", () => store.stopAll());

	// A bash call may be the delegate skill mid-run. Arming the tick when one starts is what
	// makes a skill-started run appear on the bar from its first frame rather than at the end;
	// the turn's end disarms it, because no bash call outlives its turn.
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName === "bash") store.arm(ctx.cwd);
	});
	pi.on("agent_end", () => store.disarm());
	pi.on("session_start", (_event, ctx) => store.watch(ctx.cwd));

	// Every branch's model is checked before anything is seeded. A model a branch cannot reach
	// stops the run here, with the user told and, for a run the model asked for, the model asked
	// to get a choice from the user. Returns the run directory, or undefined when nothing started.
	const launch = async (spec: RunSpec, ctx: ExtensionContext, brief: string, reply: boolean) => {
		const settings = await fanSettings();
		const fallback = modelOf(ctx);
		const reachable = await reachableModels(piCommand(), settings.load);
		const wanted = [...new Set(spec.phases.flatMap((phase) => phase.branches.map((branch) => branch.model || fallback)))];
		// An empty listing means pi could not be asked, not that nothing is reachable.
		const missing = reachable.length ? wanted.filter((model) => !canReach(model, reachable)) : [];
		if (missing.length) {
			// The user may fix it with /login or models.json before the retry.
			forget(settings.load);
			const offer = offerModels(ctx.cwd, reachable);
			ctx.ui.notify(`fan: ${missing.join(", ")} is not available to branches; pick ${describeOffer(offer)}`, "warning");
			if (reply) pi.sendUserMessage(modelNote(missing, offer), { deliverAs: "followUp" });
			return undefined;
		}
		const dir = store.start(spec, fallback, ctx.cwd, brief, settings);
		if (!dir) ctx.ui.notify("fan: a run is already in flight — stop it from the panel first", "warning");
		return dir;
	};

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
		const text = event.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const block = findBlock(text);
		if (!block) return;
		const spec = parseSpec(block);
		// The whole assistant message, not just the fenced block: the reasoning around the
		// block is the half a branch cannot reconstruct from its own task line.
		// Caught here: a throw after the awaits (a read-only cwd, a full disk) is no longer inside
		// pi's handler, and an unhandled rejection can take pi down with it.
		if (spec)
			launch(spec, ctx, text, true)
				.then((dir) => (awaiting = dir ?? awaiting))
				.catch((error: unknown) => ctx.ui.notify(`fan: ${error instanceof Error ? error.message : String(error)}`, "error"));
	});

	// The branches' answers come back as a follow-up rather than as a tool result: the turn
	// that asked for them already ended, so the model reads them at the top of the next one.
	store.subscribe(() => {
		const run = store.run();
		if (!run || run.dir !== awaiting || run.live) return;
		awaiting = undefined;
		pi.sendUserMessage(`Branch results for ${run.name}:\n\n${reportOf(run)}${askingNote(run)}`, { deliverAs: "followUp" });
	});

	pi.registerCommand("umb-fan", {
		description: "Run parallel pi branches and watch them in the agent panel",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const text = args.trim() || (await ctx.ui.editor("fan", TEMPLATE));
			if (!text) return;
			const spec = parseSpec(text);
			if (!spec) return ctx.ui.notify("fan: no branches in that spec", "warning");
			// Started by the user, so the results are theirs to read on the panel; the model is
			// only told about a run it asked for itself. launch says why when nothing started.
			await launch(spec, ctx, text, false);
		},
	});
}
