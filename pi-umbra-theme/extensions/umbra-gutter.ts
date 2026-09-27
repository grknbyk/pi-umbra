// Model text and your own text run into each other in a long session. This puts a gutter beside
// everything the model says, so the two are separable at a glance.
//
// It is drawn as a Markdown quote rather than a literal "│ " prefix, because the transformer hook
// is display-only and operates on Markdown source: a literal prefix would turn "```ts" into
// "│ ```ts", which is no longer a fence. pi's renderer draws the bar from the active theme.
//
// Code blocks stay outside the quote. pi draws a fence inside a quote as quoted prose, italic and
// unhighlighted, so the quote closes before a fence and opens again after it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readUmbraSettings } from "../lib/umbra-settings.ts";

const QUOTE = "> ";

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * A blank line inside a quote ends it, so blank lines carry a bare marker. Without that, one
 * empty line between two paragraphs would split the answer into two separate quote blocks.
 * Fenced code, fence lines included, is left unquoted; a fence closes on a run of the same
 * character at least as long as the one that opened it.
 */
export const asQuote = (markdown: string): string => {
    let open: string | undefined;
    const lines = markdown
        .split("\n")
        .map((line) => {
            const fence = FENCE.exec(line)?.[1];
            if (open) {
                if (fence && fence[0] === open[0] && fence.length >= open.length) open = undefined;
                return line;
            }
            if (fence) {
                open = fence;
                return line;
            }
            return line.trim() === "" ? QUOTE.trimEnd() : QUOTE + line;
        });
    // A blank marker only joins two quoted lines. Beside a code block it would draw a bar with
    // nothing next to it.
    const quoted = (line: string | undefined) => line !== undefined && line.startsWith(">");
    return lines
        .map((line, i) => (line === QUOTE.trimEnd() && !(quoted(lines[i - 1]) && quoted(lines[i + 1])) ? "" : line))
        .join("\n");
};

export default function umbraGutter(pi: ExtensionAPI) {
    // Read once. The transformer runs on every streaming update and every terminal resize, so a
    // file read per call would put disk I/O on the render path.
    const isGutterEnabled = readUmbraSettings().messages?.assistantPrefix === true;
    if (!isGutterEnabled) return;

    pi.registerMarkdownTransformer((markdown: string, { messageType }: { messageType: string }) => {
        if (messageType !== "assistant") return markdown;
        if (markdown.trim() === "") return markdown;
        return asQuote(markdown);
    });
}
