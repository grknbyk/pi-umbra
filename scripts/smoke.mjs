// Installs every package the way a user does and proves pi loads it, on whatever OS runs this.
//
//   node scripts/smoke.mjs
//
// Each package is packed with `npm pack` and the tarballs are installed into pi's own npm
// directory of a throwaway PI_CODING_AGENT_DIR, then listed as `npm:<name>` packages: what
// `pi install npm:<name>` leaves behind, without a registry. (`pi install npm:<tarball>` is no
// substitute: pi names the package after the path and never finds it.) pi is then started in
// RPC mode and asked for its commands: every command and skill below has to be there, and
// nothing may fail to load. Last, each bundle patch is applied to the pi on PATH and checked. Needs `pi` and `npm`
// on PATH; NPM="bunx npm@11" swaps in another npm.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = {
	"pi-umbra-theme": ["umb-bg", "umb-toolbox"],
	"pi-umbra-inputbar": ["umb-color"],
	"pi-umbra-ask": [],
	"pi-umbra-shimmer": ["umb-shimmer"],
	"pi-umbra-copy-chat": ["umb-copy-chat"],
	"pi-umbra-preview": ["umb-preview"],
	"pi-umbra-help": ["umb-help", "umb-doctor"],
	"pi-umbra-subagents": ["umb-agents", "umb-fan", "umb-loop", "skill:delegate", "skill:fan"],
};
const PATCHED = ["pi-umbra-shimmer", "pi-umbra-subagents"];
// A branch cut before a package existed has no directory for it. Say so rather than fail on it.
for (const name of Object.keys(PACKAGES)) {
	if (existsSync(join(ROOT, name))) continue;
	console.log(`skip ${name}: not in this checkout`);
	delete PACKAGES[name];
	PATCHED.splice(PATCHED.indexOf(name), PATCHED.includes(name) ? 1 : 0);
}

const work = mkdtempSync(join(tmpdir(), "umbra-smoke-"));
const agent = join(work, "agent");
const tarballs = join(work, "tgz");
mkdirSync(agent, { recursive: true });
mkdirSync(tarballs, { recursive: true });
const NPM = process.env.NPM ?? "npm";
const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
// Windows reaches npm and pi through .cmd shims, which only a shell resolves.
const run = (command) => execSync(command, { env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const quote = (text) => `"${text}"`;
let failed = 0;
const fail = (message) => {
	failed++;
	console.log(`FAIL ${message}`);
};

for (const name of Object.keys(PACKAGES)) {
	run(`${NPM} pack ${quote(join(ROOT, name))} --silent --pack-destination ${quote(tarballs)}`);
}
const npmDir = join(agent, "npm");
mkdirSync(npmDir);
writeFileSync(join(npmDir, "package.json"), JSON.stringify({ name: "pi-extensions", private: true }));
run(`${NPM} install --prefix ${quote(npmDir)} ${readdirSync(tarballs).map((file) => quote(join(tarballs, file))).join(" ")}`);
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: Object.keys(PACKAGES).map((name) => `npm:${name}`) }));

// One RPC round trip: the command list, and whatever pi printed while loading extensions.
const commands = await new Promise((resolve, reject) => {
	// An empty home, so skills and extensions of whoever runs this stay out of the list.
	const home = { HOME: work, USERPROFILE: work };
	const child = spawn("pi", ["--mode", "rpc", "--no-session"], { env: { ...env, ...home }, shell: process.platform === "win32" });
	let out = "";
	let err = "";
	const timer = setTimeout(() => {
		child.kill();
		reject(new Error(`no get_commands reply in 60 s\n${err}`));
	}, 60_000);
	child.stdout.on("data", (chunk) => {
		out += chunk;
		// The reply is large and can arrive in pieces: only a line that has its newline is whole.
		for (const line of out.split("\n").slice(0, -1)) {
			if (!line.includes('"get_commands"')) continue;
			clearTimeout(timer);
			child.kill();
			resolve({ reply: JSON.parse(line), stderr: err });
			return;
		}
	});
	child.stderr.on("data", (chunk) => (err += chunk));
	child.on("error", reject);
	child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
});

if (/fail|error/i.test(commands.stderr)) fail(`pi reported while loading:\n${commands.stderr}`);
// Each command has to come from inside its own package.
const loaded = commands.reply.data.commands;
for (const [name, expected] of Object.entries(PACKAGES)) {
	const missing = expected.filter((command) => !loaded.some((entry) => entry.name === command && entry.sourceInfo?.path?.includes(name)));
	if (missing.length) fail(`${name}: missing ${missing.join(", ")}`);
	else console.log(`ok   ${name}${expected.length ? `: ${expected.join(", ")}` : ""}`);
}

for (const name of PATCHED) {
	const script = join(agent, "npm", "node_modules", name, "patch.mjs");
	try {
		run(`node ${quote(script)}`);
		run(`node ${quote(script)} --check`);
		console.log(`ok   ${name}: patch applied and checked`);
	} catch (error) {
		fail(`${name}: patch.mjs exited ${error.status}`);
	}
}

rmSync(work, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : "smoke ok");
process.exit(failed ? 1 : 0);
