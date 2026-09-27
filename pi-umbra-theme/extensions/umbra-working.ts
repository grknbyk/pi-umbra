// The status line beside the spinner, which pi leaves as a fixed "Working" for the whole turn.
// Here it says which of pi's tools is running, how long the turn has taken, and how many output
// tokens it has cost so far.
//
// The words map onto pi's own `ToolCallEvent` union (core/extensions/types.d.ts): eight typed
// tools grouped into four verbs, plus `CustomToolCallEvent` - every extension-registered tool -
// under one word. So the grouping is not a guess about which tools exist; it is that union.
//
// "thought for Ns" appears on the Thinking line alone and counts from zero at each thinking
// block, so it reads as the length of this thought rather than a share of the turn.
//
// This extension also owns the spinner frames. They used to be installed by umbra-inputbar,
// which is where the theme poll below comes from: pi drops the working indicator when the theme
// instance is swapped, so the frames have to go back on. Two extensions writing the same frames
// would mean the last one to run wins, so there is exactly one now.
import type { AgentMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact, elapsed } from "../lib/umbra-format.ts";
import { type UmbraSettings, readUmbraSettings } from "../lib/umbra-settings.ts";

export type Settings = NonNullable<UmbraSettings["working"]>;

// One entry per tool: the word shown while it runs, the animation, and how long one turn of that
// animation takes. Keyed by pi's own tool names, so `settings.working.tools` names the same thing
// pi does and everything about one tool sits in one place.
//
// Three keys are not tools. `thinking` and `idle` are states, and `custom` is the fallback for
// every extension-registered tool - pi's own `CustomToolCallEvent`. A real tool named `custom`
// would win over it, which is the right way round.
//
// Every glyph measures one column through pi's `visibleWidth`. A two-column frame shifts the whole
// status line on every tick, which is what ruled the trigrams (U+2630..) out of Listing. Listing
// bounces rather than sweeping one way: a vertical sweep that resets jumps the full cell height
// and reads as a stutter, which a rotation never does - the shape comes back on its own.
const ARC = ["◜", "◠", "◝", "◞", "◡", "◟"];
const SCAN = ["⎺", "⎻", "⎼", "⎽", "⎼", "⎻"];
const CORNER = ["▖", "▘", "▝", "▗"];
const CLOCK = ["◴", "◷", "◶", "◵"];
const STAR = ["✶", "✸", "✹", "✺", "✻", "✼"];
const BRAILLE = ["⣻", "⢿", "⡿", "⣟", "⣯", "⣷", "⣾", "⣽"];
const DIAMOND = ["◇", "◈", "◆", "◈"];

export type Entry = { label: string; cycleMs: number; frames: string[] };

/**
 * One full turn of the animation, in milliseconds. The sets are 4, 6 and 8 frames long, so a fixed
 * per-frame interval would run them at three different speeds. This is the number held steady and
 * the per-frame interval is derived from it, so changing a set's length changes how fast its
 * frames go by rather than how long the animation takes.
 *
 * Milliseconds, with the unit in the name. `intervalMs` is what pi's own API calls the
 * neighbouring number, and a bare `0.48` would leave both the unit and the scope to be guessed at
 * - the two ways this field would be filled in wrong.
 */
const CYCLE_MS = 480;

const DEFAULTS: Record<string, Omit<Entry, "cycleMs"> & { cycleMs?: number }> = {
	read: { label: "Reading", frames: ARC },
	ls: { label: "Listing", frames: SCAN },
	find: { label: "Searching", frames: SCAN },
	grep: { label: "Searching", frames: SCAN },
	write: { label: "Writing", frames: CORNER },
	edit: { label: "Editing", frames: CORNER },
	bash: { label: "Running", frames: CLOCK },
	powershell: { label: "Running", frames: CLOCK },
	ask_user_question: { label: "Asking", frames: DIAMOND },
	thinking: { label: "Thinking", frames: STAR },
	idle: { label: "Working", frames: BRAILLE },
	custom: { label: "Tool call", frames: DIAMOND },
};

export const THINKING = "thinking";
export const IDLE = "idle";
export const CUSTOM = "custom";

// 250ms is the theme poll umbra-inputbar used. The line itself only changes once a second, and
// setWorkingMessage is skipped when the text is unchanged, so the extra ticks cost nothing.
const TICK_MS = 250;

