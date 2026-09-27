// Two commands over the whole pi-umbra family.
//
//   /umb-help    what is installed and how to configure it
//   /umb-doctor  what is wrong with it
//
// They stay apart because they answer different questions, and a help screen that also lists
// faults buries the faults. Both read the live session rather than a written-down list, so
// neither can drift: the commands come from pi.getCommands(), the patches from the bundle on
// disk, the skill roots from the directories pi itself walks.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readUmbraSettings } from "../lib/umbra-settings.ts";

const PREFIX = "umb-";
const AGENT = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
// The bundle this pi is running from: argv[1] is its dist/bundle/cli.js, whether bun or npm
// installed it. PI_UMBRA_PI is the same override the patch scripts take.
const BUNDLE = process.env.PI_UMBRA_PI
	? join(process.env.PI_UMBRA_PI, "dist/bundle/chunks")
	: join(dirname(realpathSync(process.argv[1] ?? "")), "chunks");

// Everything umbra does through pi's own API needs no probe: it either loaded or it did not, and
// pi says so at startup. These are the ones that fail silently, because each is a patch the
// feature checks for at run time and shrugs off when it is absent.
export type Probe = { id: string; marker: string; feature: string; without: string; command?: string };

export const PROBES: Probe[] = [
	{
		id: "shimmer",
		marker: "globalThis.__umbraShimmer",
		feature: "working indicator shimmer",
		without: "installs and animates nothing",
		command: "umb-shimmer",
	},
	{
		id: "loop",
		marker: "globalThis.__piSubmit",
		feature: "the /umb-loop resubmit",
		without: "/umb-loop refuses to start",
		command: "umb-loop",
	},
	{
		id: "mid-slash",
		marker: "umbraMidSlash",
		feature: "mid-sentence skill completion",
		without: "a /name inside a sentence opens no menu",
	},
];

export type Facts = {
	/** Probe id to whether its marker is in place. */
	patches: Record<string, boolean>;
	/** The umb- commands this session actually registered. */
	commands: string[];
	/** Skill roots in the order pi resolves them: the first to claim a name wins. */
	skillRoots: { root: string; names: string[] }[];
	truecolor: boolean;
	theme: string;
	/** Set by umbra-background once the terminal has answered; absent when it never did. */
	background?: { wanted: string; ignored: boolean; howTo: string };
};

export type Finding = { level: "warn" | "note"; title: string; detail: string };

/** A name claimed by more than one root, with the roots that lose it. */
export const shadowed = (roots: Facts["skillRoots"]): { name: string; winner: string; losers: string[] }[] => {
	const seen = new Map<string, string>();
	const losers = new Map<string, { winner: string; losers: string[] }>();
	for (const { root, names } of roots) {
		for (const name of names) {
			const winner = seen.get(name);
			if (winner === undefined) {
				seen.set(name, root);
				continue;
			}
			const entry = losers.get(name) ?? { winner, losers: [] };
			entry.losers.push(root);
			losers.set(name, entry);
		}
	}
	return [...losers].map(([name, entry]) => ({ name, ...entry }));
};

export const diagnose = (facts: Facts): Finding[] => {
	const findings: Finding[] = [];

	for (const probe of PROBES) {
		if (facts.patches[probe.id] !== false) continue;
		// A patch nothing depends on is not a fault. Only say so when the feature is installed.
		if (probe.command !== undefined && !facts.commands.includes(probe.command)) continue;
		findings.push({
			level: "warn",
			title: `patch missing: ${probe.feature}`,
			detail: `Without it, ${probe.without}. Run the patch.mjs of the package that adds it, then restart pi.`,
		});
	}

	const clashes = shadowed(facts.skillRoots);
	if (clashes.length > 0) {
		const names = clashes.slice(0, 5).map((clash) => clash.name);
		const more = clashes.length > names.length ? `, +${clashes.length - names.length} more` : "";
		findings.push({
			level: "warn",
			title: `${clashes.length} skill name${clashes.length === 1 ? "" : "s"} claimed by two roots`,
			detail: `${names.join(", ")}${more}. ${clashes[0]!.winner} wins; the copy in ${clashes[0]!.losers[0]} is skipped, even when it is the newer one.`,
		});
	}

	if (facts.background?.ignored) {
		findings.push({
			level: "warn",
			title: "the terminal kept its own background",
			detail: `It did not take ${facts.background.wanted}, so the theme is not shown in full. ${facts.background.howTo}`,
		});
	}

	// A note rather than a warning: plenty of terminals handle 24-bit colour without announcing
	// it, so this is a guess that has to earn its line rather than cry wolf on every run.
	if (!facts.truecolor) {
		findings.push({
			level: "note",
			title: "the terminal did not announce truecolor",
			detail: "Colours may band. If yours does support it, set COLORTERM=truecolor.",
		});
	}

	if (!facts.theme.startsWith("umbra-")) {
		findings.push({
			level: "note",
			title: `the active theme is ${facts.theme}`,
			detail: "Everything still works. The seven umbra themes fill every colour key; pick one with /settings.",
		});
	}

	return findings;
};

