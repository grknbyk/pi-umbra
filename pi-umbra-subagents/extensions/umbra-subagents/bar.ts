import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease, matchesKey, type Component, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { faded, linesFor, MAIN, MAX_ROWS, renderKey, renderLines, type Line } from "./bar/bar-line.ts";
import type { BranchView, RunState } from "./skills/delegate/state.ts";

// Part 3: everything the widget slot below the input box draws, and the ways it opens into the
// full panel of reference 1.
//
// Claude Code's agent tree: `● main` on top, one row per agent, one level open at a time. Down at
// the end of the editor moves the `❯` into the list; ↑↓ walk it, enter opens or closes the row
// under the cursor (on main it folds everything), x stops the row and everything under it, and
// alt+a opens the panel on it. Up past main, esc or any other key hands the keyboard back to the
// editor.
//
// The widget is mounted once at session_start and never removed. It asks for belowEditor, and
// repatch.mjs moves that slot below pi's status line. The slot grows a Spacer(1) the moment it holds anything, so registering and
// unregistering it moves the input box by a row;
// and setWidget disposes and rebuilds its component on every call, so calling it per tick would
// be a per-tick rebuild. Register the factory once, then requestRender().
//
// The string[] form of setWidget is unusable here twice over: it is wrapped in a Text that
// word-wraps a long line into two rows and yields nothing at all for a blank one, and it is
// capped at 10 lines. Only the factory form is handed `width`, which is what makes every
// truncation in bar/bar-line.ts possible.
//
// Every column of the frame itself is in bar/bar-line.ts, down to and including the string
// concatenation, because bar.check.ts cannot import this file: `CustomEditor` is a value from
// pi's own package, and loading that package pulls in an experimental server module that is not
// installed. What is left here is the part a check could not have run anyway — a component, an
// editor subclass, and four registrations.

const BAR_KEY = "agent-bar";
// Rows the list leaves to the editor, the status line and pi's own footer on a short terminal.
const RESERVE = 6;

class BarComponent implements Component {
	constructor(
		private tui: TUI,
		private theme: Theme,
		private onOpen: (stem?: string) => void,
		private onStop: (branch: BranchView) => void,
	) {}

	// Every row of the open tree, not just the ones in the window: the list scrolls to follow
	// the cursor, so the cursor walks all of them.
	private lines: Line[] = [];
	private release: (() => void) | undefined;

	render(width: number): string[] {
		// terminal.rows only changes on a resize, which repaints everything anyway, so reading
		// it per frame costs nothing and keeps the list inside a shrunk window.
		const budget = Math.max(1, Math.min(MAX_ROWS, this.tui.terminal.rows - RESERVE));
		const now = Date.now();
		this.lines = linesFor(current, now, open);
		// A row that left the tree takes the cursor back to main; a tree with nothing left in it
		// hands the keyboard back to the editor.
		if (this.release && !this.lines.length) this.leave();
		else if (cursor !== MAIN && !this.lines.some((line) => line.node.id === cursor)) cursor = MAIN;
		return renderLines(width, current, now, budget, this.theme, panelOpen, { picking: !!this.release, cursor, open });
	}

	/** Down at the end of the editor: the `❯` moves onto the first agent. The keys go through an
	 *  input listener rather than a focus change, because the editor keeps its text, its cursor
	 *  and its focus while the user looks down the list. */
	enter(): void {
		const first = this.lines[0];
		if (this.release || panelOpen || !first) return;
		cursor = first.node.id;
		this.release = this.tui.addInputListener((data) => this.key(data));
		this.refresh();
	}

	private leave(): void {
		cursor = MAIN;
		this.release?.();
		this.release = undefined;
		this.refresh();
	}

