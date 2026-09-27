// The one runnable check for umbra-background: the colour it picks, and the bytes it writes.
// A pi upgrade that renames Theme.sourcePath, or an edit that drops the OSC 111 reset, fails
// here instead of leaving someone's terminal recoloured after pi exits.
//
//   bun run umbra-background.check.ts
import assert from "node:assert";
import { TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "umbra-"));
const themePath = join(dir, "violet-forge.json");
writeFileSync(themePath, JSON.stringify({ name: "violet-forge", export: { pageBg: "#191830" } }));
const bareThemePath = join(dir, "bare.json");
writeFileSync(bareThemePath, JSON.stringify({ name: "bare" }));

const settingsPath = join(dir, "settings.json");
const setSetting = (value: unknown) =>
    writeFileSync(settingsPath, JSON.stringify(value === undefined ? {} : { piUmbraTheme: { background: value } }));
process.env.PI_CODING_AGENT_DIR = dir;

const written: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string) => {
    if (typeof chunk === "string" && chunk.startsWith("\x1b]")) {
        written.push(chunk);
        return true;
    }
    return realWrite(chunk as never);
}) as never;

const { default: umbraBackground, backgroundHowTo, sameColour } = await import("../extensions/umbra-background.ts");

type Handler = (event: unknown, ctx: unknown) => void;
const handlers = new Map<string, Handler>();
let command: { name: string; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    // Two arguments, matching pi: registerCommand(name, options). Recording only the options is
    // what this check exists to keep honest - the one-object form is what crashed pi at "/".
    registerCommand: (name: string, options: never) => (command = { name, ...(options as object) }),
};
umbraBackground(pi as never);

const notices: string[] = [];
// The terminal as the TUI sees it: it answers the OSC 11 query with this colour, or never.
let answer: { r: number; g: number; b: number } | undefined;
const setWidget = (_key: string, factory: (tui: unknown) => unknown) =>
    factory({ queryTerminalColors: async () => ({ background: answer }) });
// The stand-in above is only as good as its method name: pi 1.0 renamed the old query, the check
// kept passing and pi crashed at start. So the name is checked against the real TUI too.
for (const screen of [TuiMainScreen, TuiAltScreen]) {
    assert.equal(typeof screen.prototype.queryTerminalColors, "function", `${screen.name} still has queryTerminalColors`);
}
// Real pi hands the extension a Theme with NO sourcePath; the file it was read from is only on
// the list getAllThemes() returns, under the name `path`. The check used to invent a sourcePath
// and then assert against its own invention, which is why it passed while nothing happened on
// screen. Both shapes are exercised now, and the pi-shaped one is the default.
const ctx = (sourcePath: string | undefined, mode = "tui") => ({
    mode,
    ui: {
        theme: { name: "violet-forge", sourcePath },
        getAllThemes: () => [],
        notify: (m: string) => notices.push(m),
        setWidget,
    },
});
const piShapedCtx = (path: string | undefined, mode = "tui") => ({
    mode,
    ui: {
        theme: { name: "violet-forge" },
        getAllThemes: () => (path === undefined ? [] : [{ name: "violet-forge", path }]),
        notify: (m: string) => notices.push(m),
        setWidget,
    },
});

const start = () => handlers.get("session_start")!;
const shutdown = () => handlers.get("session_shutdown")!;

// auto: the colour comes from the theme's own export.pageBg, and shutdown puts it back.
setSetting(undefined);
written.length = 0;
start()({}, ctx(themePath));
assert.deepEqual(written, ["\x1b]11;#191830\x07"], "auto must set the theme's pageBg");
shutdown()({}, ctx(themePath));
assert.equal(written[1], "\x1b]111\x07", "shutdown must reset the background");

// A theme with no export.pageBg is left alone. Nothing is guessed.
setSetting(undefined);
written.length = 0;
start()({}, ctx(bareThemePath));
assert.deepEqual(written, [], "a theme without pageBg must write nothing");
shutdown()({}, ctx(bareThemePath));
assert.deepEqual(written, [], "nothing applied means nothing to reset");

// off wins over the theme.
setSetting("off");
written.length = 0;
start()({}, ctx(themePath));
assert.deepEqual(written, [], "off must write nothing");

