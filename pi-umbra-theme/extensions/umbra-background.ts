// pi picks a theme for its own text but never touches the window behind it. The only OSC 11 it
// ever sends is the query form (`ESC ] 11 ; ? BEL`), so it reads your terminal background and
// leaves it alone. A pi theme has no window-background token either: it paints the selected line,
// the user message and the three tool boxes, nothing else.
//
// pi-omp-theme declares a `theme.terminalBackgroundSync` setting, but nothing in its source ever
// reads that value and it never writes an OSC 11 set sequence. The knob does nothing.
//
// So this does it: on start it reads the active theme's own `export.pageBg` and sets the terminal
// background to it, and on shutdown it puts the background back with OSC 111. Nothing is guessed —
// a theme without an `export.pageBg` is left alone.
//
// Some terminals drop the OSC 11 set but still answer the query, with the colour they kept. So
// after each set the terminal is asked back. When the answer differs, the theme cannot show as
// intended: pi says so once, and /umb-doctor says how to set the colour in that terminal.
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const SETTINGS_KEY = "piUmbraTheme";
// How often the active theme's name is compared. It is an in-memory string, so this costs a
// comparison; the theme file is only read when the name moves. Short enough that arrowing through
// the theme picker looks live.
const POLL_MS = 250;
const HEX = /^#[0-9a-fA-F]{6}$/;

// OSC 11 sets the default background; OSC 111 restores the one the terminal started with. BEL
// terminates both, which every terminal accepts, unlike ST.
const setBackground = (hex: string) => process.stdout.write(`\x1b]11;${hex}\x07`);
const resetBackground = () => process.stdout.write("\x1b]111\x07");

type Settings = { background?: string };
type Rgb = { r: number; g: number; b: number };

// Terminals round the colour they store, so a channel may come back one or two steps off.
export const sameColour = (hex: string, rgb: Rgb): boolean =>
    [rgb.r, rgb.g, rgb.b].every((channel, i) => Math.abs(channel - parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)) <= 2);

/** Where the background lives in the settings of the terminal pi runs in, from its own variables. */
export const backgroundHowTo = (env: Record<string, string | undefined>, hex: string): string => {
    if (env.TERM_PROGRAM === "vscode")
        return `VS Code: add "workbench.colorCustomizations": { "terminal.background": "${hex}" } to settings.json.`;
    if (env.WT_SESSION !== undefined)
        return `Windows Terminal: Settings, your profile, Appearance, Background: ${hex}. Or "background": "${hex}" in the profile.`;
    if (env.TERM_PROGRAM === "Apple_Terminal") return `Terminal.app: Settings, Profiles, Text, Background: ${hex}.`;
    if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm")
        return `JetBrains: Settings, Editor, Color Scheme, Console Colors, Console, Background: ${hex}.`;
    if (env.TMUX !== undefined) return `tmux: add set -g window-style 'bg=${hex}' to ~/.tmux.conf.`;
    return `Set the background to ${hex} in the terminal's own settings.`;
};

/** What the last check found, for /umb-doctor in pi-umbra-help. */
export type BackgroundStatus = { wanted: string; ignored: boolean; howTo: string };


const readSetting = (): string => {
    const path = `${process.env.PI_CODING_AGENT_DIR ?? `${process.env.USERPROFILE ?? process.env.HOME}/.pi/agent`}/settings.json`;
    try {
        const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, Settings>;
        return settings[SETTINGS_KEY]?.background ?? "auto";
    } catch {
        return "auto";
    }
};

// The window colour a theme wants is its `export.pageBg` — the same value it uses for the page
// behind an exported transcript. Render tokens are no help here; none of them is the window.
// `ui.theme` is the loaded Theme. The file it was read from is only guaranteed on the list
// `getAllThemes()` returns, and that list names the field `path`, not `sourcePath`. The instance is
// tried first so a theme registered by another extension still resolves.
const themeFile = (ctx: ExtensionContext): string | undefined => {
    const theme = ctx.ui.theme;
    if (theme === undefined) return undefined;
    const own = (theme as { sourcePath?: string }).sourcePath;
    if (own !== undefined) return own;
    const listed = ctx.ui.getAllThemes().find((entry) => entry.name === theme.name);
    return (listed as { path?: string } | undefined)?.path;
};

const themeBackground = (ctx: ExtensionContext): string | undefined => {
    const path = themeFile(ctx);
    if (path === undefined) return undefined;
    const theme = JSON.parse(readFileSync(path, "utf8")) as { export?: { pageBg?: string } };
    const pageBg = theme.export?.pageBg;
    return pageBg !== undefined && HEX.test(pageBg) ? pageBg : undefined;
};

