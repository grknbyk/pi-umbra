import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey } from "@earendil-works/pi-tui";
import { clean, cleanBlock } from "../lib/clean.ts";

// A questionnaire the model can open. The shipped rpiv package draws the same thing in
// 5204 lines across 39 files; this is the part actually used here.
//
// Layout, one column per element so nothing drifts when a glyph is selected:
//   "3 " (2) + "[x] " (4) = label starts at column 6, the consequence line indents to match.
// Every glyph is single-cell ASCII, so a checked row is exactly as wide as an unchecked one,
// and "( )" costs the same four columns as "[ ]".
// There is no cursor glyph column: the row under the cursor is coloured instead, which
// costs no width and cannot fall out of alignment.
const NUMBER_W = 2;
const BOX_W = 4;
const INDENT = NUMBER_W + BOX_W;

// Every question grows one row the model does not author, so the user is never trapped
// inside a list of wrong answers. It sits last, in single and multi alike. Left empty it
// reads "None of these" and answers that; type into it and the text is the answer.
const NONE_LABEL = "None of these";
// Shown on the open row while it is empty. The hint is display only: the answer sent for
// an empty open row is NONE_LABEL, never the parenthetical.
const NONE_HINT = `${NONE_LABEL}. (Type it)`;

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	del: "\x7f",
	backspace: "\b",
};

type Option = { label: string; consequence?: string; preview?: string };
type Question = {
	question: string;
	header: string;
	recommendedWord?: string;
	multiSelect?: boolean;
	recommended?: number;
	options: Option[];
};

// What the user has done to one question. One record rather than two arrays indexed in
// parallel, so an answer set and the draft text behind it cannot drift out of step.
type Draft = { picked: Set<number>; typed: string };

/**
 * Backspace removes one character as it is drawn, not one UTF-16 unit: `slice(0, -1)` split an
 * emoji or a flag in half and left a broken glyph in the answer.
 */
export const dropLast = (text: string): string =>
	text.slice(0, [...new Intl.Segmenter().segment(text)].at(-1)?.index ?? 0);

const TOOL_NAME = "ask_user_question";

const pad = (count: number) => " ".repeat(Math.max(0, count));

// A preview sits beside the options rather than under them, so the eye compares samples instead
// of scrolling between them. It only earns a column when there is room for both: under this width
// the options themselves would be truncated to make space for a sample of something not yet
// chosen, which is the wrong trade, so the list goes back to full width and the preview is dropped.
const PREVIEW_MIN_WIDTH = 76;
const PREVIEW_SHARE = 0.45;
const GAP = " \u2502 ";

export const padTo = (line: string, columns: number) => line + pad(columns - visibleWidth(line));

// English is the fallback, not the assumption: the model overrides it with the word its own
// answer is written in, so a Turkish conversation does not sprout one English parenthesis.
const RECOMMENDED_WORD = "Recommended";

/**
 * Greedy word wrap over PLAIN text. The colour is applied to each returned line afterwards, which
 * is what keeps an ANSI escape from ever being split down the middle. A word wider than the column
 * is broken rather than allowed to push the preview out of alignment.
 */
export const wrap = (text: string, columns: number): string[] => {
    if (columns < 1) return [text];
    const lines: string[] = [];
    let line = "";
    const flush = () => {
        if (line !== "") lines.push(line);
        line = "";
    };
    for (let word of text.split(" ")) {
        while (visibleWidth(word) > columns) {
            flush();
            lines.push(word.slice(0, columns));
            word = word.slice(columns);
        }
        if (line === "") line = word;
        else if (visibleWidth(line) + 1 + visibleWidth(word) <= columns) line += ` ${word}`;
        else {
            flush();
            line = word;
        }
    }
    flush();
    return lines.length > 0 ? lines : [""];
};

/** Two blocks side by side. The shorter one runs out and leaves its column blank underneath. */
export const beside = (
    left: string[],
    right: string[],
    leftWidth: number,
    paintGap: (text: string) => string,
): string[] => {
    const height = Math.max(left.length, right.length);
    const merged: string[] = [];
    for (let row = 0; row < height; row++) {
        const sample = right[row];
        // Under the preview there is nothing left to separate, so the rule stops there too. Run it
        // to the bottom of the taller column and the last rows carry a bar with empty space after
        // it, which reads as a stray mark rather than as the edge of a column.
        merged.push(
            sample === undefined
                ? (left[row] ?? "")
                : padTo(left[row] ?? "", leftWidth) + paintGap(GAP) + sample,
        );
    }
    return merged;
};