// An explicit colour wins over the theme.
setSetting("#0c0c0c");
written.length = 0;
start()({}, ctx(themePath));
assert.deepEqual(written, ["\x1b]11;#0c0c0c\x07"], "an explicit hex must win");

// Outside a TUI there is no terminal to recolour.
setSetting(undefined);
written.length = 0;
start()({}, ctx(themePath, "print"));
assert.deepEqual(written, [], "non-tui mode must write nothing");

// The command takes a colour, a reset, and rejects anything else without writing.
setSetting(undefined);
written.length = 0;
await command!.handler("#abcdef", ctx(themePath));
assert.deepEqual(written, ["\x1b]11;#abcdef\x07"]);
await command!.handler("off", ctx(themePath));
assert.equal(written[1], "\x1b]111\x07");
written.length = 0;
await command!.handler("purple", ctx(themePath));
assert.deepEqual(written, [], "a bad argument must not write to the terminal");

// The shape real pi actually passes: no sourcePath anywhere, the file only on getAllThemes().
setSetting(undefined);
written.length = 0;
start()({}, piShapedCtx(themePath));
assert.deepEqual(written, ["]11;#191830"], "the theme file must be found via getAllThemes().path");
shutdown()({}, piShapedCtx(themePath));

// A theme pi does not list is left alone rather than guessed at.
written.length = 0;
start()({}, piShapedCtx(undefined));
assert.deepEqual(written, [], "an unlisted theme writes nothing");

// Switching themes in pi's own picker fires no event of any kind, so the extension watches the
// theme name. This is the one case that has to wait on a real tick rather than a faked clock.
setSetting(undefined);
written.length = 0;
const live = { name: "bare" };
const liveCtx = {
    mode: "tui",
    ui: {
        get theme() {
            return live;
        },
        getAllThemes: () => [
            { name: "bare", path: bareThemePath },
            { name: "violet-forge", path: themePath },
        ],
        notify: (m: string) => notices.push(m),
        setWidget,
    },
};
start()({}, liveCtx);
assert.deepEqual(written, [], "a theme with no export.pageBg writes nothing");
live.name = "violet-forge";
await new Promise((done) => setTimeout(done, 700));
assert.deepEqual(written, ["]11;#191830"], "a theme switch must be followed without any event");
shutdown()({}, liveCtx);
written.length = 0;
live.name = "bare";
await new Promise((done) => setTimeout(done, 700));
assert.deepEqual(written, [], "the watcher must stop at shutdown");

// Asking the terminal back. It took the colour: nothing to say. It kept its own: one warning
// that names the fix, and the status /umb-doctor reads. It never answered: unknown, so silence.
const status = () => (globalThis as { __umbraBackground?: { ignored: boolean } }).__umbraBackground;
const settle = () => new Promise((done) => setTimeout(done, 10));
setSetting(undefined);
notices.length = 0;
answer = { r: 0x19, g: 0x18, b: 0x31 };
start()({}, ctx(themePath));
await settle();
assert.equal(status()?.ignored, false, "a colour off by one step still counts as taken");
assert.deepEqual(notices, []);
shutdown()({}, ctx(themePath));

answer = { r: 0xff, g: 0xff, b: 0xff };
start()({}, ctx(themePath));
await settle();
assert.equal(status()?.ignored, true);
assert.equal(notices.length, 1, "a kept background is reported");
start()({}, ctx(themePath));
await settle();
assert.equal(notices.length, 1, "and only once per session");
shutdown()({}, ctx(themePath));

(globalThis as { __umbraBackground?: unknown }).__umbraBackground = undefined;
answer = undefined;
start()({}, ctx(themePath));
await settle();
assert.equal(status(), undefined, "no reply is not a verdict");
shutdown()({}, ctx(themePath));

assert.equal(sameColour("#191830", { r: 0x1b, g: 0x18, b: 0x30 }), true);
assert.equal(sameColour("#191830", { r: 0x1d, g: 0x18, b: 0x30 }), false);
assert.match(backgroundHowTo({ TERM_PROGRAM: "vscode" }, "#000000"), /terminal\.background.*#000000/);
assert.match(backgroundHowTo({ WT_SESSION: "x" }, "#000000"), /Windows Terminal/);
assert.match(backgroundHowTo({}, "#000000"), /terminal's own settings/);

process.stdout.write = realWrite;

console.log("umbra-background: all checks passed");