	private key(data: string): { consume: boolean } | undefined {
		// Listeners see key releases before pi filters them, and a release of the ↓ that opened
		// the list would move the cursor a second row.
		if (isKeyRelease(data)) return undefined;
		// A dialog that took the editor's slot (ask_user_question) owns the keys now, and the
		// panel opening over it would leave its promise hanging.
		if (panelOpen || !(this.tui.getFocusedComponent() instanceof Editor)) {
			this.leave();
			return undefined;
		}
		// Read now, not from the last frame: an enter that opened or closed a row may not have
		// been painted yet when the next key arrives.
		this.lines = linesFor(current, Date.now(), open);
		const ids = [MAIN, ...this.lines.map((line) => line.node.id)];
		const index = ids.indexOf(cursor);
		const line = this.lines.find((candidate) => candidate.node.id === cursor);
		if (matchesKey(data, "down")) cursor = ids[Math.min(index + 1, ids.length - 1)] ?? MAIN;
		else if (matchesKey(data, "up")) {
			// Up from main is up out of the list, and the key is spent: the editor would
			// otherwise read it as a walk back through the prompt history.
			if (index <= 0) this.leave();
			else cursor = ids[index - 1] ?? MAIN;
		} else if (matchesKey(data, "enter")) {
			// Enter on main folds everything back to the top level. On a row with agents under
			// it, it opens that row and closes every other, or closes it again. On a leaf there
			// is nothing to open.
			if (!line) open = [];
			else if (line.node.children.length) open = open[line.path.length] === line.node.id ? line.path : [...line.path, line.node.id];
		} else if (line && (matchesKey(data, "x") || matchesKey(data, "shift+x"))) {
			// The row and everything under it. A settled branch's pid belongs to whatever the OS
			// handed it to next, so it is skipped here as well as in the producer.
			for (const branch of line.node.branches) if (!branch.settled) this.onStop(branch);
		} else if (matchesKey(data, "alt+a")) {
			const stem = line?.node.branch?.stem;
			this.leave();
			this.onOpen(stem);
			return { consume: true };
		} else if (matchesKey(data, "escape")) this.leave();
		else {
			// Typing goes on where it was: the key reaches the editor as if the list were not there.
			this.leave();
			return undefined;
		}
		this.refresh();
		return { consume: true };
	}

	// Mouse reporting is only on in the alternate-screen TUI (tuiMode "fullscreen"). Clicks are
	// routed by position, not focus, so a click while another dialog holds the editor slot
	// (ask_user_question, a select) would swap that dialog out and leave its promise hanging:
	// the bar only opens the panel while an editor has focus.
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || panelOpen || !current) return undefined;
		if (!(this.tui.getFocusedComponent() instanceof Editor)) return undefined;
		this.onOpen();
		return { handled: true };
	}

	invalidate(): void {
		// Nothing is cached between frames: render() reads the snapshot fresh every time.
	}

	// setWidget disposes the old bar on every session_start; its listener must not outlive it.
	dispose(): void {
		this.leave();
	}

	refresh(): void {
		// Never requestRender(true). That calls resetRenderState(), which forces a repaint of
		// the whole screen instead of the changed band — which is the flicker.
		this.tui.requestRender();
	}
}

// Down is not ours to steal outright: it moves the cursor, walks prompt history and drives the
// autocomplete list. It belongs to the bar only when the editor would do nothing with it —
// cursor already parked at the end of the last visual line — so the editor is asked rather than
// second-guessed. Its wrap map is private and re-deriving it would drift the first time pi
// changes its wrapping; a no-op cannot drift. registerShortcut("down") is not an option: the
// dispatcher consumes a matched key session-wide, history and autocomplete included.
class BarEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private keys: KeybindingsManager,
		private onDownAtEnd: () => void,
	) {
		super(tui, theme, keys);
	}

	handleInput(data: string): void {
		// With the autocomplete list open, down moves the highlight and changes neither the text
		// nor the cursor, so the probe below would misread it as a no-op.
		if (!this.keys.matches(data, "tui.editor.cursorDown") || this.isShowingAutocomplete()) {
			super.handleInput(data);
			return;
		}
		const text = this.getText();
		const before = this.getCursor();
		super.handleInput(data);
		const after = this.getCursor();
		if (this.getText() === text && after.line === before.line && after.col === before.col) this.onDownAtEnd();
	}
}

