import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { LINGER_MS, type BranchView, type RunState } from "../skills/delegate/state.ts";

// Every column the widget below the input box occupies, as pure functions over one run
// snapshot: Claude Code's agent tree. `● main` on top, one row per agent, and only one level of
// the tree open at a time: an agent with agents under it shows `(+N)` and how they are doing,
// and enter opens it. A phased run is one `workflow` row whose children are its phases, whose
// children are their branches.
//
// All of it lives here rather than in the component because the arithmetic is the part that can
// be wrong in a way that hurts: a composed line one column too wide wraps in the terminal, and
// a wrapped line above the editor pushes the input box down by a row. Pure functions can be
// walked across every width by bar.check.ts with no terminal, no theme and no pi — and pi
// cannot even be imported by a check, because loading it drags in the experimental server.
// The one thing this file borrows from pi is `ThemeColor`, as a type-only import, which is
// erased before anything runs.
//
// Widths are measured before colour goes on. Every piece returned by the two layout functions
// is plain text whose width is exactly what it will occupy, and renderLines() below only ever
// concatenates them in order — which is also why a row hands back `dotAt`, the one cell that
// takes the status colour, instead of a pre-coloured glyph.

export const MARK = 2; // "❯ " in front of the row the cursor is on, blank in front of the rest
export const PAD = 1; // one column of gutter each side, matching the rows pi draws itself
const COL_GAP = 3; // list: agent name -> activity, as in reference 3
const MIN_ACTIVITY = 10; // ditto for the activity sentence, which is the point of the list
const HEAD_CAP = 28; // ditto for the list's marker + dot + name column
const MIN_INNER = 8; // under this nothing but a stub of the main row fits

/** Reference 1 shows "idle 53s", so a branch counts as quiet well before a minute. */
export const IDLE_MS = 15_000;
/** How long a finished run stays on screen before the widget draws nothing again. */
export { LINGER_MS };

/** "45s", "3m 52s" — the reference-2 and reference-3 spelling, with the space. Reference 1
 *  writes "3m15s" instead; that clock lives in panel.ts, where the columns are tighter. */
export const clock = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

// A dash, not "0": a provider that reports usage only at completion leaves the sum at zero for
// minutes, and a fake number in the column the user glances at is worse than an honest gap.
export const compact = (tokens: number) =>
	tokens <= 0 ? "–" : tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;

// RunState carries no end time — liveness is per branch — so the last beacon write in the run
// stands in for one. It is what freezes the elapsed clock, so a finished run stops counting.
export const endedAt = (run: RunState) => (run.live ? 0 : Math.max(0, ...run.branches.map((branch) => branch.updatedAt)));

/** Past its linger window a finished run is the same thing as no run at all: one bare `○ main`
 *  row. Both shapes ask that question, so they ask it through one function. */
export const faded = (run: RunState | undefined, now: number): boolean => {
	if (!run || run.total === 0) return true;
	const ended = endedAt(run);
	return ended > 0 && now - ended > LINGER_MS;
};

// ---------- THE TREE ----------

/** One row the tree can show: a branch, or for a phased run the run itself and each phase.
 *  `branches` is every branch at or under the row, which is what its counts, its clock and
 *  `x` act on. */
export type Node = {
	id: string;
	label: string;
	branch?: BranchView;
	branches: BranchView[];
	children: Node[];
	elapsedMs: number;
	tokens: number;
};

/** A visible row: the tree guide drawn in front of it, the ids of the rows above it in the
 *  tree, and whether it has children that are not shown. */
export type Line = { node: Node; guide: string; path: string[]; folded: boolean };

/** The cursor's id for the `● main` row. Every other id carries a prefix, so none can clash. */
export const MAIN = "main";

export const phaseTitle = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const branchNode = (branch: BranchView, all: BranchView[]): Node => {
	const children = all.filter((child) => child.parent === branch.stem).map((child) => branchNode(child, all));
	return {
		id: `b:${branch.stem}`,
		label: branch.name,
		branch,
		branches: [branch, ...children.flatMap((child) => child.branches)],
		children,
		elapsedMs: branch.elapsedMs,
		tokens: branch.tokens ?? 0,
	};
};

