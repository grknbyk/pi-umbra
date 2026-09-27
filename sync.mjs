// Copies the working extensions in ~/.pi/agent into the packages that publish them.
//
//   node ~/pi-umbra/sync.mjs          copy, then report what moved
//   node ~/pi-umbra/sync.mjs --check  report only, exit 1 if anything has drifted
//
// The agent directory is where the code is actually written and run, so it is the source and
// the packages are the copy. Editing a package by hand is how the two ended up apart before.
//
// A check lives beside its extension in the agent directory and imports `../name.ts`; in a
// package it sits one level up from `extensions/`, so that path has to be rewritten on the way
// in. Without it the packaged checks resolve to a file that is not there and every one of them
// fails on import - which is the state they were found in.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AGENT = join(homedir(), ".pi", "agent");
const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/** extensions and checks are named without their suffix; lib and themes are file names. */
const PACKAGES = {
	"pi-umbra-ask": { extensions: ["umbra-ask"], lib: ["clean.ts"], checks: ["umbra-ask"] },
	"pi-umbra-copy-chat": { extensions: ["umbra-copy-chat"], checks: ["umbra-copy-chat"] },
	"pi-umbra-preview": { extensions: ["umbra-preview"], checks: ["umbra-preview"] },
	// footer/working share lib/umbra-format.ts and gutter/toolbox/working share lib/umbra-settings.ts,
	// so these four are one connected component and travel together. The three that were here and
	// import no lib now have their own package: inputbar because the editor is a bigger
	// thing to replace than a footer, shimmer because it is the only extension in the set that does
	// nothing at all without repatch, and quarantining it leaves this package pure npm.
	"pi-umbra-theme": {
		extensions: ["umbra-background", "umbra-footer", "umbra-gutter", "umbra-image-viewer", "umbra-toolbox", "umbra-working"],
		lib: ["umbra-format.ts", "umbra-settings.ts"],
		checks: ["umbra-background", "umbra-footer", "umbra-gutter", "umbra-image-viewer", "umbra-toolbox", "umbra-working"],
		themes: true,
	},
	"pi-umbra-help": { extensions: ["umbra-help"], lib: ["umbra-settings.ts"], checks: ["umbra-help"] },
	"pi-umbra-inputbar": { extensions: ["umbra-inputbar"], checks: ["umbra-inputbar"] },
	"pi-umbra-shimmer": { extensions: ["umbra-shimmer"], checks: ["umbra-shimmer"] },
	"pi-umbra-subagents": { extensions: ["umbra-subagents", "umbra-loop"] },
};

const checkOnly = process.argv.includes("--check");
const moved = [];
const drifted = [];

/** Writes `text` to `target` unless it is already there. Reports either way. */
const put = (target, text, label) => {
	const same = existsSync(target) && readFileSync(target, "utf8") === text;
	if (same) return;
	drifted.push(label);
	if (checkOnly) return;
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text);
	moved.push(label);
};

// An extension can be a directory with an index.ts (umbra-toolbox is): its installed
// dependencies stay behind, the package.json carries them instead.
const SKIP = new Set(["node_modules", "package.json", "package-lock.json"]);
const filesUnder = (dir, prefix = "") =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (SKIP.has(entry.name)) return [];
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		// A linked directory is copied as a real one: umbra-subagents links in the delegate skill.
		const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(dir, entry.name)).isDirectory());
		return isDir ? filesUnder(join(dir, entry.name), rel) : [rel];
	});

