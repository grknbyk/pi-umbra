// Reading a Markdown file in a terminal means reading its source. This renders it instead: pandoc
// turns the document into one self-contained HTML file and the system browser opens it.
//
// pandoc is not bundled and is never installed for you. It is looked for when a preview is asked
// for, not at load, so a missing pandoc costs one message rather than a failed extension. The
// message names the install command for the platform it is printed on.
//
// A PDF or an HTML file is opened directly. pandoc reads neither, and converting a PDF to HTML to
// look at a PDF is work with nothing at the end of it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Formats the browser opens as they are. Converting these would lose more than it gained. */
const DIRECT = new Set([".pdf", ".html", ".htm", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Everything pandoc is asked to read. An unlisted extension is still tried, and pandoc says no. */
const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);

// Where pandoc lands when its own installer runs and the shell has not been restarted, so the
// first preview after `winget install` works instead of reporting a missing program that is there.
const FALLBACK_PATHS: Record<string, string[]> = {
    win32: [
        join(homedir(), "AppData", "Local", "Pandoc", "pandoc.exe"),
        "C:\\Program Files\\Pandoc\\pandoc.exe",
    ],
    darwin: ["/usr/local/bin/pandoc", "/opt/homebrew/bin/pandoc"],
    linux: ["/usr/bin/pandoc", "/usr/local/bin/pandoc"],
};

const INSTALL: Record<string, string> = {
    win32: "winget install --id JohnMacFarlane.Pandoc -e",
    darwin: "brew install pandoc",
    linux: "sudo apt install pandoc",
};

// Mermaid is a diagram language pandoc has no renderer for: it passes the block through as code.
// Loading mermaid's own script in the produced page is what draws it, and the block only carries
// its weight when the document actually has a diagram in it.
const MERMAID_HEADER = `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
for (const block of document.querySelectorAll("pre.mermaid > code, code.language-mermaid")) {
    const host = document.createElement("pre");
    host.className = "mermaid";
    host.textContent = block.textContent;
    (block.closest("pre") ?? block).replaceWith(host);
}
mermaid.initialize({ startOnLoad: true });
</script>
`;

const run = (command: string, args: string[]): Promise<{ code: number; stderr: string }> =>
    new Promise((done) => {
        const child = spawn(command, args, { windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("error", () => done({ code: -1, stderr: "could not start " + command }));
        child.on("close", (code) => done({ code: code ?? -1, stderr }));
    });

/** The pandoc this machine has, or undefined. PATH first, then where the installer puts it. */
export const findPandoc = async (
    exists: (path: string) => boolean = existsSync,
    probe: (command: string) => Promise<boolean> = async (command) =>
        (await run(command, ["--version"])).code === 0,
): Promise<string | undefined> => {
    if (await probe("pandoc")) return "pandoc";
    return (FALLBACK_PATHS[platform()] ?? []).find(exists);
};

/** Opening a file is one command per platform and none of them take the same arguments. */
const openInBrowser = (path: string): void => {
    const [command, args] =
        platform() === "win32"
            ? ["cmd", ["/c", "start", "", path]]
            : platform() === "darwin"
              ? ["open", [path]]
              : ["xdg-open", [path]];
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
};

/** The path a user typed, which may be relative, quoted, or prefixed with pi's own `@`. */
export const resolvePath = (argument: string, cwd: string): string => {
    const bare = argument.trim().replace(/^@/, "").replace(/^["']|["']$/g, "");
    return isAbsolute(bare) ? bare : resolve(cwd, bare);
};

export default function preview(pi: ExtensionAPI) {
    const out = join(tmpdir(), "pi-umbra-preview");

    const show = async (argument: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (argument.trim() === "") {
            ctx.ui.notify("Which file? /umb-preview <path>", "warning");
            return;
        }
        const source = resolvePath(argument, process.cwd());
        if (!existsSync(source)) {
            ctx.ui.notify(`No such file: ${source}`, "error");
            return;
        }

        const extension = extname(source).toLowerCase();
        if (DIRECT.has(extension)) {
            openInBrowser(source);
            ctx.ui.notify(`Opened ${basename(source)}.`, "info");
            return;
        }

        const pandoc = await findPandoc();
        if (pandoc === undefined) {
            ctx.ui.notify(
                `pandoc is needed to render ${extension || "this file"} and was not found. Install it with:  ${INSTALL[platform()] ?? "your package manager"}`,
                "warning",
            );
            return;
        }

        mkdirSync(out, { recursive: true });
        const target = join(out, `${basename(source, extension)}.html`);
        // --standalone gives a whole page rather than a fragment, --embed-resources inlines the
        // images so the file in the temp directory still shows them, and math is rendered by the
        // browser. `--mathml` is the spelling pandoc deprecated; this one is the current name.
        const args = [source, "-o", target, "--standalone", "--embed-resources", "--math-method=mathml"];

        // Only markdown gets the mermaid loader, and only when a diagram is actually in the file.
        if (MARKDOWN.has(extension) && readFileSync(source, "utf8").includes("```mermaid")) {
            const header = join(out, "mermaid.html");
            writeFileSync(header, MERMAID_HEADER);
            args.push("--include-in-header", header);
        }

        const { code, stderr } = await run(pandoc, args);
        if (code !== 0) {
            ctx.ui.notify(`pandoc failed: ${stderr.split("\n")[0] ?? `exit ${code}`}`, "error");
            return;
        }
        openInBrowser(target);
        ctx.ui.notify(`Rendered ${basename(source)} and opened it.`, "info");
    };

    pi.registerCommand("umb-preview", {
        description: "Render a document with pandoc and open it in the browser: /umb-preview <path>",
        handler: show,
    });
}
