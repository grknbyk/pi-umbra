// A wave of colour running through the working indicator, over both the spinner and the text.
//
// pi builds that indicator with a colour function already in hand - the editor embeds the working
// status, so pi hands it the editor's border colour - and paints custom spinner frames verbatim,
// skipping the colour step for them entirely. repatch stands both of those down when a shimmer is
// installed and routes the two colour functions here. With nothing installed pi keeps its own
// behaviour, so the patches are inert on their own.
//
// The highlight is not one colour. It travels from the theme's bright accent down to its main
// colour and back, blending the whole way rather than stepping, so the band changes tone while it
// moves. Topping out at pure white read as a glint from outside the palette on warm themes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MODES = ["classic", "kitt", "off"] as const;
export type Mode = (typeof MODES)[number];
export type Spec = { mode: Mode; speed: number };

const FILE = join(homedir(), ".pi", "agent", "shimmer");

// One pass of the wave at speed 1. kitt is quicker because it covers the same ground twice.
const CLASSIC_MS = 2000;
const KITT_MS = 1100;

// How long the highlight takes to travel the whole ramp and come back. Deliberately not a
// multiple of either sweep, so the tone lands somewhere new on every pass instead of arriving
// in the same colour each time.
const TONE_MS = 3300;

// Half the band's width, as a share of the line. kitt's is tighter - a scanner, not a sweep.
const CLASSIC_BAND = 0.18;
const KITT_BAND = 0.12;

// Below a quarter speed the wave stops reading as motion; above eight it is a flicker.
const SLOWEST = 0.25;
const FASTEST = 8;

type Rgb = [number, number, number];
type Paint = (text: string) => string;
type Palette = { fg: (color: string, text: string) => string };

// The ramp the highlight travels: the peak, the theme's main colour lifted most of the way to
// it, the same colour lifted a little, then the colour itself. Written as how far each stop sits
// from the accent toward the peak, so every theme gets the same shape in its own hue.
const TOWARD_PEAK = [1, 0.75, 0.35, 0];
const WHITE: Rgb = [255, 255, 255];

/** The width the wave travels over when the message has not been seen yet. */
const NOMINAL = 34;

/** The colour pi would paint with, read back out of the escape it emits. */
// There is no API for a theme's raw values, and parsing the theme file again would miss the
// live one during a /settings preview. Painting one character and reading the escape asks the
// same object pi is about to paint with.
export const toneOf = (theme: Palette, key: string): Rgb | undefined => {
	const found = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(theme.fg(key, "x"));
	return found === null ? undefined : [Number(found[1]), Number(found[2]), Number(found[3])];
};

export const blend = (from: Rgb, to: Rgb, amount: number): Rgb => [
	Math.round(from[0] + (to[0] - from[0]) * amount),
	Math.round(from[1] + (to[1] - from[1]) * amount),
	Math.round(from[2] + (to[2] - from[2]) * amount),
];