for (const [name, plan] of Object.entries(PACKAGES)) {
	const root = join(HERE, name);
	if (!existsSync(root)) throw new Error(`no such package: ${root}`);

	for (const stem of plan.extensions ?? []) {
		const dir = join(AGENT, "extensions", stem);
		if (!(existsSync(dir) && statSync(dir).isDirectory())) {
			const from = join(AGENT, "extensions", `${stem}.ts`);
			put(join(root, "extensions", `${stem}.ts`), readFileSync(from, "utf8"), `${name}/extensions/${stem}.ts`);
			continue;
		}
		const wanted = filesUnder(dir);
		for (const rel of wanted) {
			put(join(root, "extensions", stem, rel), readFileSync(join(dir, rel), "utf8"), `${name}/extensions/${stem}/${rel}`);
		}
		// A directory can come with an entry file beside it (umbra-subagents.ts); without one, a
		// flat file in the package is the single-file layout this extension had before.
		const flat = join(root, "extensions", `${stem}.ts`);
		const entry = join(AGENT, "extensions", `${stem}.ts`);
		if (existsSync(entry)) put(flat, readFileSync(entry, "utf8"), `${name}/extensions/${stem}.ts`);
		const stale = existsSync(flat) && !existsSync(entry) ? [flat] : [];
		const target = join(root, "extensions", stem);
		if (existsSync(target)) stale.push(...filesUnder(target).filter((rel) => !wanted.includes(rel)).map((rel) => join(target, rel)));
		for (const file of stale) {
			drifted.push(`${file.slice(HERE.length + 1)} (stale)`);
			if (checkOnly) continue;
			rmSync(file);
			moved.push(`${file.slice(HERE.length + 1)} (removed)`);
		}
	}
	for (const file of plan.lib ?? []) {
		put(join(root, "lib", file), readFileSync(join(AGENT, "lib", file), "utf8"), `${name}/lib/${file}`);
	}
	// Only the package's own extensions are redirected, and only when the path names one exactly.
	// A blanket rewrite of `../` also catches `../lib/clean.ts`, which is one level up in both
	// layouts and must not move. Matching the whole quoted path covers `from "..."` and
	// `await import("...")` alike: three of these checks reach for their subject with the latter.
	for (const stem of plan.checks ?? []) {
		const from = join(AGENT, "extensions", "checks", `${stem}.check.ts`);
		// A check sits two levels under the agent root and one under the package root, so the
		// shared lib is `../../lib` in one and `../lib` in the other. The extensions themselves
		// are one level down in both layouts and need no such adjustment.
		let source = readFileSync(from, "utf8").split('"../../lib/').join('"../lib/');
		for (const own of plan.extensions ?? []) {
			source = source.split(`"../${own}.ts"`).join(`"../extensions/${own}.ts"`);
			source = source.split(`"../${own}/`).join(`"../extensions/${own}/`);
		}
		put(join(root, "checks", `${stem}.check.ts`), source, `${name}/checks/${stem}.check.ts`);
	}
	if (plan.themes !== true) continue;

	// Themes are copied by whatever is in the directory rather than by a list, and anything the
	// agent no longer has is dropped. The seven were renamed once already, and the package kept
	// serving both the old names and the new ones.
	const themes = join(root, "themes");
	mkdirSync(themes, { recursive: true });
	const wanted = readdirSync(join(AGENT, "themes")).filter((file) => file.endsWith(".json"));
	for (const file of wanted) {
		put(join(themes, file), readFileSync(join(AGENT, "themes", file), "utf8"), `${name}/themes/${file}`);
	}
	for (const file of readdirSync(themes)) {
		if (wanted.includes(file)) continue;
		drifted.push(`${name}/themes/${file} (stale)`);
		if (checkOnly) continue;
		rmSync(join(themes, file));
		moved.push(`${name}/themes/${file} (removed)`);
	}
}

if (checkOnly) {
	if (drifted.length === 0) console.log("sync --check: every package matches the agent directory");
	else {
		console.log(`sync --check: ${drifted.length} out of date`);
		for (const label of drifted) console.log(`  ${label}`);
		process.exit(1);
	}
} else if (moved.length === 0) console.log("sync: nothing to copy");
else {
	for (const label of moved) console.log(`copied: ${label}`);
	console.log(`sync: ${moved.length} file${moved.length === 1 ? "" : "s"}`);
}