export const renderDoctor = (findings: Finding[]): string => {
	if (findings.length === 0) return "umb-doctor: nothing to report.";
	const lines = [`umb-doctor: ${findings.length} thing${findings.length === 1 ? "" : "s"} to look at`, ""];
	for (const finding of findings) {
		lines.push(`${finding.level === "warn" ? "!" : "-"} ${finding.title}`);
		lines.push(`  ${finding.detail}`);
	}
	return lines.join("\n");
};

export type Command = { name: string; description?: string };

export const renderHelp = (commands: Command[], settings: object, theme: string): string => {
	const mine = commands
		.filter((command) => command.name.startsWith(PREFIX))
		.sort((left, right) => left.name.localeCompare(right.name));
	const width = Math.max(0, ...mine.map((command) => command.name.length));
	const lines = ["pi-umbra", ""];
	if (mine.length === 0) lines.push("  No umb- command is registered in this session.");
	for (const command of mine) {
		// The description is pi's own, written where the command is registered, so it cannot drift.
		lines.push(`  /${command.name.padEnd(width)}  ${command.description ?? ""}`.trimEnd());
	}
	lines.push("", `theme: ${theme}`, "", "settings: ~/.pi/agent/settings.json, under piUmbraTheme");
	lines.push(JSON.stringify(settings, null, 2));
	lines.push("", "/umb-doctor reports what is wrong rather than what exists.");
	return lines.join("\n");
};

const namesIn = (root: string): string[] => {
	try {
		return readdirSync(root).filter((name) => {
			try {
				return statSync(join(root, name, "SKILL.md")).isFile();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
};

/**
 * COLORTERM is the only standard signal and most terminals never set it, so the ones known to
 * handle 24-bit colour are read from their own variables instead. Everything here is a positive
 * signal: an unrecognised terminal is unknown, not broken.
 */
export const announcesTruecolor = (env: Record<string, string | undefined>): boolean =>
	env.COLORTERM === "truecolor" ||
	env.COLORTERM === "24bit" ||
	env.WT_SESSION !== undefined ||
	["iTerm.app", "WezTerm", "vscode", "ghostty", "kitty"].includes(env.TERM_PROGRAM ?? "") ||
	env.KITTY_WINDOW_ID !== undefined;

/** Never throws: a diagnostic that takes the session down is worse than one that says less. */
const has = (paths: string[], marker: string): boolean => {
	for (const path of paths) {
		try {
			if (readFileSync(path, "utf8").includes(marker)) return true;
		} catch {}
	}
	return false;
};

export const gather = (cwd: string, theme: string, commands: Command[]): Facts => {
	// No bundle found means no answer, not a missing patch: diagnose skips a probe left unset.
	const patches: Record<string, boolean> = {};
	if (existsSync(BUNDLE)) {
		const chunks = readdirSync(BUNDLE).map((name) => join(BUNDLE, name));
		for (const probe of PROBES) patches[probe.id] = has(chunks, probe.marker);
	}

	// The order pi resolves them in, which is the order that decides a collision.
	const roots = [join(AGENT, "skills"), join(cwd, ".pi", "skills"), join(homedir(), ".agents", "skills")];
	return {
		patches,
		commands: commands.map((command) => command.name),
		skillRoots: roots.map((root) => ({ root, names: namesIn(root) })).filter((entry) => entry.names.length > 0),
		truecolor: announcesTruecolor(process.env),
		theme,
		background: (globalThis as { __umbraBackground?: Facts["background"] }).__umbraBackground,
	};
};

export default function help(pi: ExtensionAPI) {
	pi.registerCommand("umb-help", {
		description: "What pi-umbra installed and how to configure it",
		handler: (_args: string, ctx: ExtensionCommandContext) => {
			const settings = readUmbraSettings();
			ctx.ui.notify(renderHelp(pi.getCommands(), settings, ctx.ui.theme.name));
		},
	});

	pi.registerCommand("umb-doctor", {
		description: "Check pi-umbra for the faults that would otherwise stay silent",
		handler: (_args: string, ctx: ExtensionCommandContext) => {
			const facts = gather(ctx.sessionManager.getCwd(), ctx.ui.theme.name, pi.getCommands());
			ctx.ui.notify(renderDoctor(diagnose(facts)));
		},
	});
}