const resolve = (ctx: ExtensionContext): string | undefined => {
    const setting = readSetting();
    if (setting === "off") return undefined;
    if (HEX.test(setting)) return setting;
    return themeBackground(ctx);
};

export default function umbraBackground(pi: ExtensionAPI) {
    // The colour currently on the terminal, or undefined when we have not touched it. One variable
    // rather than a colour plus an "applied" flag: the two can disagree and the flag adds nothing.
    let current: string | undefined;
    // The theme name as of the last look, and the timer that does the looking.
    let watched: string | undefined;
    let watcher: ReturnType<typeof setInterval> | undefined;
    // The query goes through pi's TUI, which routes the reply back. A widget factory is the only
    // place an extension is handed the TUI; it runs at once and draws nothing.
    let tui: TUI | undefined;
    let warned = false;

    const verify = async (ctx: ExtensionContext, hex: string) => {
        // No reply means a terminal that answers no queries: unknown, not ignored.
        const rgb = await tui?.queryTerminalBackgroundColor({ timeoutMs: 1000 });
        if (rgb === undefined || current !== hex) return;
        const status: BackgroundStatus = { wanted: hex, ignored: !sameColour(hex, rgb), howTo: backgroundHowTo(process.env, hex) };
        (globalThis as { __umbraBackground?: BackgroundStatus }).__umbraBackground = status;
        if (!status.ignored || warned) return;
        warned = true;
        ctx.ui.notify(`This terminal kept its own background, so the theme is not shown in full. ${status.howTo}`, "warning");
    };

    const apply = (ctx: ExtensionContext): string | undefined => {
        const hex = resolve(ctx);
        if (hex === undefined) return undefined;
        setBackground(hex);
        current = hex;
        void verify(ctx, hex);
        return hex;
    };

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        if (ctx.mode !== "tui") return;
        ctx.ui.setWidget("umbra-background", (given) => {
            tui = given;
            return { render: () => [], invalidate: () => {} };
        });
        apply(ctx);
        // pi fires no theme-change event. Its internal onThemeChange slot holds a single callback
        // that the TUI already owns, and ui_prompt_end does not cover pi's own theme picker, so the
        // name is watched instead. unref keeps this timer from holding the process open at exit.
        if (watcher !== undefined) clearInterval(watcher);
        watched = ctx.ui.theme?.name;
        watcher = setInterval(() => {
            const name = ctx.ui.theme?.name;
            if (name === watched) return;
            watched = name;
            apply(ctx);
        }, POLL_MS);
        watcher.unref?.();
    });

    // Leaving a recoloured terminal behind is the one unfriendly thing this could do, so undo it
    // whether or not the shell would have reset it.
    pi.on("session_shutdown", () => {
        if (watcher !== undefined) clearInterval(watcher);
        watcher = undefined;
        if (current === undefined) return;
        resetBackground();
        current = undefined;
    });

    // Two arguments, not one object: pi's signature is registerCommand(name, definition), and a
    // single object lands in the `name` slot, where the autocomplete filter calls toLowerCase on
    // it and takes the whole process down the first time anyone types "/".
    pi.registerCommand("umb-bg", {
        description: "Set the terminal background from the active theme, a hex colour, or reset it",
        handler: async (args: string, ctx: ExtensionContext) => {
            if (ctx.mode !== "tui") return;
            const argument = args.trim();

            // Asked for by hand, so a terminal that ignores it is reported again.
            warned = false;
            if (argument === "off" || argument === "reset") {
                resetBackground();
                current = undefined;
                (globalThis as { __umbraBackground?: BackgroundStatus }).__umbraBackground = undefined;
                ctx.ui.notify("Terminal background restored.", "info");
                return;
            }

            if (HEX.test(argument)) {
                setBackground(argument);
                current = argument;
                void verify(ctx, argument);
                ctx.ui.notify(`Terminal background set to ${argument}.`, "info");
                return;
            }

            if (argument !== "") {
                ctx.ui.notify(`Expected a #rrggbb colour, "off", or nothing. Got "${argument}".`, "error");
                return;
            }

            // Three outcomes, three messages. "Nothing happened" is useless when the cause can be
            // the theme having no colour, pi not listing the theme's file, or the terminal
            // dropping the escape - and only the last one is out of this extension's hands.
            const name = ctx.ui.theme?.name ?? "?";
            const file = themeFile(ctx);
            const hex = apply(ctx);
            ctx.ui.notify(
                hex !== undefined
                    ? `Terminal background set to ${hex} from theme "${name}".`
                    : file === undefined
                      ? `pi lists no file for theme "${name}", so its background cannot be read. Use /umb-bg #rrggbb.`
                      : `Theme "${name}" (${file}) defines no export.pageBg, so nothing was changed.`,
                hex === undefined ? "warning" : "info",
            );
        },
    });
}
