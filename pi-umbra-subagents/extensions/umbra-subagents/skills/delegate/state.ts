// What a delegate run looks like on disk, and the one function that folds a run directory
// into the shape the agent panel renders. It ships inside the skill folder rather than
// beside the panel because run.sh's seed heredoc and beacon.ts are its only two writers,
// and a schema living next to its writers cannot drift away from them.
//
// Nothing here registers anything with pi, so importing it costs zero prompt tokens.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Scratch root, relative to the SESSION cwd. Already gitignored by the old delegate. */
export const OUT_DIR = ".pi-out";

/** How long the widget keeps showing a finished run before dropping back to `○ main`.
 *  It lives here rather than in the renderer because the producer has to keep its clock
 *  ticking for exactly this long after the last branch settles - two copies of this number
 *  in two files is precisely the drift that froze the last frame on screen. */
export const LINGER_MS = 30_000;

// ---------- ON DISK ----------

/** `<run>/run.json` — written once by the skill, AFTER every seed exists. Its absence is
 *  what makes a half-built run directory invisible, so the panel's `M` in "N/M agents" is
 *  final from the first frame it ever draws. */
export type Run = {
    name: string;
    description: string;
    /** Absolute session cwd, captured before the skill `cd`s into a subtree. */
    cwd: string;
    startedAt: number;
    /** Sidebar order. A later wave appends. */
    phases: string[];
    /** The process that owns this run and is the only thing that will ever launch its
     *  remaining phases. Without it a seed for a phase that never got to run is
     *  indistinguishable from a branch that is about to boot, so one Ctrl-C left a directory
     *  reporting `live: true` for ever. Absent in a run written before this field existed,
     *  which reads as "cannot tell" and keeps the old behaviour. */
    pid?: number | null;
};

/** `<run>/state/<phase>-<name>.json` — seeded by the skill with every field populated, then
 *  written only by beacon.ts, always whole-object through tmp + rename.
 *
 *  The stem is `${phase}-${name}` and never carries a colon: a colon is illegal in an NTFS
 *  filename. The `map:core-render` the panel shows is a render-time join, never a stored
 *  string. Both halves match ^[a-z0-9][a-z0-9._-]*$, which is why the seed heredoc contains
 *  no free text and cannot emit invalid JSON. */
export type BranchState = {
    phase: string;
    name: string;
    /** Stem of the branch that spawned this one, or null at the top level. Branches run with
     *  `--tools read,grep,find,ls` and so cannot nest today; the field is here because the
     *  panel's nesting marker needs it the moment one of them is given `bash`. */
    parent: string | null;
    /** 1-based launch order. The panel's ONLY sort key — never readdir order, never mtime. */
    index: number;
    /** Seed: the requested "provider/id". Beacon: pi's own display name, e.g. "Opus 5". */
    model: string;
    /** null in the seed, the real OS pid at session_start. */
    pid: number | null;
    status: "starting" | "running" | "done" | "error";
    /** The whole point of the panel: a short present-tense sentence, rewritten at every tool
     *  boundary. "Grepping localStorage in office-persist.ts", not "running". Never empty —
     *  an empty string reflows the row. */
    activity: string;
    /** null until the provider reports usage; the panel renders an en dash rather than a
     *  fake 0. Once non-null it is never written back to null or to 0. */
    tokens: number | null;
    /** The shell's launch instant, stamped before pi boots. */
    startedAt: number;
    /** Stamped on every beacon write. The only input to "idle Ns". */
    updatedAt: number;
    report: "OK" | "PARTIAL" | "NEED_STRONGER" | "ASKING" | null;
    error: string | null;
};

// `<run>/state/<stem>.exit` holds `$?` from the launching subshell. Its presence means the
// process is gone whatever the JSON still says, which is the only thing that catches a
// branch killed before its extensions ever bound. "124" means `timeout 300` fired.
//
// Siblings, contract unchanged from the old delegate:
//   <run>/<stem>.md   branch stdout, the report the parent session reads
//   <run>/<stem>.err  branch stderr

// ---------- WHAT THE PANEL CONSUMES ----------

