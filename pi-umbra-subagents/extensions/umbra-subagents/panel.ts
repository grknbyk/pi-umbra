import { Editor, truncateToWidth, visibleWidth, type Component, type TUI, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { BranchView, RunState } from "./skills/delegate/state.ts";
import { phaseTitle } from "./bar/bar-line.ts";

// Reference 1, the full-screen panel: the zoomed-in view of the run the collapsed bar
// summarises. Phases on the left, the selected phase's branches on the right, one header
// line and one footer line.
//
// Opened with ctx.ui.custom() and NO `overlay` option, so it takes editorContainer's slot
// instead of floating over it. pi snapshots the editor's unsent text before the swap and
// calls setText with it on close, so "esc returns to the input box with unsent text
// intact" costs zero lines here — the overlay path is the one that would not.
//
// The panel reads a snapshot and nothing else: no file, no process, no kill. The bar
// already polls readRun() once a second for both views, so a second reader could only
// disagree with it by a frame, and a component with no I/O cannot be hung by a branch that
// dies. Its one timer asks for a frame and reads nothing, because elapsed and "idle Ns"
// move with the clock even on a run whose files have stopped changing.

/** What the panel needs from whoever owns the poll. `stop` is the producer's kill. */
export type PanelSource = {
	/** undefined when no run has been seen yet. */
	run(): RunState | undefined;
	/** Called only for a branch the panel drew as unsettled. */
	stop(branch: BranchView): void;
	/** Fires on every change; returns the unsubscribe. */
	subscribe(fn: () => void): () => void;
};

// A finished run closes the panel on its own after this long, so a panel left open does not sit
// over the editor. Only a run the panel watched finish: one opened already finished stays.
const AUTO_CLOSE_MS = 8_000;

// The user dropped `p pause` and `s save`: they said they never used them. Two focuses, like a
// file manager: the phase list on the left, and the agents of one phase on the right, entered
// with → and left with ←. x stops whatever the cursor is on: a whole phase, or one agent.
const FOOTER = {
	phases: "↑↓ phase · → agents · x stop phase · esc back",
	agents: "↑↓ agent · ← phases · x stop agent · esc back",
	single: "↑↓ agent · x stop agent · esc back",
};

// Rule, header, description, box top, box bottom, footer — the lines that are not body.
const CHROME = 6;
// Rows left to the transcript, the status line, the collapsed bar and pi's own footer.
const RESERVE = 4;
const MIN_BODY = 3;
// Reference 1 ends every agent row `3m15s   │`, three columns clear of the border.
const RIGHT_GUTTER = 3;
// Reference 1 shows "idle 53s", so the marker has to appear well before a minute.
const IDLE_MS = 15_000;

// "45s", "3m15s". No space before the seconds: this string sits at the right edge of every
// row, and the panel's columns are tighter than the flat list's.
const clock = (ms: number) => {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	return minutes ? `${minutes}m${String(total % 60).padStart(2, "0")}s` : `${total}s`;
};

// A timed-out branch answered nothing but is not a crash, and a soft report is not a
// success. Colour carries the difference; note() repeats it in text, because a monochrome
// theme would otherwise make the two identical.
const dotColor = (branch: BranchView): ThemeColor => {
	if (branch.timedOut) return "warning";
	if (branch.status === "error" || (branch.exitCode !== null && branch.exitCode !== 0)) return "error";
	if (branch.report === "PARTIAL" || branch.report === "NEED_STRONGER" || branch.report === "ASKING") return "warning";
	if (branch.settled) return "success";
	return branch.status === "running" ? "accent" : "dim";
};

const note = (branch: BranchView): string => {
	if (branch.timedOut) return " · timeout";
	if (branch.status === "error") return " · error";
	// A settled branch stopped emitting because it finished, not because it is stuck.
	if (!branch.settled && branch.idleMs >= IDLE_MS) return ` · idle ${clock(branch.idleMs)}`;
	return "";
};

// The producer leaves tokens at 0 or null until the provider reports, and some report only
// at completion. "0 tok" would be a fake number for minutes; the dash is an honest one.
const tokenText = (count: number | null) =>
	!count ? "–" : count < 1000 ? `${count} tok` : `${(count / 1000).toFixed(1)}k tok`;

// Run.phases holds the branch's own identifier ("map"), because the stem is
// `${phase}-${name}` and has to be a legal NTFS filename and a legal --session-id.
// Reference 1's sidebar reads "Map" while its rows read "map:core-render", so the capital
// is put back at render time rather than stored a second time in the producer.

// Reference 3's nesting marker, kept here too: a branch that was spawned by another is
// otherwise indistinguishable from its siblings, and readRun() already orders parents
// before children, so the prefix needs no tree walk.
const nest = (depth: number) => (depth > 0 ? `${"  ".repeat(depth - 1)}└ ` : "");

/**
 * The panel component. `close` is the `done` callback ctx.ui.custom hands the factory:
 * calling it restores the editor, resolves the promise, then calls dispose().
 */
export const createPanel = (
	tui: TUI,
	theme: Theme,
	source: PanelSource,
	close: () => void,
	orphaned: () => void = () => {},
	// The agent the bar's `❯` was on: the panel opens inside that agent's phase, on that row.
	stem?: string,
): Component & { dispose(): void } => {
	let shown = source.run();
	const opened = shown?.branches.find((branch) => branch.stem === stem);
	let sawLive = shown?.live === true;
	let finishedAt: number | undefined;
	// The phase list has the cursor until → moves it into that phase's agents.
	let focus: "phases" | "agents" = opened ? "agents" : "phases";
	// The phase follows the run (Map, then Design) until the user picks one.
	let selectedPhase = opened?.phase;
	// Selection is keyed on the stem, never on a row index: a branch arriving mid-run would
	// otherwise slide the cursor onto a different row under the user's hands.
	let selectedStem = opened?.stem;
	let top = 0;

	// Declared phases in order, then any a branch names that run.json did not declare, so no
	// branch is ever left without a box to be drawn in.
	const phasesOf = (run: RunState) => [
		...new Set([...run.phases, ...run.branches.map((branch) => branch.phase)]),
	];
	const phaseNow = (run: RunState) => {
		const phases = phasesOf(run);
		return selectedPhase && phases.includes(selectedPhase) ? selectedPhase : (run.phases[run.activePhase] ?? phases[0] ?? "");
	};

	// Fixed for the life of the panel. Growing the box as branches arrive would move every
	// line below it, and a height change is one of the things that forces a full repaint.
	const bodyAtOpen = Math.max(MIN_BODY, shown?.phases.length ?? 0, shown?.branches.length ?? 0);

	// Never requestRender(true): that resets the render state and repaints the whole screen.
	const unsubscribe = source.subscribe(() => tui.requestRender());
	// Elapsed and "idle Ns" move with the clock rather than with the files, so the panel keeps
	// a second hand of its own instead of inheriting whatever cadence the reader polls at. It
	// only asks for a frame — nothing is re-read here — and pi coalesces the request at 16 ms.
	const tick = setInterval(() => {
		// Another dialog (ask_user_question, a select) that takes the editor slot while the panel
		// is up swaps it out without calling done(), and pi later restores the editor, not the
		// panel. Focus back on an editor while this panel still thinks it is open is that case:
		// let go, or every door stays shut until /reload. Not done(): pi's restore would put back
		// text saved before the dialog over whatever was typed since.
		const focused = tui.getFocusedComponent();
		if (focused !== self && focused instanceof Editor) {
			self.dispose();
			orphaned();
			return;
		}
		const run = source.run();
		if (run?.live) {
			sawLive = true;
			finishedAt = undefined;
		} else if (sawLive) {
			finishedAt ??= Date.now();
			if (Date.now() - finishedAt >= AUTO_CLOSE_MS) return close();
		}
		tui.requestRender();
	}, 1000);
	// A panel timer must never be the reason node refuses to exit.
	tick.unref();

	const box = {
		top(title: string, inner: number): string {
			const text = truncateToWidth(title, Math.max(0, inner - 4), "…");
			// "┌ " + text + " " + dashes + "┐" has to come to inner + 2 columns.
			const dashes = Math.max(0, inner - visibleWidth(text) - 2);
			return theme.fg("border", "┌ ") + theme.fg("text", text) + theme.fg("border", ` ${"─".repeat(dashes)}┐`);
		},
		row(content: string, inner: number): string {
			// truncateToWidth pads as well as cuts, so a row is exactly `inner` wide however
			// much colour is inside it and the two boxes can never drift apart.
			return theme.fg("border", "│") + truncateToWidth(content, inner, "…", true) + theme.fg("border", "│");
		},
		bottom(inner: number): string {
			return theme.fg("border", `└${"─".repeat(inner)}┘`);
		},
	};

	const self = {
		render(width: number): string[] {
			// A run can be replaced under the panel; keeping the last one means the component
			// never blanks for a frame while the reader is between ticks.
			shown = source.run() ?? shown;
			const run = shown;
			const now = Date.now();
			// One leading space, like the reference. The floor keeps the two boxes summing to
			// exactly `inner`: under 13 columns they do not fit, the line wraps, and a wrapped
			// line costs a row that everything below it then moves by.
			const inner = Math.max(12, width - 1);
			// Every line is cut to `width`, ask.ts style: one column too many wraps in the
			// terminal, and a wrapped line costs a row that everything below it then moves by.
			// The box rows are built to exactly `width` already, so only the chrome needs it.
			const fit = (line: string) => truncateToWidth(line, width, "…");
			if (!run) return [fit(` ${theme.fg("dim", "no run")}`), fit(`  ${theme.fg("dim", FOOTER[focus])}`)];

			const branches = run.branches;
			const phases = phasesOf(run);
			const title = phaseNow(run);
			const list = branches.filter((branch) => branch.phase === title);
			// The agent cursor exists only while the agents have the focus; before that the
			// right box is a preview of the phase the left cursor is on.
			// One phase is a plain set of subagents, not a workflow: no phase list, just the agents.
			const single = phases.length <= 1;
			const mode = single ? "agents" : focus;
			const selected = mode === "agents" ? (list.find((branch) => branch.stem === selectedStem) ?? list[0]) : undefined;

			const sidebarRows = phases.map((name, index) => {
				const mine = branches.filter((branch) => branch.phase === name);
				const done = mine.filter((branch) => branch.settled).length;
				return `${name === title ? ">" : " "} ${index + 1} ${phaseTitle(name)}${mine.length ? ` ${done}/${mine.length}` : ""}`;
			});
			// 10 is "┌ Phases ─┐" without its borders: the box title has to fit as well as the
			// rows. A third of the width is the ceiling, so a long phase name cannot squeeze
			// the agent list down to nothing.
			const sidebarInner = single
				? 0
				: Math.min(Math.max(10, ...sidebarRows.map((row) => row.length)) + 1, Math.max(3, Math.floor(inner / 3)));
			// Two boxes are inner + 2 columns each with their borders; one box takes it all.
			const agentInner = Math.max(3, single ? inner - 2 : inner - sidebarInner - 4);

			// terminal.rows only changes on a resize, which repaints everything anyway, so
			// reading it per frame costs nothing and keeps the panel inside a shrunk window.
			const body = Math.min(bodyAtOpen, Math.max(MIN_BODY, tui.terminal.rows - CHROME - RESERVE));

			const index = Math.max(0, list.findIndex((branch) => branch.stem === selected?.stem));
			if (index < top) top = index;
			if (index >= top + body) top = index - body + 1;
			top = Math.max(0, Math.min(top, list.length - body));

			// Seeded, because Math.max() over an empty list is -Infinity — the bug the seed
			// extension carries at agents-panel.ts:75.
			// With one phase the `phase:` prefix says nothing: every row would carry the same one.
			const labelOf = (branch: BranchView) => (single ? branch.label.slice(branch.phase.length + 1) : branch.label);
			const labelWidth = Math.max(0, ...list.map((branch) => nest(branch.depth).length + labelOf(branch).length));
			const agentRows = list.slice(top, top + body).map((branch) => {
				const right = theme.fg("dim", clock(branch.elapsedMs));
				const head = (nest(branch.depth) + labelOf(branch)).padEnd(labelWidth);
				const left =
					`${theme.fg(dotColor(branch), "●")} ` +
					theme.fg(branch.stem === selected?.stem ? "accent" : "text", head) +
					` ${theme.fg("dim", `${branch.model} · ${tokenText(branch.tokens)}${note(branch)}`)}`;
				// One space in from the left border, three out to the right one: reference 1
				// writes `3m15s   │`, and a clock hard against the border reads as an overflow.
				// Widths are measured, never assumed: `left` is full of escape codes.
				// The sidebar's `>` marks the phase the selection is in, not a second focus, so this
				// row needs a marker of its own. Without one the accent colour was the only sign of
				// the cursor, the sidebar's arrow was the only `>` on screen, and `x` read as though
				// it would stop a phase. One column makes the footer's "x stop" true to the eye.
				const cursor = branch.stem === selected?.stem ? theme.fg("accent", ">") : " ";
				const room = Math.max(0, agentInner - visibleWidth(right) - RIGHT_GUTTER - 3);
				return `${cursor} ${truncateToWidth(left, room, "…", true)} ${right}${" ".repeat(RIGHT_GUTTER)}`;
			});
			if (!agentRows.length) agentRows.push(`  ${theme.fg("dim", "no branches in this phase")}`);

			// RunState has no endedAt, so a finished run's clock is the last branch to stop
			// rather than a wall clock that keeps ticking after everything is done.
			const elapsed = run.live
				? now - run.startedAt
				: Math.max(0, ...branches.map((branch) => branch.startedAt + branch.elapsedMs - run.startedAt));
			const stat = `${run.done}/${run.total} agents · ${clock(elapsed)}`;
			const name = truncateToWidth(
				theme.bold(theme.fg("text", run.name)),
				Math.max(0, inner - visibleWidth(stat) - 3),
				"…",
			);
			const gap = Math.max(1, inner - 2 - visibleWidth(name) - visibleWidth(stat));

			const lines = [
				` ${theme.fg("borderMuted", "─".repeat(inner))}`,
				fit(`  ${name}${" ".repeat(gap)}${theme.fg("dim", stat)}`),
				`  ${theme.fg("muted", truncateToWidth(run.description, Math.max(0, inner - 2), "…"))}`,
				single
					? ` ${box.top(`${list.length} agents`, agentInner)}`
					: ` ${box.top("Phases", sidebarInner)}${box.top(`${title ? phaseTitle(title) : "Agents"} · ${list.length} agents`, agentInner)}`,
			];
			for (let row = 0; row < body; row++) {
				const agents = box.row(agentRows[row] ?? "", agentInner);
				lines.push(single ? ` ${agents}` : ` ${box.row(sidebarRows[row] ?? "", sidebarInner)}${agents}`);
			}
			lines.push(single ? ` ${box.bottom(agentInner)}` : ` ${box.bottom(sidebarInner)}${box.bottom(agentInner)}`);
			lines.push(fit(`  ${theme.fg("dim", single ? FOOTER.single : FOOTER[focus])}`));
			return lines;
		},

		handleInput(data: string): void {
			// ctrl+c is pi's own select cancel, and alt+a opened the panel, so it closes it too.
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "alt+a")) return close();
			// Read the source, not the last frame: a key can land between renders, and `x` has
			// to judge a branch by its status now rather than by the one drawn 16 ms ago.
			shown = source.run() ?? shown;
			if (!shown?.branches.length) return;
			const phases = phasesOf(shown);
			const phase = phaseNow(shown);
			const list = shown.branches.filter((branch) => branch.phase === phase);
			const step = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
			// matchesKey, not a byte compare: Caps Lock or Shift sends "X", and the kitty protocol
			// can send x with lock bits set.
			const stop = matchesKey(data, "x") || matchesKey(data, "shift+x");
			// A settled branch's pid belongs to whatever the OS handed it to next, so the guard is
			// here as well as in the producer. Stopping is silent and immediate: the footer
			// promises `x stop`, not a confirmation.
			const stopAll = (branches: BranchView[]) => {
				for (const branch of branches) if (!branch.settled) source.stop(branch);
			};

			// A single phase has no phase list to go back to: the agents always have the cursor.
			if (phases.length > 1 && focus === "phases") {
				// Up and down stay in the phase list; the right box follows as a preview.
				if (step) selectedPhase = phases[(phases.indexOf(phase) + step + phases.length) % phases.length];
				else if (matchesKey(data, "right") && list.length) {
					focus = "agents";
					if (!list.some((branch) => branch.stem === selectedStem)) selectedStem = list[0]?.stem;
				} else if (stop) stopAll(list);
				else return;
			} else {
				// Inside a phase the cursor never leaves it: past the last agent it wraps to the first.
				// The same fallback render draws, so x stops the row that carries the cursor.
				const current = list.find((branch) => branch.stem === selectedStem) ?? list[0];
				const index = current ? list.indexOf(current) : 0;
				if (step) selectedStem = list[(index + step + list.length) % list.length]?.stem;
				else if (matchesKey(data, "left") && phases.length > 1) focus = "phases";
				else if (stop && current) stopAll([current]);
				else return;
				// Pinned: the run moving on to its next phase must not pull the box out from under
				// the cursor.
				selectedPhase = phase;
			}
			tui.requestRender();
		},

		invalidate(): void {
			// Nothing is cached between frames; render() reads the snapshot fresh every time.
		},

		dispose(): void {
			unsubscribe();
			clearInterval(tick);
		},
	};
	return self;
};

