import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envSettings, type FanSettings } from "./models.ts";
import { closeWorktree, discardCommand, dropWorktree, gitRepo, mergeCommand, openWorktree, snapshot, type Worktree } from "./worktree.ts";
import { LINGER_MS, OUT_DIR, pidLive, readRun, type BranchState, type RunState } from "../skills/delegate/state.ts";

// The producer. It launches branches, keeps their run directory honest, and hands the panel
// one snapshot to render.
//
// It writes delegate v2's on-disk shape — one seeded `state/<stem>.json` per branch, then
// `-e beacon.ts` inside the branch as that file's only writer — instead of holding branches
// in RAM. Three things fall out of that and none of them are reachable in memory: a branch
// given `bash` can fan out again and its children land in the SAME run directory through
// PI_BRANCH_RUN, so reference 3's `└` nesting renders two deep; a run started from bash by
// the delegate skill is the same run this file would have started, so there is one reader
// and one format; and the reports survive quitting pi.
//
// Nothing here ever writes a branch's status. Status is derived by the reader from the
// `.exit` file and the pid, so a kill that silently fails leaves a row reading "running",
// which is the truth, rather than "stopped", which would be a lie.

/** What `/umb-fan` and the model's ```fan block both parse into. */
export type RunSpec = {
	name: string;
	description: string;
	phases: { title: string; branches: { label: string; model?: string; task: string; write?: boolean }[] }[];
};

// Every branch gets the same tail on its system prompt. Same contract as the delegate skill's
// report.md, kept here as a string because a branch launched from this extension must not
// depend on a skill folder being installed.
const CONTRACT =
	"Your final message is the only thing the caller reads. Answer it directly in markdown, " +
	"cite every claim as file:line, and write no preamble. End with a single line " +
	"'STATUS: OK' when you answered fully, 'STATUS: PARTIAL' when you answered part of it, or " +
	"'STATUS: NEED_STRONGER' when the task needs a stronger model.";
// Read-only branches only: a write branch's worktree closes when it ends, so it cannot be continued.
const ASKING =
	"When a decision only the caller can make blocks you, stop at once and end with 'STATUS: ASKING', " +
	"then 'QUESTION: <one question>' and 'OPTIONS: <choices separated by \" | \", recommended first>'; " +
	"your session is kept and the answer arrives as your next message.";

// Read-only by default: a branch that can run bash can start branches of its own, and nothing
// here caps the depth. Reference 3's `└` nesting needs exactly that, so it is a knob rather
// than a constant — set FAN_TOOLS="read,grep,find,ls,bash" to allow it, and watch the panel.
const READ_ONLY_TOOLS = process.env.FAN_TOOLS || "read,grep,find,ls";
// A `[write]` branch edits and runs tests, so it gets the full set, and its own worktree to do
// it in. bash reaches past the worktree, so the rules below are the fence; pi has no sandbox.
const WRITE_TOOLS = "read,grep,find,ls,edit,write,bash";
const writeRules = (worktree: Worktree) =>
	`You work in your own git worktree at ${worktree.path}, on branch ${worktree.branch}, and you may ` +
	"edit files and run commands there. Never touch files outside it, never push, publish, deploy " +
	"or delete branches, and do not commit: your changes are committed for you when you finish, " +
	"and the user decides whether they are merged. Say in your answer what you changed and how " +
	"you checked it. When a decision blocks you, take the recommended option and say which. " +
	// The brief and the task were written about the user's tree, and edit and write go wherever
	// a path points: an absolute path into the repo would land in the user's files.
	`Every path under ${worktree.root} in your task or the brief means the same file under ${worktree.path}: ` +
	`edit ${worktree.path}/<rest>, never ${worktree.root}/<rest>.`;
// `--no-extensions` drops provider extensions too, so a branch on a model that only exists
// because of one cannot start without it loaded back: that list ($LOAD) and the time limit come
// in with each run as FanSettings (models.ts), read from the same delegate.env run.sh reads.
// The reader costs one readdir and a handful of 300-byte files, so the tick is set by what
// the eye wants rather than by what the disk can take: the activity sentence changes several
// times a second, and 250 ms is the slowest rate at which it still reads as live.
// ponytail: one interval, no fs.watch. Add a watcher only if the sentence starts lagging.
const TICK_MS = 250;
// A stop is soft first so the branch's last words reach its .md, then forced. Anything that
// survives both keeps its row and its "running" status until it really dies.
// The grace is short on Windows on purpose: a soft taskkill posts WM_CLOSE, which a console
// process has no message loop to answer, so waiting three seconds for it buys nothing but a
// row that looks stuck. SIGTERM off Windows is real, and gets the full window.
const GRACE_MS = process.platform === "win32" ? 1_000 : 3_000;
const FORCE_MS = 1_500;
const KILL_POLL_MS = 150;

