// The only thing a headless `pi -p` branch says about itself while it is still running.
// The delegate skill and the fan extension both seed one JSON file per branch before
// launching it, hand the path over in PI_BRANCH_STATE, and load this file with `-e`; from
// that moment this is the file's sole writer. It exists because a branch's report lands only
// when the branch is over, and the panel needs a sentence a great deal earlier than that.
//
// It is never auto-loaded: it lives in the skill folder, not in ~/.pi/agent/extensions/, so
// the interactive session's extension set is byte-identical with and without it. Nothing
// here registers a tool, which is what makes the whole feature cost zero prompt tokens.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BranchState } from "./state.ts";

// A regex would let a runaway pattern eat the whole row; these two caps keep the column
// width predictable without truncating the part that identifies the file.
const ARG_W = 32;
const LINE_W = 72;
// Tool events arrive in bursts — two `start`s and an `end` inside one animation frame is
// ordinary — and each write is a tmp file plus a rename. Coalescing to one write per 100 ms
// stays well under the panel's own tick, so nothing is ever late on screen.
const WRITE_MS = 100;

const cut = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const file = (value: unknown): string => {
    const path = str(value);
    // basename handles both separators on win32, so a branch may hand back either.
    return path ? basename(path) : "";
};

// Where a tool puts the thing it is working on, most specific first. It is what lets an
// unknown tool — a provider extension's, a future built-in — still name its subject instead
// of rendering as a bare noun in the middle column.
const SUBJECT_KEYS = ["path", "file_path", "file", "filename", "command", "pattern", "query", "url", "name", "text", "message"];

const subject = (args: Record<string, unknown>): string => {
    for (const key of SUBJECT_KEYS) {
        const value = args[key];
        const shown = typeof value === "number" && Number.isFinite(value) ? String(value) : str(value);
        // A value that looks like a path is shown as its basename: the directory part is the
        // half of it nobody can read in a 30-column column.
        if (shown) return /[\\/]/.test(shown) ? basename(shown) : shown;
    }
    return "";
};

/** The reference screen's middle column: present tense, names the thing, no status enums.
 *  A flat switch rather than a table because it is what someone reads at 3am, and because
 *  every arm needs a different field off `args`. An unknown tool falls through to the generic
 *  subject, and a tool that was handed nothing readable falls back to its own name. */
export const describe = (toolName: string, args: unknown): string => {
    // SAFETY: pi validated `args` against the tool's own schema before firing the event, so
    // every field read below is either the declared type or absent; str()/file() treat
    // absent and wrong-typed identically.
    const a = (args ?? {}) as Record<string, unknown>;
    const say = (sentence: string, subj: string) => (subj ? cut(sentence, LINE_W) : toolName);

    switch (toolName) {
        case "read":
            return say(`Reading ${file(a.path)}`, file(a.path));
        case "grep": {
            const pattern = cut(str(a.pattern), ARG_W);
            const where = file(a.path) || str(a.glob);
            return say(where ? `Grepping ${pattern} in ${where}` : `Grepping ${pattern}`, pattern);
        }
        case "find":
            return say(`Finding ${cut(str(a.pattern), ARG_W)}`, str(a.pattern));
        case "ls":
            return say(`Listing ${cut(str(a.path) || ".", ARG_W)}`, str(a.path) || ".");
        case "bash": {
            // The first token is the command; the rest is flags nobody reads in a 30-column
            // column.
            const command = str(a.command).split(/\s+/)[0] ?? "";
            return say(`Running ${cut(command, ARG_W)}`, command);
        }
        default: {
            const what = subject(a);
            return what ? cut(`${toolName} ${cut(what, ARG_W)}`, LINE_W) : toolName;
        }
    }
};

const textOf = (message: AssistantMessage): string =>
    message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

