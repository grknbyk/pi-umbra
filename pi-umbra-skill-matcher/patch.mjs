// pi-umbra-skill-matcher needs 4 seams that pi's extension API does not expose, so it edits
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
		// A skill is reachable as /skill:huh only. The prefix is hardcoded at both sites below,
		// with no setting for it. The dispatch map now holds each skill under both names, so
		// /huh works and any /skill:huh already in muscle memory or in a doc keeps working.
		// Only the bare name is offered in autocomplete, to keep the list one line per skill.
		reason: "/huh instead of /skill:huh",
		from: "let commandName=`skill:${skill.name}`;this.skillCommands.set(commandName,skill.filePath),skillCommandList.push({name:commandName,",
		to: "let commandName=skill.name;this.skillCommands.set(`skill:${skill.name}`,skill.filePath),this.skillCommands.set(commandName,skill.filePath),skillCommandList.push({name:commandName,",
	},
	{
		reason: "the command list names skills without the prefix too",
		from: "skills=this._resourceLoader.getSkills().skills.map(skill=>({name:`skill:${skill.name}`,",
		to: "skills=this._resourceLoader.getSkills().skills.map(skill=>({name:skill.name,",
	},
	{
		// The slash menu only ever opens on a line that starts with "/": `isAtStartOfMessage`
		// gates the keystroke and `isInSlashCommandContext` gates every letter after it. A
		// "/name" written in the middle of a sentence therefore reaches no provider at all, and
		// an extension cannot fix that - it is never asked. These two open the door;
		// umbra-skill-matcher decides what stands behind it.
		//
		// `umbraMidSlash` is deliberately narrow, so a path keeps behaving like a path: the
		// token must be the last one on the line, hold no space, and sit after real text that
		// ends in whitespace. "src/foo" fails on the last clause, "  /foo" on the one before it.
		// `head!==head.trimEnd()` is how "ends in a space or a tab" is written without putting an
		// escape inside a patch string.
		reason: "a mid-sentence /name opens the slash menu",
		from: `isInSlashCommandContext(textBeforeCursor){return this.isSlashMenuAllowed()&&textBeforeCursor.trimStart().startsWith("/")}`,
		to: `isInSlashCommandContext(textBeforeCursor){return this.isSlashMenuAllowed()&&textBeforeCursor.trimStart().startsWith("/")||this.umbraMidSlash(textBeforeCursor)}umbraMidSlash(t){let i=t.lastIndexOf("/");if(i<1)return!1;if(t.slice(i+1).indexOf(" ")>=0)return!1;let head=t.slice(0,i);return head.trim()!==""&&head!==head.trimEnd()}`,
	},
	{
		// The companion to the patch above: without it the menu opens on the second character
		// rather than on the slash, because typing "/" is handled by its own branch that ends at
		// `isAtStartOfMessage`. At that moment the token after the slash is still empty, which is
		// exactly the shape `umbraMidSlash` accepts.
		reason: "typing a mid-sentence slash opens the menu on the slash",
		from: `char==="/"&&this.isAtStartOfMessage()`,
		to: `char==="/"&&(this.isAtStartOfMessage()||this.umbraMidSlash((this.state.lines[this.state.cursorLine]||"").slice(0,this.state.cursorCol)))`,
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