// pi is installed as a shim that runs `node <bundle>/cli.js` (~/.bun/bin/pi.bunx), so a branch
// is launched as the same interpreter and the same entry file as this process. That sidesteps
// PATH lookup, .cmd shims and quoting on Windows. A compiled single-file build has no script
// argument, and then execPath alone is the whole command. PI_BIN is how the check substitutes
// a stub for pi without putting an executable on PATH. Real node leaves argv[1] as the npm bin
// symlink (/usr/local/bin/pi, no .js), so it is followed to the file it points at first.
export const piCommand = (): string[] => {
	const override = process.env.PI_BIN;
	if (override) return /\.[cm]?js$/.test(override) ? [process.execPath, override] : [override];
	const entry = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined;
	return entry && /\.[cm]?js$/.test(entry) ? [process.execPath, entry] : [process.execPath];
};

// The beacon ships beside this file. Resolved from import.meta.url rather than from cwd,
// because a branch is started from the session cwd and this extension lives elsewhere.
const BEACON = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "delegate", "beacon.ts");

/** `^[a-z0-9][a-z0-9_-]*$` and nothing else: a stem is an NTFS filename and part of a git
 *  branch name, and a dot is what git refuses there (`..`, `.lock`, a trailing dot). */
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Launch = {
	stem: string;
	phase: string;
	name: string;
	model: string;
	task: string;
	timeoutMs: number;
	load: string[];
	worktree?: Worktree;
};

let current: RunState | undefined;
let sessionCwd = "";
let runDir = "";
// Set beside runDir and read at spawn time, so a branch launched in a later phase still
// finds the brief the run started with.
let briefPath: string | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let lastKey = "";
// Phases launch one after another; each entry is one phase's branches, in launch order.
let pending: Launch[][] = [];
// Only branches this process spawned. A run started from bash by the delegate skill is read
// and stopped through its pid instead, which is why nothing below assumes membership.
const children = new Map<string, ChildProcess>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const timedOut = new Set<string>();
const listeners = new Set<() => void>();
// A bash tool call may be the delegate skill mid-run, so the tick keeps going for the rest of
// the turn even when this extension has spawned nothing itself. A flag rather than a counter:
// a bash call cannot outlive the turn, so the turn's end is a reset that cannot leak, while a
// counter would stick above zero for ever the first time a tool is aborted without an end.
let armed = false;

// Everything visible, in one string. A frame that would draw the same pixels is never
// requested: pi coalesces renders at 16 ms, but the cheapest frame is the one nobody asks
// for. Elapsed is in the key at second resolution, which is what makes an idle run notify
// exactly once a second instead of four times.
const keyOf = (run: RunState | undefined, now: number): string => {
	if (!run) return "";
	return [
		run.dir,
		Math.round((now - run.startedAt) / 1000),
		run.done,
		run.total,
		run.tokens,
		run.activePhase,
		...run.branches.map(
			(b) => `${b.stem}|${b.status}|${b.alive ? 1 : 0}|${b.activity}|${b.tokens}|${Math.round(b.idleMs / 1000)}`,
		),
	].join("\u0001");
};

const notify = () => {
	for (const fn of listeners) fn();
};

const refresh = () => {
	// Before the first run there is no directory to read, and a relative ".pi-out" would be
	// resolved against whatever this process happens to be sitting in.
	if (!sessionCwd) return;
	const now = Date.now();
	current = readRun(sessionCwd, now);
	const key = keyOf(current, now);
	if (key === lastKey) return;
	lastKey = key;
	notify();
};

// Two different questions that used to share one answer. `busy` is "keep the tick running",
// and `armed` belongs in it: a bash call may be the delegate skill mid-run. `running` is "is
// one of OUR runs in flight", and `armed` must NOT be in it, or one bash call anywhere in a
// turn refuses every /umb-fan for the rest of that turn.
const running = () => children.size > 0 || pending.length > 0 || current?.live === true;
const busy = () => armed || running();