export type Turn = {
	startedAt: number;
	/** The key the line is currently showing: a tool name, or thinking/idle/custom. */
	key: string;
	/** When the current thinking block began. Undefined whenever the key is not `thinking`. */
	thinkingAt: number | undefined;
	/** Output tokens from messages already ended this turn. */
	settled: number;
	/** Output tokens of the message still streaming, as far as the provider has reported them. */
	streaming: number;
	/**
	 * A message is streaming right now. claude-bridge reports a message's output tokens only at
	 * its start and end, so while one streams the count is estimated from its text and shown
	 * with a "~"; the message's end swaps in the exact figure.
	 */
	open: boolean;
};

export type Options = { tokens: boolean; elapsed: boolean };

export const newTurn = (now: number): Turn => ({
	startedAt: now,
	key: IDLE,
	thinkingAt: undefined,
	settled: 0,
	streaming: 0,
	open: false,
});

/**
 * Settings merge field by field, so `{ fabric_exec: { label: "Fabric" } }` renames it and keeps
 * the fallback animation. A `frames` array replaces outright rather than merging, which is what
 * lets a three-glyph override stay three; an empty one is not an override.
 */
/** The title the tool card gives a tool it has no word for: `web_search` → `Web Search`. */
export const humanize = (name: string): string =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());

export const entryFor = (key: string, settings: Settings = {}, cycleMs = CYCLE_MS): Entry => {
	const base = DEFAULTS[key] ?? DEFAULTS[CUSTOM]!;
	const named = settings.tools?.[key] ?? {};
	// A tool umbra has no verb for shows the name its card shows, unless `custom` was renamed.
	const fallback = DEFAULTS[key]?.label ?? settings.tools?.[CUSTOM]?.label ?? humanize(key);
	return {
		label: named.label ?? fallback,
		cycleMs: named.cycleMs ?? base.cycleMs ?? cycleMs,
		frames: named.frames?.length ? named.frames : base.frames,
	};
};

export const labelFor = (key: string, settings: Settings = {}): string => entryFor(key, settings).label;

/**
 * The fastest a spinner frame may come round: what the 8-frame set ran at before it was locked to
 * the wave. Every frame is a full pi render, and in a long session one costs tens of milliseconds,
 * so a spinner locked to a fast wave (classic 2: a 250 ms loop, 31 ms frames) kept a core busy.
 */
const MIN_FRAME_MS = 60;

/**
 * The spinner's loop when a shimmer runs: a whole number of loops per wave, so glyph and wave
 * start over together. The count comes from the wave at speed 1 (2000 ms classic / 480 = 4,
 * 2200 ms kitt = 5), so a shimmer speed scales the spinner by the same factor, and drops one loop
 * at a time while a frame would come round faster than MIN_FRAME_MS. The loop still divides the
 * wave, so the two stay in step; a set with more frames just turns fewer times per wave.
 */
export const syncedCycleMs = (periodMs: number, speed: number, frames = 1): number => {
	let loops = Math.max(1, Math.round((periodMs * speed) / CYCLE_MS));
	while (loops > 1 && periodMs / loops / frames < MIN_FRAME_MS) loops--;
	return periodMs / loops;
};

type Wave = { periodMs: number; speed: number };

const shimmerWave = (): Wave | undefined => {
	const shimmer = (globalThis as { __umbraShimmer?: Partial<Wave> }).__umbraShimmer;
	return shimmer?.periodMs && shimmer.speed ? { periodMs: shimmer.periodMs, speed: shimmer.speed } : undefined;
};

export const indicatorFor = (
	key: string,
	settings: Settings = {},
	wave?: Wave,
): { frames: string[]; intervalMs: number } => {
	const frameCount = entryFor(key, settings).frames.length;
	const { cycleMs, frames } = entryFor(key, settings, wave ? syncedCycleMs(wave.periodMs, wave.speed, frameCount) : CYCLE_MS);
	return { frames, intervalMs: Math.round(cycleMs / frames.length) };
};

export const statusLine = (turn: Turn, now: number, options: Options, settings: Settings = {}): string => {
	const parts: string[] = [];
	if (options.elapsed) parts.push(elapsed(now - turn.startedAt));
	const tokens = turn.settled + turn.streaming;
	if (options.tokens && tokens > 0) parts.push(`↓ ${turn.open ? "~" : ""}${compact(tokens)} tokens`);
	if (turn.key === THINKING && turn.thinkingAt !== undefined) {
		parts.push(`thought for ${elapsed(now - turn.thinkingAt)}`);
	}
	const label = labelFor(turn.key, settings);
	return parts.length === 0 ? `${label}…` : `${label}… (${parts.join(" · ")})`;
};

const outputOf = (message: AgentMessage): number =>
	(message as { usage?: { output?: number } }).usage?.output ?? 0;

type Block = { text?: string; thinking?: string; arguments?: unknown };