export default function (pi: ExtensionAPI) {
	// A questionnaire nobody can answer is 405 prompt tokens of dead weight. pi assembles the
	// system prompt from the ACTIVE tool names, so dropping the name here removes the schema and
	// the promptSnippet together - a tool left registered but inactive costs nothing.
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.hasUI) return;
		const active = pi.getActiveTools();
		if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	});

	pi.registerTool(defineTool({
		name: TOOL_NAME,
		label: "Ask User",
		description:
			"Ask the user multiple-choice questions and wait. Only when the answer changes what you do next and no sensible default exists. Set `recommended` whenever you have a lean.",
		promptSnippet: "Ask the user a multiple-choice question when a decision is genuinely theirs.",
		parameters: Type.Object(
			{
				questions: Type.Array(
					Type.Object(
						{
							// No prose on these two: measured, the model already ends `question` with a
							// question mark and already writes `header` as the axis the options differ on.
							question: Type.String(),
							header: Type.String(),
							multiSelect: Type.Optional(Type.Boolean({ description: "Allow more than one answer." })),
							// The one fact here that cannot be inferred from the name or the type. Counting
							// from 1 would silently pre-check the wrong row, and `minimum` cannot catch that.
							recommended: Type.Optional(Type.Integer({ minimum: 0, description: "0-based index." })),
							// Not a translation table in the code: the set of languages a conversation can
							// be in is open, and the model is already writing every other string here.
							recommendedWord: Type.Optional(Type.String({
								description: "\"Recommended\" in your answer language, e.g. `Önerilen`. Send with `recommended` when not writing English.",
							})),
							options: Type.Array(
								Type.Object(
									{
										label: Type.String({ description: "The choice itself, 1-5 words. Not 'recommended', not 'better'." }),
										// The field name is the prompt. Called `description` the model writes prose and
										// sells; called `consequence` there is nowhere to put an adjective.
										consequence: Type.Optional(Type.String({
											description: "One line: the exact value, path or flag this choice produces. Omit if the label says it; never restate or argue. Good: `PI_AUTOCOMPACT_PERCENT=50`.",
										})),
										preview: Type.Optional(Type.String({
											description: "Artifact shown beside the list: ASCII mockup, config, diff or snippet. Raw multi-line, no Markdown fences. Only when options differ visibly, and then on every option. Never prose.",
										})),
									},
									{ additionalProperties: false },
								),
								// Eight, not nine: the open row added below pushes the last number to 9, the
								// last one that is a single digit to type and one column wide to draw.
								{ minItems: 2, maxItems: 8 },
							),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1, maxItems: 4 },
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			// SAFETY: pi validates params against `parameters` above before calling execute, so
			// every field the schema declares is present and of the declared type.
			const raw = params.questions as Question[];
			const questions = raw.map((q) => ({
				...q,
				question: clean(q.question),
				header: clean(q.header),
				// An out-of-range index would check a row that is not there, so it is dropped here
				// rather than guarded at every read site.
				recommended:
					q.recommended !== undefined && q.recommended >= 0 && q.recommended < q.options.length
						? q.recommended
						: undefined,
				options: q.options.map((o) => ({
					label: clean(o.label),
					consequence: o.consequence === undefined ? undefined : clean(o.consequence),
					// A whitelist, so a field added to the schema and to the renderer but not to
					// this line arrives as undefined and silently does nothing. That is what
					// happened to `preview`.
					preview: o.preview === undefined ? undefined : cleanBlock(o.preview),
				})),
			}));

			if (ctx.mode !== "tui") {
				return { content: [{ type: "text" as const, text: "No interactive UI available; the question was not asked." }], details: undefined };
			}

			const answers = await ctx.ui.custom<string[][] | undefined>((tui, theme, _keybindings, done) => {
				// The last tab is Submit, always, even for a single question. That keeps one code
				// path and leaves enter free to mean "choose" everywhere else.
				const SUBMIT = questions.length;
				const ACTIONS = ["Send", "Cancel"];
				const drafts: Draft[] = questions.map((q) => ({
					picked: new Set<number>(q.recommended === undefined ? [] : [q.recommended]),
					typed: "",
				}));

				// SAFETY for both: `drafts` is built from `questions` and neither is ever resized,
				// so any index that reaches here came from iterating `questions` or from `tab`,
				// which only `goTab` moves and only within 0..SUBMIT. Callers that can be sitting
				// on SUBMIT check for it first.
				const questionAt = (index: number) => questions[index] as Question;
				const draftAt = (index: number) => drafts[index] as Draft;

				// Enter confirms whatever the cursor is on, so the cursor has to start on the
				// recommended row. Starting at 0 meant one enter silently replaced the model's
				// recommendation with option 1.
				const startCursor = (index: number) => questionAt(index).recommended ?? 0;

				let tab = 0;
				let cursor = startCursor(0);

				const current = () => questionAt(tab);
				// The one row past the model's own options.
				const openRow = (index: number) => questionAt(index).options.length;
				const rowCount = (index: number) => openRow(index) + 1;

				const labelsFor = (index: number) => {
					const question = questionAt(index);
					const draft = draftAt(index);
					return [...draft.picked].sort((a, b) => a - b).map((row) => {
						if (row === question.options.length) return draft.typed.trim() || NONE_LABEL;
						// SAFETY: `picked` only ever holds a row index this question drew.
						return (question.options[row] as Option).label;
					});
				};

				const goTab = (next: number) => {
					if (next < 0 || next > SUBMIT) return;
					tab = next;
					cursor = next === SUBMIT ? 0 : startCursor(next);
				};

				// Typing into the open row turns it on too, so the rules for turning a row on live
				// here rather than inside toggle().
				const select = (row: number) => {
					const { picked, typed } = draftAt(tab);
					// While the open row is empty it means "none of these", which cannot be true
					// beside a real choice, in either direction. Once it holds text it stops meaning
					// that and coexists. Single-select holds one answer either way.
					const meansNone = typed.trim() === "";
					if (!current().multiSelect || (row === openRow(tab) && meansNone)) picked.clear();
					else if (meansNone) picked.delete(openRow(tab));
					picked.add(row);
				};

				const toggle = () => {
					const { picked } = draftAt(tab);
					if (current().multiSelect && picked.has(cursor)) picked.delete(cursor);
					else select(cursor);
				};

				return {
					render(width: number): string[] {
						const lines: string[] = [];

						const tabs = [...questions.map((q) => q.header), "Submit"].map((header, index) => {
							if (index === tab) return theme.fg("accent", header);
							if (index === SUBMIT) return theme.fg("dim", header);
							return theme.fg(draftAt(index).picked.size > 0 ? "text" : "dim", header);
						});
						// A rule on top. pi draws its own tool header directly above this component and
						// there is no hook to suppress it, so the next best thing is a line that says
						// where the header stops and the question starts.
						lines.push(theme.fg("dim", "─".repeat(width)));
						lines.push(truncateToWidth(tabs.join(theme.fg("dim", " | ")), width));
						lines.push("");

						if (tab === SUBMIT) {
							lines.push(truncateToWidth(theme.fg("text", "Send these answers?"), width));
							lines.push("");
							const widest = Math.max(...questions.map((q) => q.header.length));
							// One answer per line. A comma cannot separate these: the labels hold slashes
							// and spaces of their own. The dash appears only when there is more than one,
							// so three lines cannot be misread as one wrapped sentence.
							const gutter = pad(NUMBER_W + widest + ": ".length);
							questions.forEach((q, index) => {
								const head = pad(NUMBER_W) + theme.fg("muted", `${q.header}:${pad(widest - q.header.length)} `);
								const answers = labelsFor(index);
								if (answers.length === 0) {
									lines.push(truncateToWidth(head + theme.fg("dim", "(no answer)"), width));
									return;
								}
								const bullet = answers.length > 1 ? "- " : "";
								answers.forEach((answer, row) => {
									lines.push(truncateToWidth((row === 0 ? head : gutter) + theme.fg("text", bullet + answer), width));
								});
							});
							lines.push("");
							ACTIONS.forEach((action, index) => {
								lines.push(
									truncateToWidth(
										theme.fg(index === cursor ? "accent" : "dim", `${index + 1} `) +
											theme.fg(index === cursor ? "accent" : "text", action),
										width,
									),
								);
							});
							lines.push("");
							lines.push(truncateToWidth(theme.fg("dim", "↵ confirm · ←/→ question · esc to cancel"), width));
							return lines;
						}

						const question = current();
						const { picked, typed } = draftAt(tab);
						const OPEN = openRow(tab);
						lines.push(truncateToWidth(theme.fg("text", question.question), width));
						lines.push("");

						// Round takes one answer, square takes many. The shape carries the rule on
						// every row, so it is still there once the question has scrolled out of view.
						const [emptyBox, checkedBox] = question.multiSelect ? ["[ ]", "[x]"] : ["( )", "(x)"];

						const shown: Option[] = question.options.concat([{ label: "" }]);
						// Every option, or none: one filled column beside seven empty ones reads as a
						// bug rather than as a comparison.
						const previewed = question.options.every((option) => option.preview !== undefined);
						const split = previewed && width >= PREVIEW_MIN_WIDTH;
						// A ceiling for wrapping, not the column's final width. The options are usually
						// far shorter than their share, and padding them out to it pushed the preview
						// across the terminal with dead space in between.
						const bodyWidth = split ? width - Math.floor((width - GAP.length) * PREVIEW_SHARE) - GAP.length : width;
						const rows: string[] = [];
						shown.forEach((option, index) => {
							const on = picked.has(index);
							const here = index === cursor;
							const isOpen = index === OPEN;
							// The cursor is the caret on the open row: land there and you are already
							// typing, and the first keystroke replaces the whole hint.
							const caret = here ? "_" : "";
							const label = isOpen ? (typed || NONE_HINT) + caret : option.label;
							const placeholder = isOpen && !here && !typed;
							// The note is drawn, never stored: `labelsFor` still returns the bare label, so
							// the answer that reaches the model is the option, not the option plus a word
							// about it.
							const noted = index === question.recommended
								? `${label} (${question.recommendedWord ?? RECOMMENDED_WORD})`
								: label;
							// Wrapped, not truncated. With a preview beside it the column is narrow enough
							// that cutting would hide the end of the option being compared.
							const paintLabel = (text: string) =>
								theme.fg(placeholder ? "dim" : here ? "accent" : "text", text);
							const [first = "", ...rest] = wrap(noted, bodyWidth - INDENT);
							rows.push(
								theme.fg(here ? "accent" : "dim", `${index + 1} `) +
									theme.fg(on ? "accent" : "muted", `${on ? checkedBox : emptyBox} `) +
									paintLabel(first),
							);
							rest.forEach((line) => rows.push(pad(INDENT) + paintLabel(line)));
							if (option.consequence) {
								wrap(option.consequence, bodyWidth - INDENT).forEach((line) => {
									rows.push(pad(INDENT) + theme.fg("muted", line));
								});
							}
						});
						// The preview follows the cursor, not the answer: it shows what you are looking
						// at, so moving through the list is what compares them.
						// Trimmed while still plain: theme.fg("muted", "") returns a pair of ANSI codes,
						// which is not an empty string, so a blank line painted first survives every
						// emptiness test and buys a whole row of separator with nothing beside it.
						// The option under the cursor is often the "none of these" row, which has no
						// sample at all, and that is exactly the row this was drawing a bar on.
						// The options are measured once they exist, and everything they did not use goes
						// to the preview. The rule then sits just past the longest option instead of on
						// a share of the terminal that nothing reaches.
						const leftWidth = Math.min(bodyWidth, Math.max(0, ...rows.map(visibleWidth)));
						const previewWidth = split ? width - leftWidth - GAP.length : 0;
						const sample = split ? (shown[cursor]?.preview ?? "").split("\n") : [];
						while (sample.length > 0 && (sample[sample.length - 1] ?? "").trim() === "") sample.pop();
						const preview = sample.map((line) => truncateToWidth(theme.fg("muted", line), previewWidth));
						lines.push(...(split ? beside(rows, preview, leftWidth, (gap) => theme.fg("dim", gap)) : rows));
						lines.push("");
						lines.push(truncateToWidth(theme.fg("dim", "↵ choose · ←/→ question · esc to cancel"), width));
						return lines;
					},

					handleInput(data: string): void {
						const OPEN = tab === SUBMIT ? -1 : openRow(tab);
						const count = tab === SUBMIT ? ACTIONS.length : rowCount(tab);
						// There is no typing mode to enter or leave. Every key that is not a movement,
						// a digit shortcut, enter or escape is text, and text always lands in the open
						// row. So no letter can be a shortcut, and the arrows keep working because they
						// arrive as escape sequences rather than as characters.
						const writing = cursor === OPEN;

						if (matchesKey(data, "up")) cursor = (cursor - 1 + count) % count;
						else if (matchesKey(data, "down")) cursor = (cursor + 1) % count;
						else if (matchesKey(data, "left")) goTab(tab - 1);
						else if (matchesKey(data, "right") || matchesKey(data, "tab")) goTab(tab + 1);
						else if (matchesKey(data, "enter")) {
							if (tab === SUBMIT) {
								if (cursor === 0) return done(questions.map((_q, index) => labelsFor(index)));
								return done(undefined);
							}
							// Once the open row holds text, enter confirms rather than toggles, so the
							// key that submits an answer can never be the key that clears it.
							if (writing && draftAt(tab).typed.trim()) select(OPEN);
							else toggle();
							// One answer settles a single-select question, so enter moves on. A
							// multi-select one stays put; you may still want another box.
							if (!current().multiSelect) goTab(tab + 1);
						} else if (writing && matchesKey(data, "backspace")) {
							const draft = draftAt(tab);
							draft.typed = dropLast(draft.typed);
							if (!draft.typed) draft.picked.delete(OPEN);
						} else if (matchesKey(data, "escape")) {
							// Escape undoes the smallest thing first, so one stray keypress cannot
							// throw away a typed answer and the whole dialog at once.
							if (!writing) return done(undefined);
							const draft = draftAt(tab);
							if (!draft.typed) return done(undefined);
							draft.typed = "";
							draft.picked.delete(OPEN);
						}
						// A digit is a row shortcut only while you are not already writing, so a number
						// can still be typed into an answer. The length check matters: a paste like
						// "1abc" passes the range test, and Number() then makes the cursor NaN, which no
						// later keypress can move.
						else if (!writing && data.length === 1 && data >= "1" && data <= "9") {
							const index = Number(data) - 1;
							if (index >= count) return;
							cursor = index;
							// On Submit a digit only moves the cursor; sending stays behind enter.
							if (tab !== SUBMIT && index !== OPEN) toggle();
						} else if (tab !== SUBMIT && !data.startsWith(KEY.escape)) {
							// Everything left is text, and it lands in the open row from wherever the
							// cursor was, so you never walk down to start writing. Jumping is not choosing:
							// the row stays unchecked until enter. clean() rather than an ASCII range check,
							// so Turkish and every other non-ASCII letter types while control bytes cannot.
							const text = clean(data);
							if (!text) return;
							cursor = OPEN;
							draftAt(tab).typed += text;
						} else return;

						tui.requestRender();
					},

					// Required by Component. TUI.invalidate() walks every mounted root and calls this
					// unconditionally (pi-tui/dist/tui.js:530-535), so a component without it throws
					// "root.invalidate is not a function" the moment anything invalidates the screen -
					// a theme change, per the interface docs. Nothing here is cached between frames:
					// render() rebuilds from drafts, tab and cursor every time. So the body is empty
					// by design, not by omission.
					invalidate() {},
				};
			});

			if (!answers) {
				return { content: [{ type: "text" as const, text: "The user cancelled without answering." }], details: undefined };
			}

			const text = questions
				.map((q, index) => `${q.header}: ${(answers[index] ?? []).join(", ") || "(no answer)"}`)
				.join("\n");
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	}));
}
