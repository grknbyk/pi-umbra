import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The editor's submit path is not on the extension API, so repatch.mjs publishes it.
const submit = (text: string) => (globalThis as any).__piSubmit?.(text);

const DEFAULT_PROMPT = "Continue.";
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };
// "90s", "10 min", "1h30m" — a run of number+unit pairs at the very start of the args. A unit
// ends at any non-letter, not at \b, which never falls between "h" and "30".
const DURATION = /^(?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])\s*)+/i;
const COUNT = /^(\d+)\s*/;
const RESUBMIT_DELAY_MS = 50;

type Loop = { prompt: string; iterations?: number; deadline?: number; done: number };

const durationMs = (text: string) =>
	[...text.matchAll(/(\d+)\s*([a-z]+)/gi)].reduce(
		(sum, [, amount, unit]) => sum + Number(amount) * UNIT_MS[unit[0].toLowerCase()],
		0,
	);

const parse = (args: string): Loop => {
	const trimmed = args.trim();
	const rest = (from: string) => trimmed.slice(from.length).trim() || DEFAULT_PROMPT;

	const duration = trimmed.match(DURATION);
	if (duration) return { prompt: rest(duration[0]), deadline: Date.now() + durationMs(duration[0]), done: 0 };

	const count = trimmed.match(COUNT);
	if (count) {
		// 0 means "no limit". Either branch strips the number from the prompt, so
		// "/umb-loop 0 fix the tests" submits "fix the tests", not "0 fix the tests".
		const iterations = Number(count[1]);
		return iterations > 0
			? { prompt: rest(count[0]), iterations, done: 0 }
			: { prompt: rest(count[0]), done: 0 };
	}

	return { prompt: trimmed || DEFAULT_PROMPT, done: 0 };
};

export default function (pi: ExtensionAPI) {
	let loop: Loop | undefined;
	let cancelled = false;

	const describe = () => {
		if (!loop) return undefined;
		if (loop.iterations) return `loop ${loop.done}/${loop.iterations}`;
		if (loop.deadline) return `loop ${Math.max(0, Math.round((loop.deadline - Date.now()) / 1000))}s`;
		return `loop ${loop.done}`;
	};

	const stop = (ctx: ExtensionContext, reason: string) => {
		loop = undefined;
		ctx.ui.setStatus("loop", undefined);
		ctx.ui.notify(reason);
	};

	pi.registerCommand("umb-loop", {
		description: "Toggle automatic resubmission after each yield: /umb-loop [count|duration] [prompt]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (loop) return stop(ctx, "loop off");
			// Without the patch nothing would ever be sent, while the status claimed a running loop.
			if (!(globalThis as any).__piSubmit) {
				return ctx.ui.notify("umb-loop needs its patch: run pi-umbra-subagents/patch.mjs, then restart pi", "warning");
			}

			loop = parse(args);
			cancelled = false;
			ctx.ui.setStatus("loop", describe());
			ctx.ui.notify(`loop on — "${loop.prompt}"`);
			if (ctx.isIdle()) {
				loop.done++;
				submit(loop.prompt);
			}
		},
	});

	// An aborted run (Escape) keeps the loop armed but skips this yield, so the turn comes back to
	// the user. Read from how the run ended, not from the Escape key: an Escape that only closed a
	// panel or an autocomplete list aborts nothing and must not stall the loop.
	pi.on("agent_end", (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (loop && last && "stopReason" in last && last.stopReason === "aborted") cancelled = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!loop) return;
		if (cancelled) {
			cancelled = false;
			ctx.ui.notify("loop: iteration cancelled");
			return;
		}
		if (loop.deadline && Date.now() >= loop.deadline) return stop(ctx, "loop done (time up)");
		if (loop.iterations && loop.done >= loop.iterations) return stop(ctx, "loop done");

		loop.done++;
		ctx.ui.setStatus("loop", describe());
		const prompt = loop.prompt;
		setTimeout(() => loop && submit(prompt), RESUBMIT_DELAY_MS);
	});
}
