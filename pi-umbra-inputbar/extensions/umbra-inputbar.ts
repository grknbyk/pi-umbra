// The input bar: the session name on its top border (right side) and /umb-color for its border
// colour. Both ride on pi's own extension point - ctx.ui.setEditorComponent with a subclass of
// CustomEditor - so no bundle patch is involved. The name is read from pi.getSessionName() at
// every render, so /umb-rename shows on the next repaint; /umb-color persists in
// ~/.pi/agent/input-color.
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COLOR_FILE = join(homedir(), ".pi", "agent", "input-color");
const HEX = /^#[0-9a-f]{6}$/i;
// The palette /umb-color offers: the Tailwind 400 family, which reads on every dark theme.
export const NAMED: Record<string, string> = {
	red: "#ff6467",
	orange: "#ff8904",
	yellow: "#ffb900",
	green: "#00d492",
	cyan: "#00d3f2",
	blue: "#51a2ff",
	purple: "#a78bfa",
	pink: "#fb64b6",
};
const NAMES = ["off", ...Object.keys(NAMED)];

type Paint = (s: string) => string;
// The factory type lives on the ui context, not on the package root.
type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
let paint: Paint | undefined; // the /umb-color override; undefined = the theme's border colour
let sessionName: () => string | undefined = () => undefined;
let ui: ExtensionContext["ui"] | undefined;
// Down pressed where the editor has nowhere left to go. pi keeps one editor per session, so this
// one announces it on pi's event bus ("editor:down-at-end") for whoever wants the key, the agent
// panel today, instead of each of them installing a rival editor that load order then picks.
let downAtEnd: () => void = () => {};
// A held key keeps arriving after the cursor reaches the end. Only a fresh press counts, or
// holding Down to the bottom of a long draft would fall through into whatever listens.
const BURST_MS = 150;
let lastDown = 0;

// Neither the terminal background nor the spinner frames are handled here. umbra-background owns
// the first and umbra-working the second. Both were written from two files at once for a while,
// and in each case the last writer won at random.

// Right-aligns the label inside the last run of "─" on an already rendered border line, leaving
// the working spinner pi embeds on the left alone. Too little room: the line is returned unchanged.
//
// The label is painted rather than left to inherit the border, so the session name reads in the
// same colour as the "Working" text at the other end of the row. Its colour reset would hand the
// rest of the line back to the terminal default, so the two dashes after it are repainted.
export const withTitle = (
	line: string,
	label: string | undefined,
	paintLabel: Paint = (s) => s,
	paintTail: Paint = (s) => s,
): string => {
	if (!label) return line;
	const text = ` ${label} `;
	const w = visibleWidth(text);
	return line.replace(/─{2,}(?!.*─)/s, (run) =>
		run.length >= w + 4 ? "─".repeat(run.length - w - 2) + paintLabel(text) + paintTail("──") : run,
	);
};

