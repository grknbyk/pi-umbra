// The one runnable check for umbra-gutter. The interesting part is not that a prefix is added —
// it is that adding it does not destroy the Markdown underneath. A fence that stops being a
// fence, or a blank line that splits one answer into two quote blocks, is the failure this
// catches.
//
//   bun run umbra-gutter.check.ts
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "umbra-gutter-"));
process.env.PI_CODING_AGENT_DIR = directory;
const settingsPath = join(directory, "settings.json");
const enableGutter = (enabled: boolean) =>
    writeFileSync(settingsPath, JSON.stringify({ piUmbraTheme: { messages: { assistantPrefix: enabled } } }));

enableGutter(true);
const { default: umbraGutter, asQuote } = await import("../extensions/umbra-gutter.ts");

type Transformer = (markdown: string, context: { messageType: string }) => string;
const register = () => {
    let transformer: Transformer | undefined;
    umbraGutter({ registerMarkdownTransformer: (fn: Transformer) => (transformer = fn) } as never);
    return transformer;
};

const transform = register();
assert.ok(transform !== undefined, "an enabled gutter must register a transformer");

// A fenced code block has to survive as code. pi draws a fence inside a quote as quoted prose, so
// the block is left outside it and the quote picks up again after the closing fence.
const quotedFence = transform("Here:\n\n```ts\nconst x = 1;\n```\nDone.", { messageType: "assistant" });
assert.equal(quotedFence, "> Here:\n\n```ts\nconst x = 1;\n```\n> Done.", `fence broke: ${quotedFence}`);
// A shorter or different fence inside a longer one does not close it.
assert.equal(asQuote("````md\n```ts\nx\n```\n````\nafter"), "````md\n```ts\nx\n```\n````\n> after");
assert.equal(asQuote("~~~\n```\n~~~\ntext"), "~~~\n```\n~~~\n> text");
// A blank line next to a code block carries no marker, so no bar stands beside nothing.
assert.equal(asQuote("a\n\n```\nx\n```\n\nb"), "> a\n\n```\nx\n```\n\n> b");

// A blank line must carry the marker, or the answer splits into two separate quote blocks.
assert.equal(asQuote("a\n\nb"), "> a\n>\n> b");
assert.equal(asQuote("a\n   \nb"), "> a\n>\n> b", "whitespace-only lines count as blank");

// Only model text is touched. Your own lines and the thinking block are left alone.
const mine = "@src/app.ts bunu sadeleştir";
assert.equal(transform(mine, { messageType: "user" }), mine);
assert.equal(transform(mine, { messageType: "assistant-thinking" }), mine);

// An empty answer stays empty rather than becoming a lone quote marker.
assert.equal(transform("", { messageType: "assistant" }), "");
assert.equal(transform("   ", { messageType: "assistant" }), "   ");

// Turkish text passes through byte for byte; the gutter is a prefix, not a rewrite.
const turkish = "Işıkçı şoföre çağrı yaptı.";
assert.equal(transform(turkish, { messageType: "assistant" }), `> ${turkish}`);

// Off means off: nothing is registered at all, so there is no render cost to pay.
enableGutter(false);
assert.equal(register(), undefined, "a disabled gutter must register nothing");

console.log("umbra-gutter: all checks passed");