let current: RunState | undefined;
let panelOpen = false;
let bar: BarComponent | undefined;
let lastKey = "";
// The row the `❯` is on while the list has the keyboard, and the one path of the tree that is
// open. Both outlive a rebuilt widget, so a /reload does not fold the tree back up.
let cursor = MAIN;
let open: string[] = [];

/** The bar holds no state and owns no timer: the reader that already polls `<cwd>/.pi-out` for
 *  the panel calls this every tick, so the two views can never disagree about the same run and
 *  only one thing is ever walking the disk. */
export const setRun = (run: RunState | undefined) => {
	// A different run starts folded: ids from the last one could match a new row by stem.
	if (run?.dir !== current?.dir) open = [];
	current = run;
	const key = renderKey(run, Date.now());
	if (key === lastKey) return;
	lastKey = key;
	bar?.refresh();
};

export const installBar = (
	pi: ExtensionAPI,
	openPanel: (ctx: ExtensionContext, stem?: string) => Promise<void> | void,
	stop: (branch: BranchView) => void,
) => {
	// `quiet` is the down arrow and the click: both fire whether or not a run exists, and a
	// notification on every press of a key the user meant as "move the cursor" is noise. The
	// command and the shortcut were typed on purpose, so those get told why nothing happened.
	const show = (ctx: ExtensionContext, quiet = false, stem?: string) => {
		if (panelOpen) return quiet ? undefined : ctx.ui.notify("agent panel is already open");
		// Opening on nothing would draw an empty box the user cannot fill. The quiet doors also
		// skip a run the bar has already let go of: a key meant as "move the cursor" should not
		// bring back a run that finished minutes ago. The command and alt+a still open it.
		if (!current || (quiet && faded(current, Date.now()))) {
			return quiet ? undefined : ctx.ui.notify("no agent run in this directory");
		}
		panelOpen = true;
		bar?.refresh();
		void Promise.resolve(openPanel(ctx, stem)).finally(() => {
			panelOpen = false;
			bar?.refresh();
		});
	};

	// umbra-inputbar's editor announces a down at the end on pi's event bus. pi keeps one editor
	// per session and does not sort extensions before loading them (under bun the order is the
	// filesystem's), so a second editor class of our own would win or lose at random. The event
	// works whichever loads first; the subscription is dropped by pi on /reload.
	pi.events.on("editor:down-at-end", () => bar?.enter());

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Re-registered on every session_start, including the "reload" one that follows
		// resetExtensionUI() clearing every widget and the custom editor. Once per session is
		// not once per tick: each call disposes the old component and builds a new one.
		ctx.ui.setWidget(
			BAR_KEY,
			(tui, theme) => {
				bar = new BarComponent(tui, theme, (stem) => show(ctx, true, stem), stop);
				return bar;
			},
			{ placement: "belowEditor" },
		);
		// Fallback for a setup without umbra-inputbar: then this editor does the same probe
		// itself. With umbra-inputbar present its editor is kept, and the event above is the way
		// in. Only one editor is ever live, so the panel cannot be asked to open twice.
		if (ctx.ui.getEditorComponent()) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BarEditor(tui, theme, keybindings, () => bar?.enter()));
	});

	// Not ctrl+<letter>: every one is already bound by pi, and extension shortcuts are matched
	// before app keybindings, so one would silently shadow a built-in.
	pi.registerShortcut("alt+a", { description: "Open the agent panel", handler: (ctx) => show(ctx) });
	pi.registerCommand("umb-agents", { description: "Open the agent panel", handler: async (_args, ctx) => show(ctx) });
};