// The last frame the widget will draw for this run has already been drawn. Mirrors faded()
// in bar/bar-line.ts, which is why LINGER_MS lives in state.ts where both can reach it.
const lingerOver = () => {
	if (!current || current.total === 0) return true;
	const ended = Math.max(0, ...current.branches.map((branch) => branch.updatedAt));
	return ended > 0 && Date.now() - ended > LINGER_MS;
};

const startTick = () => {
	if (tick) return;
	tick = setInterval(() => {
		refresh();
		// Keep ticking through the widget's linger window, not just to the last settle. The bar
		// holds a finished run for LINGER_MS and its clock has to keep moving until it drops it;
		// stopping at !busy() froze the final frame on screen and left it there until some
		// unrelated render happened to clear it. With nothing on screen this costs no CPU.
		if (!busy() && lingerOver()) stopTick();
	}, TICK_MS);
	// A pending repaint must never be the reason pi cannot exit.
	tick.unref?.();
};

const stopTick = () => {
	if (!tick) return;
	clearInterval(tick);
	tick = undefined;
};

// Windows has no process groups: TerminateProcess reaches the branch and leaves the tools it
// spawned behind, so the tree has to be named explicitly. taskkill's own exit code is ignored
// on purpose — 0, "already gone" (128) and "access denied" are all answered by whether the pid
// is still alive a moment later, which is the one thing that cannot be wrong.
const kill = (pid: number, force: boolean) => {
	if (!pid) return;
	try {
		if (process.platform === "win32") {
			const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
			const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
			spawn(join(root, "System32", "taskkill.exe"), args, { stdio: "ignore", windowsHide: true }).once("error", () => {});
		} else {
			// Negative pid: branches this process spawns are detached, so this reaches the
			// group and takes the branch's own tool processes with it. A branch the delegate
			// skill started from bash leads no group of its own (non-interactive bash has no
			// job control), so -pid is ESRCH there and only the pid itself can be reached.
			const signal = force ? "SIGKILL" : "SIGTERM";
			try {
				process.kill(-pid, signal);
			} catch {
				process.kill(pid, signal);
			}
		}
	} catch {
		// ESRCH. The process is already gone, which is the outcome we wanted.
	}
};

// A branch we own is gone when its close handler removed it; a branch from a bash-started run
// is only observable through its pid. One expression covers both, because a stem this process
// never spawned is never in the map.
// `ours` is false for a branch of another run that shares a stem with one of ours.
const gone = (stem: string, pid: number, ours: boolean) => !(ours && children.has(stem)) && !pidLive(pid);

const waitGone = async (stem: string, pid: number, ours: boolean, ms: number) => {
	const deadline = Date.now() + ms;
	while (!gone(stem, pid, ours)) {
		if (Date.now() >= deadline) return false;
		await delay(KILL_POLL_MS);
	}
	return true;
};

// The stream reports a provider id like "anthropic/claude-opus-5"; the panel wants "Opus 5".
// The beacon replaces this with pi's own display name at session_start — this is only what a
// row shows in the second before the branch boots, and what it keeps if it never does.
export const prettyModel = (model: string): string =>
	(model.split("/").pop() ?? model)
		.split(":")[0]
		.replace(/^claude-/, "")
		.split("-")
		.map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");

