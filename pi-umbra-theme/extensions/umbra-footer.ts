import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { compact } from "../lib/umbra-format.ts";

const HOME = homedir();

/**
 * `read` at most once per `ms`, the last value in between. pi's getContextUsage walks the whole
 * session branch on every call and the footer renders with every frame, so a 2300-message session
 * spent ~5% of a core recounting a number that moves once per message.
 */
export const everyMs = <T>(ms: number, read: () => T, now: () => number = Date.now): (() => T) => {
	let at = Number.NEGATIVE_INFINITY;
	let value: T;
	return () => {
		const time = now();
		if (time - at >= ms) {
			value = read();
			at = time;
		}
		return value;
	};
};

const ANSI_CODES = /\x1b\[[0-9;]*m/g;

const ponytailLevel = (statuses: ReadonlyMap<string, string>) => {
	const status = statuses.get("ponytail")?.replace(ANSI_CODES, "").toLowerCase() ?? "";
	return status.match(/lite|full|ultra/)?.[0];
};

// One column in on the left, the same gutter bar/bar-line.ts uses, so the footer and the agent
// rows under it start on the same column. Two on the right, matching the input bar: the right
// edge is where a long path ends, and one column there reads as the text touching the border.
const PAD_LEFT = 1;
const PAD_RIGHT = 2;

// Two columns on one row, with the gap doing the alignment. A terminal too narrow to hold both
// drops the right column whole rather than truncating a path into something unreadable — the
// left column is the one that changes every turn, so it is the one worth keeping.
const SEP = " · ";

/** As many groups per line as fit, in order. A group too wide for a line of its own is cut. */
const pack = (groups: string[], inner: number): string[] => {
	const lines: string[] = [];
	let line = "";
	for (const group of groups) {
		if (line === "") line = truncateToWidth(group, inner);
		else if (visibleWidth(line) + SEP.length + visibleWidth(group) <= inner) line += SEP + group;
		else {
			lines.push(line);
			line = truncateToWidth(group, inner);
		}
	}
	if (line !== "") lines.push(line);
	return lines;
};

/**
 * The status groups over as many rows as they need, and the path on the last one when it fits.
 * Truncating instead would drop whichever group came last - and the groups are ordered by how
 * often they are read, so the cut always landed on the ones nobody had seen yet.
 *
 * Packed while plain: colour is applied per finished line, so an escape is never cut in half and
 * visibleWidth is measuring characters rather than ANSI.
 */
const compose = (left: string[], right: string[], width: number, paint: (t: string) => string): string[] => {
	const inner = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
	const pad = (line: string) => " ".repeat(PAD_LEFT) + paint(line) + " ".repeat(PAD_RIGHT);
	const lines = pack(left, inner);
	const tail = right.join(SEP);
	if (tail === "") return lines.map(pad);

	const last = lines.pop() ?? "";
	const gap = inner - visibleWidth(last) - visibleWidth(tail);
	if (gap >= 2) lines.push(last + " ".repeat(gap) + tail);
	else lines.push(last, truncateToWidth(tail, inner));
	return lines.map(pad);
};

export default function (pi: ExtensionAPI) {
	// Computed once per turn and read on every frame, rather than the other way round.
	// getBranch() is documented as a tree traversal from the current leaf and builds a fresh
	// array each call, so scanning the whole session inside render() re-walked it on every
	// paint — dozens of times a second while a reply streams, and O(session) each time.
	let cost = 0;
	let lastTurn: Usage | undefined;
	// Session totals. Input counts a token once, when it is first sent: fresh input plus cache
	// writes. Cache reads re-send the same context every turn and would count it again each time.
	let sent = 0;
	let received = 0;
	let repaint: (() => void) | undefined;

	const refresh = (ctx: ExtensionContext) => {
		const messages = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.map((entry) => (entry as { message: AssistantMessage }).message);
		// On a subscription this is not what was billed — it is what the provider priced the
		// turns at, and only a provider that reports per-turn cost fills it in at all.
		cost = messages.reduce((sum, message) => sum + message.usage.cost.total, 0);
		sent = messages.reduce((sum, message) => sum + message.usage.input + message.usage.cacheWrite, 0);
		received = messages.reduce((sum, message) => sum + message.usage.output, 0);
		lastTurn = messages.at(-1)?.usage;
		repaint?.();
	};

	// agent_end, not message_end. core/cache-stats.d.ts:46 states that message_end fires BEFORE
	// persistence, so getBranch() there would still be missing the turn that just finished and
	// the footer would report the previous one. agent_end runs after every message_end, and that
	// gap is where the numbers were arriving a frame late: nothing asked for a repaint once the
	// entry landed, so new usage waited for whatever redrew the screen next — usually a keystroke.
	pi.on("agent_end", (_event, ctx) => refresh(ctx));

	// agent_end closes the whole run, and a run with many tool calls can take minutes; waiting for
	// it left the context and cache groups on the previous run the whole time. Each assistant
	// message carries its own usage, so the footer takes it as each message ends, and agent_end
	// still recounts from the persisted branch. Not while it streams: claude-bridge fills usage in
	// only at a message's start and end, so mid-stream they would show the opening numbers.
	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant" || !message.usage) return;
		lastTurn = message.usage;
		cost += message.usage.cost.total;
		sent += message.usage.input + message.usage.cacheWrite;
		received += message.usage.output;
		repaint?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		// A resumed session already has turns behind it, and no agent_end will fire for them.
		refresh(ctx);
		const contextUsage = everyMs(1000, () => ctx.getContextUsage());
		ctx.ui.setFooter((tui, theme, footerData) => {
			repaint = () => tui.requestRender();
			return {
				dispose: footerData.onBranchChange(() => tui.requestRender()),
				invalidate() {},
				render(width: number) {
					const promptTokens =
						(lastTurn?.input ?? 0) + (lastTurn?.cacheRead ?? 0) + (lastTurn?.cacheWrite ?? 0);
					const cacheHitRate = promptTokens > 0 ? ((lastTurn?.cacheRead ?? 0) / promptTokens) * 100 : 0;
					const context = contextUsage();

					// "MiniMax: MiniMax M3 (CC)" → "MiniMax M3". pi names a model "<provider>: <model>"
					// and the provider is already implied by the model, so both the prefix and the
					// trailing parenthetical are noise on a line this crowded.
					const modelName = (ctx.model?.name ?? "no model")
						.replace(/^[^:]*:\s*/, "")
						.replace(/\s*\([^)]*\)$/, "");
					const parts = [
						`${modelName} [${ctx.thinkingLevel}]`,
						`${compact(context?.tokens ?? 0)}/${compact(context?.contextWindow ?? 0)}`,
					];
					// A free model prices every turn at zero, and a column that only ever reads $0.00
					// is a column that teaches you to stop looking at it. Each group below appears
					// once it has something to say and takes its space back when it does not.
					if (cost > 0) parts.push(`$${cost.toFixed(2)}`);
					const cached = (lastTurn?.cacheRead ?? 0) + (lastTurn?.cacheWrite ?? 0);
					if (cached > 0) {
						parts.push(
							`R${compact(lastTurn?.cacheRead ?? 0)} W${compact(lastTurn?.cacheWrite ?? 0)} CH${cacheHitRate.toFixed(1)}%`,
						);
					}
					if (sent + received > 0) parts.push(`↑ ${compact(sent)} ↓ ${compact(received)}`);
					const statuses = footerData.getExtensionStatuses();
					const level = ponytailLevel(statuses);
					if (level) parts.push(`pt:${level}`);
					const loop = statuses.get("loop")?.replace(ANSI_CODES, "");
					if (loop) parts.push(loop);

					// getGitBranch() returns null outside a repo and "detached" on a detached HEAD, so
					// the branch shows itself when there is one and costs nothing when there is not.
					const cwd = ctx.sessionManager.getCwd();
					const right = [`${cwd === HOME || cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd}`];
					const branch = footerData.getGitBranch();
					if (branch) right.push(branch);

					// One line. The rule that used to live here is drawn by the editor now - see the
					// repatch entry "the autocomplete list has a closing edge" - which puts it in the
					// border colour and only when there is a list to close. Drawing it here as well
					// showed up as two rules with a blank row between them on every screen with no list.
					// The trailing blank row keeps the status line off the bottom edge of the terminal.
					return [...compose(parts, right, width, (text) => theme.fg("muted", text)), ""];
				},
			};
		});
	});
}