export type BranchView = BranchState & {
    /** `${phase}-${name}`, the row key and the file stem. */
    stem: string;
    /** `${phase}:${name}`, what the panel prints. */
    label: string;
    /** 0 at the top level, 1 under a parent, and so on. Drives the nesting marker. */
    depth: number;
    elapsedMs: number;
    idleMs: number;
    exitCode: number | null;
    timedOut: boolean;
    alive: boolean;
    /** Finished for any reason. The N in "N/M agents". */
    settled: boolean;
    /** A `[write]` branch's git branch, from `state/<stem>.git`, written when its worktree
     *  closes. Absent on a read-only branch and on one still running. */
    git?: GitResult;
};

/** What a write branch left behind: its branch, the base it started from, and "+N −M · K files"
 *  ("" when it changed nothing), or why its work could not be committed. */
export type GitResult = { root: string; branch: string; base: string; stat: string; error?: string };

export type RunState = {
    dir: string;
    name: string;
    description: string;
    startedAt: number;
    phases: string[];
    /** First phase still holding an unsettled branch; the last phase once everything is done. */
    activePhase: number;
    /** Pre-ordered: a parent immediately above its children, siblings by launch order. Render
     *  top to bottom; the component never walks a tree. */
    branches: BranchView[];
    done: number;
    total: number;
    tokens: number;
    live: boolean;
};

// ---------- READER ----------

const stemOf = (state: BranchState) => `${state.phase}-${state.name}`;

// EPERM means the pid exists and belongs to someone else, which is still "not dead". Only
// ESRCH proves the branch is gone — and on Windows that is the sole signal, because stopping
// a branch is TerminateProcess and it never gets to write "done" into its own file.
export const pidLive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // SAFETY: process.kill only ever throws a system error; reading .code off anything
        // else yields undefined, which falls through to "dead".
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

type Exit = { code: number | null; at: number };

const readExit = (path: string): Exit | undefined => {
    try {
        // The mtime is the instant the process actually died, which beats updatedAt for
        // elapsed time on a branch killed before the beacon ever wrote.
        const at = statSync(path).mtimeMs;
        const code = Number(readFileSync(path, "utf8").trim());
        return { code: Number.isFinite(code) ? code : null, at };
    } catch {
        return undefined;
    }
};

