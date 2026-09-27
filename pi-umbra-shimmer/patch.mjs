// pi-umbra-shimmer needs 3 seams that pi's extension API does not expose, so it edits
// pi's built bundle. Run it after installing, and again after every pi update:
//
//   node <this file>           apply
//   node <this file> --check   report only, write nothing, exit 1 if anything is missing
//
// pi runs dist/bundle/cli.js, a self-contained bundle, and the chunk names are content-hashed,
// so every patch finds its own place by matching its own text rather than by line number.
//
// Nothing here is destructive. Each patch is additive, a patch whose text no longer matches is
// reported instead of forced, and reinstalling pi returns the bundle to stock. A pi upgrade
// replaces the bundle and drops every patch silently, which is what --check is for.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// PI_UMBRA_PI points this at another pi tree. Otherwise the pi that runs is the one to patch:
// the `pi` on PATH, followed through its symlink. Windows puts a .cmd shim there instead, so
// npm's global root (%APPDATA%\npm\node_modules) comes next, then bun's. The copy npm installs
// beside this package as a peer dependency is last: pi never runs it. The first that has a built
// bundle wins.
const resolvePi = () => {
	if (process.env.PI_UMBRA_PI) return process.env.PI_UMBRA_PI;
	const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 };
	const candidates = [];
	try {
		const bin = execSync(process.platform === "win32" ? "where pi" : "command -v pi", quiet).split(/\r?\n/)[0].trim();
		for (let dir = dirname(realpathSync(bin)); dir !== dirname(dir); dir = dirname(dir)) candidates.push(dir);
	} catch {}
	try {
		const root = execSync("npm root -g", quiet).trim();
		if (root) candidates.push(join(root, "@earendil-works", "pi-coding-agent"));
	} catch {}
	candidates.push(join(homedir(), ".bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent"));
	try {
		candidates.push(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {}
	return candidates.find((dir) => existsSync(join(dir, "dist", "bundle"))) ?? candidates[0];
};

const BUNDLE = join(resolvePi(), "dist/bundle");
if (!existsSync(BUNDLE)) {
	console.error(`no pi bundle at ${BUNDLE} - set PI_UMBRA_PI to your pi install`);
	process.exit(1);
}

const PATCHES = [
	{
		// The indicator is built with a colour function already in hand - the editor embeds the
		// working status, so pi hands it the editor border - and the fallback below never runs.
		// Standing that function down when a shimmer is installed is what lets the fallback through.
		reason: "a shimmer outranks the editor border",
		from: `let colorFn=isWorkingStatusEditor(this.editor)?text=>(this.editor.borderColor??theme.getThinkingBorderColor(this.session.thinkingLevel||"off"))(text):void 0;`,
		to: `let colorFn=globalThis.__umbraShimmer?void 0:isWorkingStatusEditor(this.editor)?text=>(this.editor.borderColor??theme.getThinkingBorderColor(this.session.thinkingLevel||"off"))(text):void 0;`,
	},
	{
		// Custom frames are rendered verbatim, which is what kept the braille glyph out of the
		// wave: the spinner colour function was skipped for them while the message kept being
		// repainted every frame. Verbatim still holds when no shimmer is installed.
		reason: "and paints the custom frames too",
		from: `return this.renderIndicatorVerbatim?frame2:this.spinnerColorFn(frame2)`,
		to: `return this.renderIndicatorVerbatim&&!globalThis.__umbraShimmer?frame2:this.spinnerColorFn(frame2)`,
	},
	{
		// The working indicator paints its spinner with `accent` and its message with `muted`, both
		// fixed at construction. A shimmer has to repaint every character on every frame, so the
		// two colour functions become a lookup the shimmer extension can fill in. Nothing
		// installed means pi's own two colours, unchanged.
		reason: "the working indicator's colours can be taken over",
		from: `super("working",ui,colorFn??(text=>theme.fg("accent",text)),colorFn??(text=>theme.fg("muted",text)),message,indicator)`,
		to: `super("working",ui,colorFn??(text=>(globalThis.__umbraShimmer?.spinner??(t=>theme.fg("accent",t)))(text)),colorFn??(text=>(globalThis.__umbraShimmer?.message??(t=>theme.fg("muted",t)))(text)),message,indicator)`,
	},
];

const files = [join(BUNDLE, "cli.js"), ...readdirSync(join(BUNDLE, "chunks")).map((name) => join(BUNDLE, "chunks", name))];
const CHECK = process.argv.includes("--check");
const unapplied = [];
const gone = [];

for (const patch of PATCHES) {
	let done = false;
	for (const path of files) {
		const source = readFileSync(path, "utf8");
		// A multi-line patch is written with newline escapes; match whatever line ending the file uses.
		const eol = source.includes("\r\n") ? "\r\n" : "\n";
		const from = patch.from.split("\n").join(eol);
		const to = patch.to.split("\n").join(eol);
		if (source.includes(to)) {
			if (!CHECK) console.log(`already patched: ${patch.reason}`);
			done = true;
			break;
		}
		if (!source.includes(from)) continue;
		if (CHECK) {
			unapplied.push(patch.reason);
			done = true;
			break;
		}
		writeFileSync(path, source.replace(from, to));
		console.log(`patched: ${patch.reason}`);
		done = true;
		break;
	}
	// Neither the original text nor the patched text is there, so pi changed the code this
	// patch names. Report it rather than force anything.
	if (!done) gone.push(patch.reason);
}

for (const reason of unapplied) console.log(`NOT APPLIED: ${reason}`);
for (const reason of gone) console.log(`SEAM GONE:   ${reason}`);
const bad = unapplied.length + gone.length;
console.log(bad ? `${bad} of ${PATCHES.length} not in place` : `all ${PATCHES.length} patches applied`);
process.exit(bad ? 1 : 0);