// A branch whose parent is not in the run (it finished and was pruned, or never wrote a
// beacon) is a root rather than a row that never shows.
const rootsOf = (list: BranchView[], all: BranchView[]) =>
	list.filter((branch) => !branch.parent || !all.some((other) => other.stem === branch.parent)).map((branch) => branchNode(branch, all));

const group = (id: string, label: string, children: Node[]): Node => ({
	id,
	label,
	branches: children.flatMap((child) => child.branches),
	children,
	elapsedMs: Math.max(0, ...children.map((child) => child.elapsedMs)),
	tokens: children.reduce((sum, child) => sum + child.tokens, 0),
});

/** One phase is plain subagents, so the branches are the top level. More than one is a
 *  workflow: a single row named after the run, its phases under it, their branches under them. */
export const treeOf = (run: RunState, now: number): Node[] => {
	const all = run.branches;
	const phases = [...new Set([...run.phases, ...all.map((branch) => branch.phase)])];
	if (phases.length <= 1) return rootsOf(all, all);
	const workflow = group(
		`r:${run.dir}`,
		run.name || "workflow",
		phases.map((phase) => group(`p:${phase}`, phaseTitle(phase), rootsOf(all.filter((branch) => branch.phase === phase), all))),
	);
	return [{ ...workflow, elapsedMs: (endedAt(run) || now) - run.startedAt, tokens: run.tokens }];
};

/** The rows on screen. `open` is the one path that is expanded, top level first: opening a row
 *  closes every other, so only one agent's tree is ever branched out. */
export const linesOf = (nodes: Node[], open: string[], depth = 0, prefix = "", path: string[] = []): Line[] =>
	nodes.flatMap((node, index) => {
		const last = index === nodes.length - 1;
		const guide = depth === 0 ? "" : prefix + (last ? "└ " : "├ ");
		const expanded = node.children.length > 0 && open[depth] === node.id;
		const line: Line = { node, guide, path, folded: node.children.length > 0 && !expanded };
		if (!expanded) return [line];
		const below = depth === 0 ? "" : prefix + (last ? "  " : "│ ");
		return [line, ...linesOf(node.children, open, depth + 1, below, [...path, node.id])];
	});

export const linesFor = (run: RunState | undefined, now: number, open: string[]): Line[] =>
	!run || faded(run, now) ? [] : linesOf(treeOf(run, now), open);

// ---------- STATUS ----------

/** What a branch is doing, in the words the counts use. A stopped and a failed branch are one
 *  state here: both ended without an answer, and both are red. A branch of a later phase that
 *  has not been started yet is waiting, not running. */
export type State = "done" | "running" | "idle" | "waiting" | "stopped";
const STATES: State[] = ["done", "running", "idle", "waiting", "stopped"];

export const stateOf = (branch: BranchView): State => {
	if (branch.timedOut || branch.status === "error") return "stopped";
	// No process yet: still queued, or never started because the run was abandoned.
	if (branch.pid === null) return branch.settled ? "stopped" : "waiting";
	if (branch.settled) return branch.exitCode !== null && branch.exitCode !== 0 ? "stopped" : "done";
	return branch.alive && branch.idleMs < IDLE_MS ? "running" : "idle";
};

const COLOR: Record<State, ThemeColor> = { done: "success", running: "accent", idle: "warning", waiting: "dim", stopped: "error" };

// A row standing for many branches takes the state that most needs a look: one still going
// outranks the finished ones. A phase with no branches yet has not run, so it is waiting.
const stateOfAll = (branches: BranchView[]): State => {
	const states = branches.map(stateOf);
	return (["running", "idle", "stopped", "waiting", "done"] as State[]).find((state) => states.includes(state)) ?? (states.length ? "done" : "waiting");
};

/** "3 done · 5 running · 1 idle", leaving out the states nobody is in. */
export const countsOf = (branches: BranchView[]) =>
	STATES.map((state) => [state, branches.filter((branch) => stateOf(branch) === state).length] as const)
		.filter(([, count]) => count > 0)
		.map(([state, count]) => `${count} ${state}`)
		.join(" · ");

