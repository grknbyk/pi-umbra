import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Which models a branch can run on, checked before a run starts. A branch is `pi -p
// --no-extensions`, so a model that only an extension provides is not there for it unless $LOAD
// puts that extension back. Checking first costs one `--list-models` per session; finding out
// afterwards cost a started run of failed branches, read back from pi's error text.

export type FanSettings = { load: string[]; timeoutMs: number };
export type Offer = { from: "scoped" | "free" | "reachable"; models: string[] };

export const RUN_SH = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "delegate", "run.sh");

const run = (command: string, args: string[], timeout: number) =>
	new Promise<string>((resolve) =>
		execFile(command, args, { timeout, maxBuffer: 4 << 20, windowsHide: true }, (_error, stdout) => resolve(stdout ?? "")),
	);

/** The environment alone: what a caller with no bash, and the check, get. */
export const envSettings = (load = "", timeout = ""): FanSettings => ({
	load: (process.env.FAN_LOAD ?? load).split(/\s+/).filter(Boolean),
	timeoutMs: Number(process.env.FAN_TIMEOUT_MS) || Number(timeout) * 1000 || 300_000,
});

/** $LOAD and $DELEGATE_TIMEOUT through run.sh's own dconfig, so fan and the delegate skill
 *  read one set of files the same way. FAN_LOAD and FAN_TIMEOUT_MS win. */
export const fanSettings = async (): Promise<FanSettings> => {
	const script = '. "$1"; dconfig; printf "%s\\n%s" "$LOAD" "$DELEGATE_TIMEOUT"';
	const [load = "", timeout = ""] = (await run("bash", ["-c", script, "fan", RUN_SH], 5_000)).split("\n");
	return envSettings(load, timeout);
};

// One listing per extension set. A failed listing is not kept, and forget() drops one after a
// refusal, so a /login or a models.json edit is seen on the next try.
const listings = new Map<string, Promise<string[]>>();

export const forget = (load: string[]) => listings.delete(load.join(" "));

/** `provider/id` for every model a branch started with `load` can reach. Empty when the listing
 *  failed, which the caller reads as "cannot tell", never as "nothing is reachable". */
export const reachableModels = (pi: string[], load: string[]): Promise<string[]> => {
	const key = load.join(" ");
	if (!listings.has(key)) {
		const [command, ...prefix] = pi;
		const listing = run(command as string, [...prefix, "--no-extensions", "--no-skills", ...load, "--list-models"], 60_000).then((out) => {
			const models = parseListing(out);
			if (!models.length) listings.delete(key);
			return models;
		});
		listings.set(key, listing);
	}
	return listings.get(key) as Promise<string[]>;
};

/** The table after its `provider model ...` header. Anything a LOAD extension printed while
 *  loading comes before the header, so it is skipped rather than read as a provider. */
export const parseListing = (out: string): string[] => {
	const lines = out.split("\n").map((line) => line.trim().split(/\s+/));
	const header = lines.findIndex(([first, second]) => first === "provider" && second === "model");
	return header === -1
		? []
		: lines
				.slice(header + 1)
				.filter((cells) => cells.length > 1)
				.map(([provider, model]) => `${provider}/${model}`);
};

const THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/i;

/** pi's own rule, loosely: a known model, an id some provider lists as is (`anthropic/x` under
 *  openrouter), any id under a known provider (pi then runs it as a custom id and only warns),
 *  or a bare name that some known id contains. */
export const canReach = (model: string, reachable: string[]): boolean => {
	const id = model.replace(THINKING, "").toLowerCase();
	const known = reachable.map((entry) => entry.toLowerCase());
	if (known.includes(id) || known.some((entry) => entry.slice(entry.indexOf("/") + 1) === id)) return true;
	const slash = id.indexOf("/");
	if (slash > 0) return known.some((entry) => entry.startsWith(`${id.slice(0, slash)}/`));
	return known.some((entry) => entry.includes(id));
};

/** An `enabledModels` entry against the list, the way pi reads them: exact, glob or fuzzy,
 *  case-insensitive, with an optional thinking suffix. */
const matches = (pattern: string, reachable: string[]): string[] => {
	const bare = pattern.replace(THINKING, "").toLowerCase();
	if (bare.includes("*")) {
		const glob = new RegExp(`^${bare.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
		return reachable.filter((entry) => glob.test(entry) || glob.test(entry.slice(entry.indexOf("/") + 1)));
	}
	const exact = reachable.filter((entry) => entry.toLowerCase() === bare || entry.toLowerCase().endsWith(`/${bare}`));
	return exact.length ? exact : reachable.filter((entry) => entry.toLowerCase().includes(bare));
};

/** What to offer instead: the user's scoped models (global, then project settings) that a
 *  branch can reach; else the free ones it can reach; else the first few it can reach. */
export const offerModels = (cwd: string, reachable: string[]): Offer => {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const scoped = [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]
		.flatMap((file) => {
			try {
				return (JSON.parse(readFileSync(file, "utf8")).enabledModels as string[] | undefined) ?? [];
			} catch {
				return [];
			}
		})
		.flatMap((pattern) => matches(pattern, reachable));
	if (scoped.length) return { from: "scoped", models: [...new Set(scoped)].slice(0, 6) };
	const free = reachable.filter((model) => model.endsWith(":free"));
	return free.length ? { from: "free", models: free.slice(0, 6) } : { from: "reachable", models: reachable.slice(0, 6) };
};

export const describeOffer = (offer: Offer): string =>
	offer.models.length
		? `${{ scoped: "from your scoped models", free: "free models", reachable: "models a branch can reach" }[offer.from]}: ${offer.models.join(", ")}`
		: "no model a branch can reach was found (`pi --no-extensions --list-models` shows them)";

// The matching rules above against a fixed listing, so a drift from pi's resolver shows here.
const demo = () => {
	const reachable = parseListing(
		"loading provider...\nprovider    model                 context\nopenrouter  anthropic/claude-x    200K\nopenrouter  nvidia/nemo:free      128K\nanthropic   claude-opus-5         1M\n",
	);
	console.assert(reachable.length === 3 && reachable[0] === "openrouter/anthropic/claude-x", `listing: ${reachable}`);
	console.assert(canReach("anthropic/claude-x", reachable), "an id a provider lists under a slash");
	console.assert(canReach("anthropic/claude-opus-5:high", reachable), "thinking suffix");
	console.assert(canReach("anthropic/custom-id", reachable), "custom id under a known provider");
	console.assert(canReach("opus-5", reachable), "bare name");
	console.assert(!canReach("openai/gpt-5", reachable), "unknown provider");
	console.assert(matches("openrouter/*", reachable).length === 2, "glob");
	console.assert(matches("claude-opus-5:high", reachable)[0] === "anthropic/claude-opus-5", "exact with a suffix");
	console.assert(parseListing("no table here").length === 0, "no header is no listing");
	console.log("models.ts ok");
};

if (process.argv[1]?.endsWith("models.ts")) demo();