export default function (pi: ExtensionAPI) {
    const path = process.env.PI_BRANCH_STATE;
    // Not a delegate branch. This is also what makes a stray `-e beacon.ts` on any other
    // command line completely inert.
    if (!path) return;

    let state: BranchState;
    try {
        // Read once. Re-reading later would mean racing the panel's poll for nothing: from
        // here on this process is the file's only writer.
        // SAFETY: the seed is written by run.sh's heredoc or by the fan extension from
        // constrained identifiers, so it parses to BranchState or the branch is misconfigured,
        // which the catch handles by going silent rather than by killing the branch.
        state = JSON.parse(readFileSync(path, "utf8")) as BranchState;
    } catch {
        return;
    }

    // Whole object every time, through tmp + rename, which is atomic on NTFS and POSIX alike.
    // That is what lets the panel poll without ever parsing a half-written row.
    let queued: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
        queued = undefined;
        try {
            writeFileSync(`${path}.tmp`, JSON.stringify(state));
            renameSync(`${path}.tmp`, path);
        } catch {
            // A branch must never die because the panel's scratch file could not be written.
        }
    };

    /** `soon` for anything the next event would overwrite anyway; the default writes now,
     *  because a state the branch is about to exit on has no next event to ride along with. */
    const write = (patch: Partial<BranchState>, soon = false) => {
        state = { ...state, ...patch, updatedAt: Date.now() };
        if (!soon) {
            clearTimeout(queued);
            flush();
            return;
        }
        if (queued) return;
        queued = setTimeout(flush, WRITE_MS);
        // A queued write must never be the reason the branch's process stays alive.
        queued.unref?.();
    };

    // One entry per tool call in flight, keyed on the call id pi hands out. A branch runs
    // tools concurrently, and clearing the sentence on the first `end` would leave the row
    // reading "Thinking" while the other call is still mid-grep. `.at(-1)` is the newest,
    // because the sentence people want is the thing that just started.
    const active = new Map<string, string>();
    const sentence = () => [...active.values()].at(-1) ?? "Thinking";

    pi.on("session_start", (_event, ctx) => {
        // process.pid from inside pi's own process, because `$!` under Git Bash is an MSYS
        // pid that the panel's process.kill would aim at something unrelated.
        write({ pid: process.pid, model: ctx.model?.name ?? state.model, status: "running", activity: "Thinking" });
    });

    pi.on("tool_execution_start", (event) => {
        active.set(event.toolCallId || event.toolName, describe(event.toolName, event.args));
        write({ activity: sentence() }, true);
    });

    // Deliberately NOT tool_execution_update: it fires per streamed chunk, which would be a
    // disk write per token.
    pi.on("tool_execution_end", (event) => {
        active.delete(event.toolCallId || event.toolName);
        write({ activity: sentence() }, true);
    });

    pi.on("message_end", (event, ctx) => {
        if (event.message.role !== "assistant") return;
        // SAFETY: role === "assistant" is the discriminant of the AgentMessage union.
        const message = event.message as AssistantMessage;
        // getContextUsage is the figure pi's own status line shows, but it returns null right
        // after a compaction; the message's own total is always there to fall back on.
        const tokens = ctx.getContextUsage()?.tokens ?? message.usage.totalTokens;
        // A provider that reports usage only at completion sends 0 for a while. Keeping the
        // last real value stops the panel's token column from blinking back to nothing.
        write({
            tokens: tokens > 0 ? tokens : state.tokens,
            // A tool call outlives the message that asked for it, so the sentence wins over
            // the generic line whenever one is still running.
            activity: active.size ? sentence() : "Writing the report",
        });
    });

    pi.on("agent_end", (event) => {
        const last = [...event.messages].reverse().find((message) => message.role === "assistant");
        // SAFETY: same discriminant as above; `last` is undefined only if the loop produced no
        // assistant message at all, which the ?? covers.
        const message = last as AssistantMessage | undefined;
        // The delegate report contract, preserved verbatim: the trailing STATUS line is the
        // whole reason the parent session reads the .md at all.
        const text = message ? textOf(message) : "";
        const match = /^STATUS:\s*(OK|PARTIAL|NEED_STRONGER|ASKING)/m.exec(text);
        // SAFETY: the alternation in the regex is exactly BranchState["report"] minus null.
        const report = (match?.[1] ?? null) as BranchState["report"];
        // The row is where a waiting question gets noticed, so it shows the question itself.
        const question = str(/^QUESTION:\s*(.+)$/m.exec(text)?.[1]);
        const failed = message?.stopReason === "error";
        active.clear();
        write({
            status: failed ? "error" : "done",
            report,
            error: failed ? (message?.errorMessage ?? "the branch stopped with an error") : null,
            activity: failed
                ? "Failed"
                : report === "ASKING"
                  ? cut(`Asking: ${question || "see report"}`, LINE_W)
                  : report
                    ? `Reported ${report}`
                    : "Finished",
        });
    });
}