/** What the row says it is doing. A branch that was killed never got to write "done", so its
 *  own `activity` is frozen on whatever it was mid-way through — a row reading "Running cd"
 *  on a process that has been dead for four minutes. The exit file already knows better. */
export const said = (branch: BranchView): string => {
	if (branch.timedOut) return "Timed out";
	if (branch.status === "error") return branch.error ? `Failed: ${branch.error}` : "Failed";
	// Killed by hand or by a parent going away: a non-zero exit with no error text of its own.
	if (branch.settled && branch.exitCode !== null && branch.exitCode !== 0 && !branch.report) return "Stopped";
	return branch.activity ?? "";
};

// A branch says what it is doing; a row with hidden agents under it says how they are doing
// first, since that is what the folded row is hiding. A phase or the workflow has no activity
// of its own, so it says only the counts.
const activityOf = (line: Line) => {
	const { node } = line;
	if (!node.branch) return countsOf(node.branches);
	const own = said(node.branch);
	if (!line.folded) return own;
	const counts = countsOf(node.branches.slice(1));
	return own ? `${counts} · ${own}` : counts;
};

// ---------- THE LIST ----------

/** One row on screen. `head` is the tree guide, the dot and the name, padded so every row's
 *  activity starts in the same column; `dotAt` is the cell inside it that takes `tone`, or -1 on
 *  a row with no dot. `id` is the row's tree id, MAIN for the session, undefined for "↑ 3 more". */
export type ListRow = {
	head: string;
	dotAt: number;
	activity: string;
	fill: string;
	right: string;
	tone?: ThemeColor;
	id?: string;
};

/** Whether the list has the keyboard, which row the `❯` is on, and which path is open. */
export type View = { picking: boolean; cursor: string; open: string[] };
export const TYPING: View = { picking: false, cursor: MAIN, open: [] };

// Chosen once for the whole list rather than per row, so the right-hand block is one column
// instead of four ragged ones. The tokens go first, then the arrow, and the clock last.
const rowRight = (node: Node, tier: number) => {
	const time = clock(node.elapsedMs);
	if (tier === 0) return `${time} · ↓ ${compact(node.tokens)} tokens`;
	if (tier === 1) return `${time} · ↓ ${compact(node.tokens)}`;
	if (tier === 2) return time;
	return "";
};

const widest = (values: string[]) => Math.max(0, ...values.map(visibleWidth));

/** The slice of `n` rows that fits `room`, kept around the cursor at `at`. The window scrolls
 *  instead of hiding anyone; a row of it is spent on "↑ N more" or "↓ N more" only when there is
 *  something that way. Returns [first, end). */
export const windowOf = (n: number, at: number, room: number): [number, number] => {
	if (n <= room) return [0, n];
	if (room < 3) {
		const top = Math.min(Math.max(0, at), n - Math.max(0, room));
		return [top, top + Math.max(0, room)];
	}
	if (at < room - 1) return [0, room - 1];
	if (at >= n - room + 1) return [n - room + 1, n];
	const slots = room - 2;
	const top = Math.min(Math.max(1, at - Math.floor((slots - 1) / 2)), n - slots - 1);
	return [top, top + slots];
};

// windowOf() spends rows on "↑ N more" and "↓ N more" only when it has three or more to play
// with; under that it shows what fits and nothing else.
const arrows = (max: number) => max - 1 >= 3;

/** The list, whole. Always at least the `● main` row, because a widget that renders zero lines
 *  while a run is live would un-mount itself. `max` is the row budget the component computes
 *  from the terminal height; past it the list scrolls with the cursor. */