const launch = (branch: Launch) => {
	const stateDir = join(runDir, "state");
	const out = openSync(join(runDir, `${branch.stem}.md`), "a");
	const err = openSync(join(runDir, `${branch.stem}.err`), "a");
	const [command, ...prefix] = piCommand();
	const args = [
		...prefix,
		"-p",
		// Kept, not --no-session: a branch that ends on ASKING is continued in this session.
		"--session-dir",
		join(runDir, "sessions", branch.stem),
		"--no-skills",
		"--no-extensions",
		...branch.load,
		"-e",
		BEACON,
		"--tools",
		branch.worktree ? WRITE_TOOLS : READ_ONLY_TOOLS,
		"--model",
		branch.model,
		"--append-system-prompt",
		// The path rides in the system prompt rather than in the task, so it is written once per
		// branch instead of being pasted into every task line, and a branch that was given a
		// one-line task still knows where the rest of the thought is.
		[
			CONTRACT,
			branch.worktree ? "" : ASKING,
			briefPath ? `The full brief this task was cut from is at ${briefPath}; read it when the task alone leaves something open.` : "",
			branch.worktree ? writeRules(branch.worktree) : "",
		]
			.filter(Boolean)
			.join(" "),
		// A task that begins with "-" would otherwise be read as an unknown flag
		// (cli/args.js:217). After "--" every remaining word is the message.
		"--",
		branch.task,
	];
	const child = spawn(command as string, args, {
		// The same folder inside the worktree that the session sits in inside the repo.
		cwd: branch.worktree?.cwd ?? sessionCwd,
		windowsHide: true,
		// A process group off Windows, so a stop reaches the branch's own tool processes.
		detached: process.platform !== "win32",
		stdio: ["ignore", out, err],
		env: {
			...process.env,
			// The beacon's only argument, and what makes `-e beacon.ts` inert everywhere else.
			PI_BRANCH_STATE: join(stateDir, `${branch.stem}.json`),
			// Set for the CHILD: a branch that fans out again names this branch as its parent
			// and joins this run directory, which is the whole of reference 3's nesting.
			PI_BRANCH_PARENT: branch.stem,
			PI_BRANCH_RUN: runDir,
			PI_BRANCH_PHASE: branch.phase,
			// Read by nothing here — it is for a branch that fans out again and wants to hand
			// the same brief down, and for anything the user writes against the run directory.
			...(briefPath ? { PI_BRANCH_BRIEF: briefPath } : {}),
		},
	});
	children.set(branch.stem, child);

	const timer = setTimeout(() => {
		timedOut.add(branch.stem);
		void store.stop(branch.stem);
	}, branch.timeoutMs);
	timer.unref?.();
	timers.set(branch.stem, timer);

	// "error" and "close" both fire when the spawn itself fails; the second must not close the
	// worktree again and overwrite what the first one recorded.
	let settled = false;
	const settle = (code: number | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timers.get(branch.stem));
		timers.delete(branch.stem);
		children.delete(branch.stem);
		closeSync(out);
		closeSync(err);
		// What a write branch did is committed even when it was stopped or timed out: it is the
		// user's to keep or throw away, not this file's. Written before the exit, so the row
		// never settles without it.
		if (branch.worktree)
			writeFileSync(
				join(stateDir, `${branch.stem}.git`),
				JSON.stringify(closeWorktree(branch.worktree, `${branch.name}: ${branch.task.split("\n")[0]?.slice(0, 72)}`)),
			);
		// The one signal that survives a branch dying before its extensions ever bound, and the
		// only place a timeout can be told apart from a crash. 124 is what `timeout(1)` reports,
		// which is what the delegate skill's branches write, so one reader covers both.
		writeFileSync(join(stateDir, `${branch.stem}.exit`), String(timedOut.has(branch.stem) ? 124 : (code ?? 1)));
		timedOut.delete(branch.stem);
		// Phases run in order, and every branch of a phase is launched at once, so an empty
		// map means this phase is over.
		if (children.size === 0) startPhase();
		refresh();
	};

	// "error" fires instead of "close" when the binary itself cannot be spawned. Without it the
	// phase never advances and every row sits at "starting" for ever.
	child.once("error", (error) => {
		appendFileSync(join(runDir, `${branch.stem}.err`), `${error.message}\n`);
		settle(127);
	});
	child.once("close", settle);
};

const startPhase = () => {
	const phase = pending.shift();
	if (!phase) return;
	for (const branch of phase) launch(branch);
};

/** The branch reports, in launch order. Read from disk, so a branch killed halfway still
 *  contributes whatever it had written. */
export const reportOf = (run: RunState): string =>
	run.branches
		.map((branch) => {
			let text = "";
			try {
				text = readFileSync(join(run.dir, `${branch.stem}.md`), "utf8").trim();
			} catch {
				// Killed before pi wrote anything, or a spawn that never started.
			}
			const note = branch.timedOut ? ", timed out" : "";
			const { git } = branch;
			const changes = git?.error
				? `\n\nIts changes could not be committed (${git.error}); they are still in its worktree on ${git.branch}.`
				: git?.stat
					? `\n\nIts changes are on git branch ${git.branch} (${git.stat}). Nothing is merged. ` +
						`To merge: \`${mergeCommand(git)}\`. To discard: \`${discardCommand(git)}\`.`
					: "";
			return `## ${branch.label} (${branch.status}${note})\n\n${text || branch.error || "no output"}${changes}`;
		})
		.join("\n\n");