// Newest by name, not by mtime: the YYYYMMDD-HHMMSS prefix is monotonic, while a run
// directory's mtime churns as its branches write and can flip the panel to another run
// mid-flight. A directory with no run.json is still being built, so the previous complete
// run stays on screen instead of the panel blanking for a frame.
const latestRun = (cwd: string): { dir: string; run: Run } | undefined => {
    let names: string[];
    try {
        names = readdirSync(join(cwd, OUT_DIR), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch {
        return undefined;
    }
    for (let i = names.length - 1; i >= 0; i--) {
        // SAFETY: i is bounded by names.length, so the index is always populated.
        const dir = join(cwd, OUT_DIR, names[i] as string);
        try {
            // SAFETY: run.json is written by run.sh through json(), which escapes the only
            // two free-text fields, so it either parses to Run or throws into the catch.
            const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as Run;
            if (Array.isArray(run.phases)) return { dir, run };
        } catch {
            // Half-built, hand-deleted, or from an older delegate. Try the one before it.
        }
    }
    return undefined;
};

const readGit = (path: string): GitResult | undefined => {
    try {
        // SAFETY: written only by fan/store.ts through JSON.stringify of a GitResult.
        return JSON.parse(readFileSync(path, "utf8")) as GitResult;
    } catch {
        return undefined;
    }
};

const readStates = (stateDir: string): BranchState[] => {
    let files: string[];
    try {
        files = readdirSync(stateDir);
    } catch {
        return [];
    }
    const states: BranchState[] = [];
    for (const file of files) {
        // ".json.tmp" deliberately fails this test: it is the unfinished half of a
        // tmp + rename write and must never be parsed.
        if (!file.endsWith(".json")) continue;
        try {
            // SAFETY: same contract as run.json — the seed heredoc holds constrained
            // identifiers only, so this parses to BranchState or throws.
            states.push(JSON.parse(readFileSync(join(stateDir, file), "utf8")) as BranchState);
        } catch {
            // Not a seed we wrote. Dropping the row beats throwing inside a render loop.
        }
    }
    return states;
};

// Depth-first by launch order, so a parent sits immediately above its children and the
// component can render the list top to bottom.
const order = (states: BranchState[]): { state: BranchState; depth: number }[] => {
    const sorted = [...states].sort((a, b) => a.index - b.index);
    const stems = new Set(sorted.map(stemOf));
    const byParent = new Map<string, BranchState[]>();
    for (const state of sorted) {
        // A parent naming a branch that is not in this run is treated as a root, so a stale
        // PI_BRANCH_PARENT hides no rows.
        const key = state.parent !== null && stems.has(state.parent) ? state.parent : "";
        const siblings = byParent.get(key);
        if (siblings) siblings.push(state);
        else byParent.set(key, [state]);
    }

    const out: { state: BranchState; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (key: string, depth: number) => {
        if (depth > 8) return;
        for (const state of byParent.get(key) ?? []) {
            const stem = stemOf(state);
            if (seen.has(stem)) continue;
            seen.add(stem);
            out.push({ state, depth });
            walk(stem, depth + 1);
        }
    };
    walk("", 0);
    // Anything the walk could not reach — a hand-edited parent cycle, a stem nested deeper
    // than the cap — still gets a row. A branch the panel cannot see is worse than one drawn
    // at the top level.
    for (const state of sorted) {
        const stem = stemOf(state);
        if (seen.has(stem)) continue;
        seen.add(stem);
        out.push({ state, depth: 0 });
    }
    return out;
};

/** The whole panel-facing surface. One readdir, one run.json and one small JSON per branch:
 *  cheap enough for a 1 s tick, which the panel needs anyway because elapsed and "idle Ns"
 *  move with the clock rather than with the files. */
export function readRun(cwd: string, now = Date.now()): RunState | undefined {
    const found = latestRun(cwd);
    if (!found) return undefined;

    // Written by whoever owns the run. `undefined` is a run.json from before the field
    // existed: unknowable, so treat it as still owned and keep the previous behaviour.
    const orphaned = typeof found.run.pid === "number" && !pidLive(found.run.pid);

    const stateDir = join(found.dir, "state");
    const branches: BranchView[] = order(readStates(stateDir)).map(({ state, depth }) => {
        const stem = stemOf(state);
        const exit = readExit(join(stateDir, `${stem}.exit`));
        // Written just before the exit, so there is nothing to read until the exit is there.
        const git = exit === undefined ? undefined : readGit(join(stateDir, `${stem}.git`));
        // A seeded branch whose pid is still null has not booted yet: it is pending, not
        // finished, or every row would count as done the instant the run started. Pending is
        // only honest while the owner is still around to launch it — an abandoned run's later
        // phases would otherwise read as alive for ever and pin the whole run to `live`.
        const alive = exit === undefined && (state.pid === null ? !orphaned : pidLive(state.pid));
        const settled = !alive || state.status === "done" || state.status === "error";
        const endedAt = exit?.at ?? (settled ? state.updatedAt : now);
        return {
            ...state,
            stem,
            label: `${state.phase}:${state.name}`,
            depth,
            elapsedMs: Math.max(0, endedAt - state.startedAt),
            idleMs: Math.max(0, now - state.updatedAt),
            exitCode: exit?.code ?? null,
            timedOut: exit?.code === 124,
            alive,
            settled,
            ...(git ? { git } : {}),
        };
    });

    const phases = found.run.phases;
    const running = phases.findIndex((phase) => branches.some((b) => b.phase === phase && !b.settled));
    return {
        dir: found.dir,
        name: found.run.name,
        description: found.run.description,
        startedAt: found.run.startedAt,
        phases,
        activePhase: running >= 0 ? running : Math.max(0, phases.length - 1),
        branches,
        done: branches.filter((b) => b.settled).length,
        total: branches.length,
        tokens: branches.reduce((sum, b) => sum + (b.tokens ?? 0), 0),
        live: branches.some((b) => b.alive),
    };
}