/**
 * The provider's count or, when that lags, the streamed text at ~4 characters a token.
 * ponytail: chars/4 runs 10-30% off on Turkish and code; a real tokenizer is the upgrade.
 */
export const streamingOf = (message: AgentMessage): number => {
	const content = (message as { content?: unknown }).content;
	let chars = 0;
	if (Array.isArray(content)) {
		for (const block of content as Block[]) {
			chars += (block.text ?? block.thinking ?? "").length;
			if (block.arguments !== undefined) chars += JSON.stringify(block.arguments).length;
		}
	}
	return Math.max(outputOf(message), Math.ceil(chars / 4));
};

export default function working(pi: ExtensionAPI) {
	// /new, /resume and /fork replace the session and fire session_start again. This used to start
	// a fresh timer and a fresh set of handlers each time, and the old timer kept painting through
	// the old session's ctx; pi 0.87 made that ctx throw once replaced, which took the whole process
	// down on /new. So there is one timer and one set of handlers for the extension's lifetime, and
	// a session change only swaps the ctx they paint through.
	let ctx: ExtensionContext | undefined;
	let settings: Settings = {};
	let options: Options = { tokens: true, elapsed: true };
	let turn: Turn | undefined;
	let sent: string | undefined;
	let theme: unknown;
	let installed: string | undefined; // the key whose frames are on the indicator
	let cycle: string | undefined; // the wave they were locked to
	let timer: ReturnType<typeof setInterval> | undefined;

	const paint = () => {
		if (ctx === undefined) return;
		// Two reasons to reinstall: the key moved, or the theme instance was swapped. pi clears
		// the indicator with the old theme and would otherwise fall back to its own frames.
		const key = turn?.key ?? IDLE;
		// A third reason: /umb-shimmer changed the wave the spinner is locked to.
		const wave = shimmerWave();
		const wanted = wave ? `${wave.periodMs}/${wave.speed}` : "";
		if (ctx.ui.theme !== theme || key !== installed || wanted !== cycle) {
			cycle = wanted;
			theme = ctx.ui.theme;
			installed = key;
			ctx.ui.setWorkingIndicator(indicatorFor(key, settings, wave));
		}
		if (turn === undefined) return;
		const line = statusLine(turn, Date.now(), options, settings);
		if (line === sent) return;
		sent = line;
		ctx.ui.setWorkingMessage(line);
	};

	pi.on("session_start", (_event, startedCtx: ExtensionContext) => {
		ctx = startedCtx;
		settings = readUmbraSettings().working ?? {};
		options = { tokens: settings.tokens !== false, elapsed: settings.elapsed !== false };
		turn = undefined;
		sent = undefined;
		theme = undefined;
		installed = undefined;
		if (timer !== undefined) return;
		timer = setInterval(paint, TICK_MS);
		timer.unref();
	});

	// Only the session being painted stops the painting: a shutdown that arrives after the next
	// session has already started belongs to the old one.
	pi.on("session_shutdown", (_event, endedCtx: ExtensionContext) => {
		if (endedCtx.sessionManager !== ctx?.sessionManager) return;
		ctx = undefined;
		clearInterval(timer);
		timer = undefined;
	});

	// pi resets its own working message when a turn opens, so ours has to be written after.
	pi.on("agent_start", () => {
		turn = newTurn(Date.now());
		sent = undefined;
		paint();
	});
	pi.on("agent_end", (_event, endedCtx: ExtensionContext) => {
		turn = undefined;
		sent = undefined;
		endedCtx.ui.setWorkingMessage();
	});

	pi.on("tool_call", (event) => {
		if (turn === undefined) return;
		// The raw tool name is the key; entryFor maps it, and an unmapped one lands on `custom`.
		turn.key = event.toolName;
		turn.thinkingAt = undefined;
		paint();
	});
	pi.on("tool_result", () => {
		if (turn === undefined) return;
		turn.key = IDLE;
		paint();
	});

	pi.on("message_update", (event) => {
		if (turn === undefined) return;
		turn.streaming = streamingOf(event.message);
		turn.open = true;
		const kind = (event.assistantMessageEvent as { type?: string }).type;
		if (kind === "thinking_start") {
			turn.key = THINKING;
			turn.thinkingAt = Date.now();
		} else if (kind === "thinking_end") {
			turn.key = IDLE;
			turn.thinkingAt = undefined;
		}
		paint();
	});
	pi.on("message_end", (event) => {
		if (turn === undefined) return;
		turn.settled += outputOf(event.message);
		turn.streaming = 0;
		turn.open = false;
	});
}