export const store = {
	/** undefined until a run exists. The panel and the bar read this and nothing else. */
	run: () => current,

	/** Returns the unsubscribe. Call it from the component's dispose(). */
	subscribe(fn: () => void) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	},

	/** Seeds the whole run, then launches its first phase. One run at a time. Returns the run
	 *  directory, which is how the caller tells a run it started from one the delegate skill
	 *  started in bash and has already read for itself. */
	start(spec: RunSpec, defaultModel: string, cwd: string, brief?: string, settings: FanSettings = envSettings()): string | undefined {
		if (running()) return undefined;
		// Checked before anything is written: a run that cannot give its write branches a
		// worktree does not start at all, rather than starting without them.
		const writes = spec.phases.some((phase) => phase.branches.some((branch) => branch.write));
		const repo = writes ? gitRepo(cwd) : undefined;
		if (writes && !repo) throw new Error(`[write] branches need a git repository, and ${cwd} is not in one`);
		sessionCwd = cwd;
		// LOCAL time, because the reader picks the newest run by NAME and the delegate skill
		// stamps its directories with `date +%Y%m%d-%H%M%S`. A UTC name here would sort a fresh
		// run behind an hours-old one on any machine east of Greenwich.
		const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
		const stamp = local.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
		runDir = join(cwd, OUT_DIR, `${stamp}-${slug(spec.name)}`);
		const stateDir = join(runDir, "state");
		mkdirSync(stateDir, { recursive: true });
		// Scratch: reports and sessions stay out of git status and out of a write run's snapshot.
		const ignore = join(cwd, OUT_DIR, ".gitignore");
		if (!existsSync(ignore)) writeFileSync(ignore, "*\n");

		// The brief goes to disk byte-for-byte, with no model between the user's words and the
		// file. Every branch is then pointed at the path rather than at a paraphrase of it: a
		// task line is one sentence cut out of a longer thought, and the rest of that thought is
		// what a branch usually turns out to need. Written before the seeds, because a branch
		// could in principle read it the moment its process starts.
		briefPath = brief?.trim() ? join(runDir, "brief.md") : undefined;
		if (briefPath) writeFileSync(briefPath, brief as string);

		const now = Date.now();
		const taken = new Set<string>();
		const phases: string[] = [];
		let index = 0;
		pending = [];
		// One snapshot of the user's tree for every write branch, taken after the .gitignore above so
		// the run directory is never part of it.
		const from = repo ? snapshot(repo) : "";
		try {
			for (const phase of spec.phases) {
				const phaseName = slug(phase.title);
				phases.push(phaseName);
				// Queued before it is filled, so a worktree that fails halfway undoes the ones before it.
				const launches: Launch[] = [];
				pending.push(launches);
				for (const branch of phase.branches) {
					// Two branches sharing a stem would share a state file, and a file with two
					// writers is the one corruption this design cannot detect. The caller here is
					// the model, so a collision is renamed rather than refused: a run that starts
					// with "explore-2" beats a run that does not start.
					const base = slug(branch.label);
					let name = base;
					for (let n = 2; taken.has(`${phaseName}-${name}`); n++) name = `${base}-${n}`;
					const stem = `${phaseName}-${name}`;
					taken.add(stem);
					const model = branch.model || defaultModel;
					index += 1;
					// Every field is populated at seed time, so no column appears for the first time
					// three seconds in and reflows the row.
					const state: BranchState = {
						phase: phaseName,
						name,
						// Set when this pi is itself a branch, which is how a nested run keeps its
						// place in the tree.
						parent: process.env.PI_BRANCH_PARENT ?? null,
						index,
						model: prettyModel(model),
						pid: null,
						status: "starting",
						activity: "Starting",
						tokens: null,
						startedAt: now,
						updatedAt: now,
						report: null,
						error: null,
					};
					writeFileSync(join(stateDir, `${stem}.json`), JSON.stringify(state));
					const worktree =
						branch.write && repo
							? openWorktree(repo, from, join(repo.common, "fan-worktrees", basename(runDir), stem), `fan/${basename(runDir)}/${stem}`)
							: undefined;
					launches.push({ stem, phase: phaseName, name, model, task: branch.task, ...settings, worktree });
				}
			}
		} catch (error) {
			// No run.json yet, so the reader never sees this directory as a run; only the
			// worktrees already made need undoing.
			for (const launch of pending.flat()) if (launch.worktree) dropWorktree(launch.worktree);
			pending = [];
			throw error;
		}

		// run.json LAST, after every seed exists: the reader treats its absence as "not a run",
		// so the row set and the M in "N/M agents" are final in the first frame ever drawn.
		writeFileSync(
			join(runDir, "run.json"),
			// pid: this pi is the only thing that will ever launch the phases seeded but not
			// yet started, so the reader needs it to tell "queued" from "abandoned".
			JSON.stringify({ name: spec.name, description: spec.description, cwd, startedAt: now, phases, pid: process.pid }),
		);
		startPhase();
		startTick();
		refresh();
		return runDir;
	},

	/** The panel's `x`. Resolves false when the branch outlived both kills, and writes nothing
	 *  either way: the row keeps saying "running" until the process is actually gone. */
	async stop(stem: string): Promise<boolean> {
		// Stems repeat across runs (`map-explore`), so this run's queue and children are only
		// the target while the run on screen is this one; a skill-started run in bash is not.
		const ours = current?.dir === runDir;
		// A branch of a later phase has no process yet. Taken out of the queue, or the next phase
		// would start it anyway, and given the exit a killed branch gets, so it reads as stopped.
		const queued = ours ? pending.flat().find((launch) => launch.stem === stem) : undefined;
		if (queued) {
			pending = pending.map((phase) => phase.filter((launch) => launch.stem !== stem)).filter((phase) => phase.length > 0);
			if (queued.worktree) dropWorktree(queued.worktree);
			writeFileSync(join(runDir, "state", `${stem}.exit`), "130");
			refresh();
			return true;
		}
		const pid = (ours ? children.get(stem)?.pid : undefined) ?? current?.branches.find((branch) => branch.stem === stem)?.pid ?? 0;
		if (!pid || gone(stem, pid, ours)) return true;
		// Soft first, so the branch's last assistant message still reaches its .md. A forced
		// kill costs the answer the run already paid for.
		kill(pid, false);
		if (await waitGone(stem, pid, ours, GRACE_MS)) return true;
		kill(pid, true);
		return waitGone(stem, pid, ours, FORCE_MS);
	},

	/** Session shutdown. Forced and unawaited: pi is leaving, and a branch left behind keeps
	 *  spending money with nothing watching it. The reports already on disk survive. */
	stopAll() {
		for (const [stem, child] of children) {
			clearTimeout(timers.get(stem));
			kill(child.pid ?? 0, true);
		}
		children.clear();
		timers.clear();
		// Queued write branches never ran, so their worktrees go. A killed one keeps its worktree:
		// its close never runs once pi is gone, and what it wrote stays on disk for the user.
		// ponytail: `git worktree list` shows such leftovers; add a cleanup command if they pile up.
		for (const launch of pending.flat()) if (launch.worktree) dropWorktree(launch.worktree);
		pending = [];
		stopTick();
	},

	/** A bash tool call may be the delegate skill starting a run this extension did not spawn.
	 *  Arming the tick is what makes such a run appear on the bar from its first frame. */
	arm(cwd: string) {
		if (!sessionCwd) sessionCwd = cwd;
		armed = true;
		startTick();
	},

	/** End of the turn. Whatever the bash call started is either live — and the tick keeps
	 *  itself going for that — or it is over. */
	disarm() {
		armed = false;
	},

	/** Session start. Without it a fresh or reloaded pi knows no cwd until the first /umb-fan or bash
	 *  call, so the bar, alt+a, /agents and Down all report "no run" while .pi-out holds one.
	 *  The tick only starts for a run still live or inside its linger window, and stops itself. */
	watch(cwd: string) {
		sessionCwd = cwd;
		refresh();
		if (current?.live || !lingerOver()) startTick();
	},

	/** The check's seam. */
	refresh(cwd?: string) {
		if (cwd) sessionCwd = cwd;
		refresh();
	},
};