export const layoutList = (width: number, run: RunState | undefined, now: number, max: number, view: View = TYPING): ListRow[] => {
	const inner = width - PAD * 2;
	const main = "● main";
	if (inner < MIN_INNER) {
		return [{ head: truncateToWidth(main, Math.max(0, inner), "…", true), dotAt: 0, activity: "", fill: "", right: "", id: MAIN }];
	}

	const lines = linesFor(run, now, view.open);
	const at = view.picking ? lines.findIndex((line) => line.node.id === view.cursor) : -1;
	const [first, end] = windowOf(lines.length, Math.max(0, at), Math.max(0, max - 1));
	const shown = lines.slice(first, end);
	const above = arrows(max) ? first : 0;
	const below = arrows(max) ? lines.length - end : 0;

	const nameOf = (line: Line) => `${line.guide}○ ${line.node.label}${line.folded ? ` (+${line.node.branches.length - (line.node.branch ? 1 : 0)})` : ""}`;
	const heads = shown.map(nameOf);
	const moreUp = above ? `↑ ${above} more` : "";
	const moreDown = below ? `↓ ${below} more` : "";
	const headWidth = Math.min(inner, HEAD_CAP, Math.max(1, widest([main, ...heads, moreUp, moreDown])));

	// One tier for the list, not one per row: the widest that still leaves the activity
	// sentence a readable column next to the longest head.
	let tier = 0;
	let rightWidth = 0;
	for (; tier < 3; tier++) {
		rightWidth = widest(shown.map((line) => rowRight(line.node, tier)));
		if (headWidth + COL_GAP + MIN_ACTIVITY + rightWidth + 2 <= inner) break;
	}
	if (tier === 3) rightWidth = 0;
	// Clamped after the choice as well as before it: on a narrow terminal even the bare clock
	// can be too wide, and an over-wide row is the one failure that moves the input box.
	rightWidth = Math.min(rightWidth, Math.max(0, inner - headWidth));
	// Two columns before the clock, so a truncated sentence never runs into it.
	const activityBudget = inner - headWidth - COL_GAP - rightWidth - (rightWidth ? 2 : 0);

	const row = (headText: string, at: number, text: string, right: string): ListRow => {
		const head = truncateToWidth(headText, headWidth, "…", true);
		const activity =
			text && activityBudget >= MIN_ACTIVITY ? " ".repeat(COL_GAP) + truncateToWidth(text, activityBudget) : "";
		// Padded on the left, so the clocks sit under each other instead of only the right edge
		// lining up. Spaces take no colour, so this stays one string the component can dim.
		const padded = " ".repeat(Math.max(0, rightWidth - visibleWidth(right))) + right;
		const fill = Math.max(0, inner - headWidth - visibleWidth(activity) - visibleWidth(padded));
		return { head, dotAt: at, activity, fill: " ".repeat(fill), right: padded };
	};

	// `● main` is the session itself, and the filled dot says this is where the user is. The
	// widget factory is handed a tui and a theme and nothing else, so there is no context here to
	// ask for the session's own usage, and a number the row could not stand behind is worse than
	// a blank.
	const rows: ListRow[] = [{ ...row(main, 0, "", ""), id: MAIN }];
	if (moreUp) rows.push(row(moreUp, -1, "", ""));
	shown.forEach((line, index) => {
		const { node } = line;
		const tone = COLOR[node.branch && !line.folded ? stateOf(node.branch) : stateOfAll(node.branches)];
		// SAFETY: heads is built by mapping `shown` in order, so this index is populated.
		rows.push({ ...row(heads[index] as string, visibleWidth(line.guide), activityOf(line), rowRight(node, tier)), tone, id: node.id });
	});
	if (moreDown) rows.push(row(moreDown, -1, "", ""));
	return rows;
};

// ---------- THE FRAME ----------

// The list's ceiling: `● main` plus eight rows. Past that the list scrolls with the cursor, so
// the widget can never eat the screen it is sitting on top of.
export const MAX_ROWS = 9;

/** Everything on screen, in one string. A frame identical to the last one is never requested:
 *  pi coalesces renders at 16 ms, but the cheapest frame is the one nobody asks for, and an
 *  idle session whose reader ticks once a second would otherwise repaint a blank row for as
 *  long as pi stays open. Width is deliberately absent — a resize repaints everything anyway.
 *  The cursor and the open path are absent too: the bar repaints itself when either moves. */
