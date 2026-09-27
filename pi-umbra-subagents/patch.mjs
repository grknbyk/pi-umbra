// /umb-loop needs one seam pi's extension API does not expose: the editor's own submit path,
// which is the only way an extension can send a prompt the way the user does. This publishes it
// as globalThis.__piSubmit. Run it after installing, and again after every pi update:
//
//   node <this file>           apply
//   node <this file> --check   report only, write nothing, exit 1 if it is missing
//
// pi runs dist/bundle/cli.js, a self-contained bundle, and the chunk names are content-hashed,
// so the patch finds its place by matching its own text rather than by line number.
//
// Nothing here is destructive. The patch is additive, text that no longer matches is reported
// instead of forced, and reinstalling pi returns the bundle to stock. A pi upgrade replaces the
// bundle and drops the patch silently, which is what --check is for.
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
		// The extension API cannot submit a prompt, so /umb-loop borrows the editor's own path.
		reason: "publish the editor submit handler for /umb-loop",
		from: "this.setupEditorSubmitHandler(),",
		to: "this.setupEditorSubmitHandler(),globalThis.__piSubmit=text=>this.defaultEditor.onSubmit?.(text),",
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