// A palette name (or a raw "#rrggbb") paints truecolor; "off" restores the theme's border.
export const resolvePaint = (spec: string): Paint | undefined => {
	if (spec === "off") return undefined;
	const hex = NAMED[spec] ?? (HEX.test(spec) ? spec : undefined);
	if (!hex) throw new Error(`unknown colour "${spec}" - one of: ${NAMES.join(", ")}`);
	const on = `\x1b[38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
	return (s) => `${on}${s}\x1b[39m`;
};
export const paintWith = (spec: string): Paint | undefined => (paint = resolvePaint(spec));

// pi's multi-line Editor has no `prompt` option (only the one-line Input does), so the chevron is
// a gutter drawn here: the editor renders that much narrower and every row gets the columns back.
// With editorPaddingX > 0 the editor's own left padding is the space after the chevron.
const CHEVRON = "❯";

export class InputBar extends CustomEditor {
	// CustomEditor keeps its own copy private.
	private readonly keys: KeybindingsManager;

	constructor(...args: ConstructorParameters<typeof CustomEditor>) {
		super(args[0], args[1], args[2], { ...args[3], embedWorkingStatus: true });
		this.keys = args[2];
		// pi assigns borderColor again on bash mode and thinking-level changes; the override has to
		// win every time, so the field becomes an accessor over whatever pi last assigned.
		let stored = this.borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => paint ?? stored,
			set: (fn: Paint) => {
				stored = fn;
			},
			configurable: true,
			enumerable: true,
		});
	}
	// Down is not taken from the editor: it moves the cursor, walks history and drives the
	// autocomplete list. It counts as "at the end" only when the editor did nothing with it,
	// which asks the editor instead of re-deriving its private wrap map.
	override handleInput(data: string): void {
		if (!this.keys.matches(data, "tui.editor.cursorDown") || this.isShowingAutocomplete()) {
			super.handleInput(data);
			return;
		}
		const now = Date.now();
		const burst = isKeyRepeat(data) || now - lastDown < BURST_MS;
		lastDown = now;
		const text = this.getText();
		const before = this.getCursor();
		super.handleInput(data);
		const after = this.getCursor();
		if (!burst && this.getText() === text && after.line === before.line && after.col === before.col) downAtEnd();
	}

	private gutter(): number {
		return this.getPaddingX() > 0 ? 1 : 2;
	}

	// Rows: top border, the visible text rows, bottom border, then the autocomplete list.
	override render(width: number): string[] {
		const gutter = this.gutter();
		const lines = super.render(width - gutter);
		// SAFETY: pi's Editor sets this field in the render() call just above; it is the count
		// its own handleMouse uses to find the bottom border.
		const shown = (this as unknown as { renderedVisibleLineCount: number }).renderedVisibleLineCount;
		const edge = this.borderColor("─".repeat(gutter));
		const blank = " ".repeat(gutter);
		return lines.map((line, i) => {
			if (i === 0 || i === shown + 1) return edge + line;
			// The chevron is part of what you type into, so it takes the text colour, not the border's.
			if (i === 1) return CHEVRON + blank.slice(1) + line;
			return blank + line;
		});
	}

	// A click is measured from the editor's own left edge, which now starts after the gutter.
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const gutter = this.gutter();
		return super.handleMouse({ ...event, x: event.x - gutter, width: event.width - gutter });
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		return withTitle(
			super.renderTopBorder(width, hiddenLineCount),
			sessionName(),
			(text) => ui?.theme.fg("muted", text) ?? text,
			(text) => this.borderColor(text),
		);
	}
}

const factory: EditorFactory = (tui, theme, keybindings) => new InputBar(tui, theme, keybindings);

export default function (pi: ExtensionAPI) {
	sessionName = () => pi.getSessionName();
	downAtEnd = () => pi.events.emit("editor:down-at-end", undefined);
	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		ctx.ui.setEditorComponent(factory);
		if (!existsSync(COLOR_FILE)) return;
		try {
			paintWith(readFileSync(COLOR_FILE, "utf8").trim());
		} catch {
			paint = undefined;
		}
	});
	pi.registerCommand("umb-color", {
		description: "input bar colour: /umb-color red | orange | yellow | green | cyan | blue | purple | pink | off",
		getArgumentCompletions(text) {
			const items = NAMES.filter((n) => n.startsWith(text.trim())).map((n) => ({ value: n, label: n }));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			const spec = args.trim();
			if (!spec) {
				const now = existsSync(COLOR_FILE) ? readFileSync(COLOR_FILE, "utf8").trim() : "theme border";
				return ctx.ui.notify(`input bar: ${now}  -  /umb-color ${NAMES.join(" | ")}`);
			}
			try {
				paintWith(spec);
			} catch (error) {
				return ctx.ui.notify((error as Error).message, "error");
			}
			if (paint) writeFileSync(COLOR_FILE, `${spec}\n`);
			else if (existsSync(COLOR_FILE)) unlinkSync(COLOR_FILE);
			ctx.ui.notify(`input bar: ${spec}`);
		},
	});
}