export const renderKey = (run: RunState | undefined, now: number): string => {
	if (!run || faded(run, now)) return "-";
	const at = endedAt(run) || now;
	const head = [run.name, run.description, run.done, run.total, run.tokens, Math.round((at - run.startedAt) / 1000)];
	const rows = run.branches.map((branch) =>
		[
			branch.stem,
			branch.depth,
			branch.status,
			said(branch),
			branch.tokens,
			Math.round(branch.elapsedMs / 1000),
			branch.alive ? 1 : 0,
			branch.idleMs < IDLE_MS ? 1 : 0,
		].join(","),
	);
	return [...head, ...rows].join("|");
};

/** The two theme methods the frame uses, so it can be composed without a TUI. */
export type Ink = { fg(color: ThemeColor, text: string): string; bold(text: string): string };

/** The keys that work on the row the cursor is on. Enter only appears where it does something. */
export const hintOf = (view: View, lines: Line[]): string => {
	const line = lines.find((candidate) => candidate.node.id === view.cursor);
	const expanded = lines.some((candidate) => candidate.node.children.length > 0 && !candidate.folded);
	const enter = line ? (line.node.children.length ? (line.folded ? "enter expand" : "enter collapse") : "") : expanded ? "enter collapse all" : "";
	return ["↑↓ select", enter, line ? "x stop" : "", "alt+a panel", "esc back"].filter(Boolean).join(" · ");
};

/**
 * The whole frame:
 *
 *   1. nothing running, or the run faded       -> no lines at all
 *   2. the panel is open, or no room to draw    -> one blank line
 *   3. anything else                            -> the list, with a key hint on top while the
 *                                                  list has the keyboard
 */
export const renderLines = (
	width: number,
	run: RunState | undefined,
	now: number,
	budget: number,
	ink: Ink,
	panelIsOpen = false,
	view: View = TYPING,
): string[] => {
	const total = Math.max(0, width);

	// Nothing running: draw nothing at all. pi renders the belowEditor container with
	// spacerWhenEmpty and leadingSpacer both false, so zero lines really is zero rows and the
	// footer above it does not move when a run starts or ends.
	if (faded(run, now)) return [];

	// The panel already draws all of this, and it took the editor's slot to do it. The width
	// guard rides along: below two gutters plus a couple of columns there is nothing to say, and
	// a blank line of the right height beats a two-column line in a one-column terminal.
	if (panelIsOpen || total < PAD * 2 + 4) return [" ".repeat(total)];

	const hint = view.picking ? [" ".repeat(PAD + MARK) + ink.fg("dim", truncateToWidth(hintOf(view, linesFor(run, now, view.open)), Math.max(0, total - PAD * 2 - MARK), "…", true)) + " ".repeat(PAD)] : [];
	// The `❯` column comes off the list's width, so a marked row is exactly as wide as the rest.
	const rows = layoutList(total - MARK, run, now, view.picking ? budget - 1 : budget, view).map((row) => {
		// `head` is plain text, and everything left of the dot is a tree guide or a space, so a
		// visible column and a code-unit index are the same number here and slicing cannot cut a
		// character in half.
		// The name, then a grey "(+N)" when the row hides agents under it.
		const name = row.head.slice(row.dotAt + 1);
		const plus = name.search(/ \(\+\d+\)/);
		const label = plus === -1 ? ink.fg("text", name) : ink.fg("text", name.slice(0, plus)) + ink.fg("dim", name.slice(plus));
		const head =
			row.dotAt < 0
				? ink.fg("dim", row.head)
				: ink.fg("dim", row.head.slice(0, row.dotAt)) +
					(row.id === MAIN
						? ink.bold(ink.fg("text", row.head.slice(row.dotAt)))
						: ink.fg(row.tone ?? "dim", row.head.slice(row.dotAt, row.dotAt + 1)) + label);
		const mark = view.picking && row.id === view.cursor ? ink.fg("accent", "❯ ") : "  ";
		return " ".repeat(PAD) + mark + head + ink.fg("muted", row.activity) + row.fill + ink.fg("dim", row.right) + " ".repeat(PAD);
	});
	return [...hint, ...rows];
};