const ink = ([r, g, b]: Rgb, text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;

/** Where on the ramp the highlight is at time `ms`, blended rather than stepped. */
// Stepping from one stop to the next makes the whole line jump colour between two frames. The
// ramp is walked there and back rather than wrapping, so white never cuts straight back to the
// accent at the seam.
export const highlight = (accent: Rgb, ms: number, speed: number, peak: Rgb = WHITE): Rgb => {
	const stops = TOWARD_PEAK.map((toward) => blend(accent, peak, toward));
	const period = (TONE_MS * 2) / speed;
	const phase = (ms % period) / period;
	const along = (phase < 0.5 ? phase * 2 : 2 - phase * 2) * (stops.length - 1);
	const at = Math.min(stops.length - 2, Math.floor(along));
	return blend(stops[at] as Rgb, stops[at + 1] as Rgb, along - at);
};

/** How much of the highlight column `index` gets: 1 at the middle of the band, 0 outside it. */
export const strength = (index: number, middle: number, half: number): number =>
	half <= 0 ? 0 : Math.max(0, 1 - Math.abs(index - middle) / half);

/** Where the band sits at time `ms`, in columns. */
// classic starts a band-width off the left edge and ends one off the right, so the wave enters
// and leaves rather than appearing mid-line. kitt turns around at both ends, and eases into the
// turn - a linear bounce reads as a hard bounce off a wall.
export const middleAt = (mode: Mode, ms: number, width: number, speed: number): number => {
	if (mode === "kitt") {
		const period = (KITT_MS * 2) / speed;
		const phase = (ms % period) / period;
		const there = phase < 0.5 ? phase * 2 : 2 - phase * 2;
		return there * there * (3 - 2 * there) * width;
	}
	const period = CLASSIC_MS / speed;
	const travel = width * (1 + CLASSIC_BAND * 2);
	return ((ms % period) / period) * travel - width * CLASSIC_BAND;
};

/** One full pass of the wave: a sweep for classic, there and back for kitt. `off` has no period. */
export const periodMs = (spec: Spec): number | undefined =>
	spec.mode === "off" ? undefined : spec.mode === "kitt" ? (KITT_MS * 2) / spec.speed : CLASSIC_MS / spec.speed;

/** `classic`, `kitt 3`, `off`. A speed that makes no sense is not a reason to refuse the mode. */
export const parseSpec = (text: string): Spec | undefined => {
	const [name, rate] = text.trim().split(/\s+/);
	if (!(MODES as readonly string[]).includes(name ?? "")) return undefined;
	const asked = Number(rate);
	const speed = Number.isFinite(asked) && asked > 0 ? Math.min(FASTEST, Math.max(SLOWEST, asked)) : 1;
	return { mode: name as Mode, speed };
};

// The spinner and the message are painted by two separate calls, and only the second one knows
// how long the line is. Remembering it keeps both in the same coordinate space, so the band
// crosses the glyph and the text as one wave instead of two.
let span = NOMINAL;

const wave = (theme: Palette, spec: Spec, text: string, offset: number): string => {
	const base = toneOf(theme, "muted");
	const accent = toneOf(theme, "accent");
	if (base === undefined || accent === undefined) return theme.fg("muted", text);
	// borderAccent is the accent's own bright step in every umbra theme (accentBright).
	const peak = toneOf(theme, "borderAccent") ?? WHITE;

	const now = Date.now();
	const high = highlight(accent, now, spec.speed, peak);
	const middle = middleAt(spec.mode, now, span, spec.speed);
	const half = span * (spec.mode === "kitt" ? KITT_BAND : CLASSIC_BAND);
	return [...text]
		.map((glyph, at) => ink(blend(base, high, strength(offset + at, middle, half)), glyph))
		.join("");
};

export const painters = (theme: Palette, spec: Spec): { spinner: Paint; message: Paint } =>
	spec.mode === "off"
		? { spinner: (text) => theme.fg("muted", text), message: (text) => theme.fg("muted", text) }
		: {
				spinner: (text) => wave(theme, spec, text, 0),
				message: (text) => {
					span = text.length + 2; // the glyph and the space pi puts after it
					return wave(theme, spec, text, 2);
				},
			};

const DEFAULT: Spec = { mode: "classic", speed: 1 };

const read = (): Spec => (existsSync(FILE) ? (parseSpec(readFileSync(FILE, "utf8")) ?? DEFAULT) : DEFAULT);

const written = (spec: Spec) => (spec.speed === 1 ? spec.mode : `${spec.mode} ${spec.speed}`);

const install = (ctx: ExtensionContext | ExtensionCommandContext, spec: Spec): void => {
	// Read the theme on every call rather than closing over it: pi swaps the theme object during
	// a /settings preview, and a captured one would shimmer in the palette of the theme that was
	// active when the command ran.
	const live = painters({ fg: (color, text) => ctx.ui.theme.fg(color as never, text) }, spec);
	// umbra-working reads periodMs and speed to lock the spinner to the wave.
	(globalThis as { __umbraShimmer?: unknown }).__umbraShimmer = { ...live, periodMs: periodMs(spec), speed: spec.speed };
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		install(ctx, read());
	});

	pi.registerCommand("umb-shimmer", {
		description: "Working indicator animation: /umb-shimmer classic | kitt | off [speed]",
		// Both fields, and null rather than an empty list: pi reads `label` when it applies a
		// completion, so an item carrying only `value` takes the whole process down on the first
		// Tab. That is an uncaughtException, not a caught extension error.
		getArgumentCompletions(text: string) {
			const items = MODES.filter((mode) => mode.startsWith(text.trim())).map((mode) => ({ value: mode, label: mode }));
			return items.length > 0 ? items : null;
		},
		handler: (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim() === "") {
				return ctx.ui.notify(`Now: ${written(read())}. /umb-shimmer ${MODES.join(" | ")} [speed]`, "info");
			}
			const spec = parseSpec(args);
			if (spec === undefined) {
				return ctx.ui.notify(`No such shimmer: ${args.trim()}. One of: ${MODES.join(", ")}`, "warning");
			}
			writeFileSync(FILE, written(spec));
			install(ctx, spec);
			ctx.ui.notify(`Shimmer: ${written(spec)}.`, "info");
		},
	});
}