// One panel at a time. A second ctx.ui.custom() would clear editorContainer again, and the
// first panel's close would then restore an editor the second one had already replaced.
let showing = false;

/**
 * The one door in. The bar owns `/umb-agents`, `alt+a` and the down-arrow probe and calls this
 * from all three, so the panel registers no command and no shortcut of its own — a second
 * registration of the same name is a collision, not a third way in.
 */
export const openPanel = async (ctx: ExtensionContext, source: PanelSource, stem?: string): Promise<void> => {
	if (ctx.mode !== "tui" || showing) return;
	// Opening on nothing draws an empty box the user cannot fill, and the down-arrow door
	// fires whether or not a run exists.
	if (!source.run()) return ctx.ui.notify("no agent run to show");
	showing = true;
	let orphan = () => {};
	const orphaned = new Promise<void>((resolve) => (orphan = resolve));
	try {
		// No `overlay` option: the panel takes the editor's slot rather than floating over
		// it, which is the path that saves and restores the user's unsent text. The promise
		// resolves when the component calls done(), and pi calls dispose() straight after;
		// `orphaned` resolves when another dialog took the slot and pi never will.
		await Promise.race([
			ctx.ui.custom<undefined>((tui, theme, _keybindings, done) =>
				createPanel(tui, theme, source, () => done(undefined), orphan, stem),
			),
			orphaned,
		]);
	} finally {
		showing = false;
	}
};
