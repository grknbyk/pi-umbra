import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitResult } from "../skills/delegate/state.ts";

// A `[write]` branch's own copy of the repo. It starts from what the user sees, uncommitted and
// untracked work included, taken once per run as one base commit, so the branch's own changes
// are exactly `base..branch` and can be applied onto the user's working tree without dragging
// the user's work along a second time. Nothing here merges: the main session asks the user
// first, every time.
//
// Commits are plumbing (write-tree, commit-tree, update-ref): no hook runs and nothing is
// signed, so nothing can stop on a prompt while pi's thread waits. Worktrees live under the git
// directory, where test runners, linters, watchers and `git clean` never look.
// ponytail: every call is synchronous on pi's thread, about 0.1 s per branch on a few hundred
// files. Move to async execFile if users run [write] in repos with tens of thousands of files.

export type Repo = { root: string; prefix: string; common: string };
export type Worktree = { root: string; path: string; cwd: string; branch: string; base: string };

// git's own reason, not node's "Command failed: <argv>" line above it.
const git = (cwd: string, args: string[], env?: Record<string, string>) => {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			...(env ? { env: { ...process.env, ...env } } : {}),
		}).trim();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw stderr ? new Error(stderr) : error;
	}
};

const tryGit = (cwd: string, args: string[]) => {
	try {
		return git(cwd, args);
	} catch {
		return "";
	}
};

/** The repo the session sits in, or undefined outside one. `prefix` is the session's folder
 *  inside it, as git spells it, so a symlinked or 8.3 cwd still lands in the right place. */
export const gitRepo = (cwd: string): Repo | undefined => {
	const [common, root, prefix = ""] = tryGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel", "--show-prefix"]).split("\n");
	return common && root ? { root, prefix, common } : undefined;
};

// The user's identity when git has one. Without it commit-tree refuses, and these commits never
// reach the user's history anyway: a merge applies the diff, it does not merge the commit.
const identity = (cwd: string) =>
	tryGit(cwd, ["var", "GIT_COMMITTER_IDENT"])
		? undefined
		: { GIT_AUTHOR_NAME: "pi fan", GIT_AUTHOR_EMAIL: "fan@localhost", GIT_COMMITTER_NAME: "pi fan", GIT_COMMITTER_EMAIL: "fan@localhost" };

/** The user's tree as they see it, as one commit on top of HEAD, or HEAD itself when nothing is
 *  uncommitted. Built in a scratch index, so the user's own index, diff settings and hooks never
 *  come into it, symlinks stay symlinks and a nested repo stays a gitlink. */
export const snapshot = (repo: Repo): string => {
	const head = tryGit(repo.root, ["rev-parse", "--verify", "-q", "HEAD"]);
	const index = join(repo.common, `fan-index-${process.pid}`);
	const own = git(repo.root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
	// Seeded from the real index, so `add -A` only rehashes what changed.
	if (existsSync(own)) copyFileSync(own, index);
	try {
		const env = { GIT_INDEX_FILE: index };
		try {
			git(repo.root, ["add", "-A", "--ignore-errors"], env);
		} catch (error) {
			// A nested repo with no commit yet, or a file this user cannot read, has nothing
			// git can record, so the branch starts without it. Anything else is a real failure.
			if (!/unable to index file/.test((error as Error).message)) throw error;
		}
		const tree = git(repo.root, ["write-tree"], env);
		if (head && tree === git(repo.root, ["rev-parse", `${head}^{tree}`])) return head;
		return git(repo.root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "fan: the uncommitted work the branches started from"], identity(repo.root));
	} finally {
		rmSync(index, { force: true });
	}
};

/** A new branch at `base` in its own worktree. The session's folder is made when the checkout
 *  lacks it: a folder holding only ignored files, or nothing yet, is not in any commit. */
export const openWorktree = (repo: Repo, base: string, path: string, branch: string): Worktree => {
	const worktree = { root: repo.root, path, cwd: join(path, repo.prefix), branch, base };
	// A hooks path that does not exist: post-checkout would run here, on pi's thread. Outside the
	// try: when add fails, the path or branch may be another run's, and is not this one's to drop.
	git(repo.root, ["-c", `core.hooksPath=${join(repo.common, "fan-no-hooks")}`, "worktree", "add", "-q", "-b", branch, path, base]);
	try {
		mkdirSync(worktree.cwd, { recursive: true });
		return worktree;
	} catch (error) {
		dropWorktree(worktree);
		throw error;
	}
};

const removeWorktree = ({ root, path }: Worktree) => {
	try {
		git(root, ["worktree", "remove", "--force", path]);
		// The run's folder under fan-worktrees, once its last branch is gone.
		rmdirSync(dirname(path));
	} catch {
		// Already gone, a sibling still there, or a file the branch left locked: the work is on
		// the branch either way, and `git worktree prune` clears the rest.
	}
};

/** The worktree and its branch, gone. For a branch that never ran or changed nothing. */
export const dropWorktree = (worktree: Worktree) => {
	removeWorktree(worktree);
	tryGit(worktree.root, ["branch", "-D", worktree.branch]);
};

/** "+12 −3 · 2 files" from git's "2 files changed, 12 insertions(+), 3 deletions(-)". */
export const compactStat = (shortstat: string) => {
	const count = (pattern: RegExp) => Number(pattern.exec(shortstat)?.[1] ?? 0);
	const files = count(/(\d+) files? changed/);
	return files ? `+${count(/(\d+) insertions?/)} −${count(/(\d+) deletions?/)} · ${files} ${files === 1 ? "file" : "files"}` : "";
};

/** Commit what the branch left, drop the worktree, keep the branch. A branch that changed
 *  nothing is dropped whole, so only branches worth a question are left. */
export const closeWorktree = (worktree: Worktree, message: string): GitResult => {
	const { root, path, branch, base } = worktree;
	let stat: string;
	try {
		git(path, ["add", "-A"]);
		const tree = git(path, ["write-tree"]);
		// On top of the branch's HEAD, not base: a branch that committed on its own keeps that.
		if (tree !== git(path, ["rev-parse", "HEAD^{tree}"])) {
			const commit = git(path, ["commit-tree", tree, "-p", "HEAD", "-m", message], identity(path));
			git(path, ["update-ref", `refs/heads/${branch}`, commit]);
		}
		stat = compactStat(git(root, ["diff", "--shortstat", base, branch]));
	} catch (error) {
		// The worktree stays, so nothing the branch wrote is lost.
		return { root, branch, base, stat: "", error: (error as Error).message.split("\n")[0] };
	}
	if (stat) removeWorktree(worktree);
	else dropWorktree(worktree);
	return { root, branch, base, stat };
};

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The merge the main session offers. Run at the repo root, so no path outside the session's
 *  folder is skipped; a plumbing diff, so no diff setting changes the patch; binary-safe; a
 *  plain apply onto the working tree, so the user's own uncommitted edits stay where they are
 *  and nothing is staged. It applies whole or not at all, and the branch goes only after. */
export const mergeCommand = ({ root, base, branch }: GitResult) =>
	`git -C ${quote(root)} diff-tree -p --binary ${base} ${branch} | git -C ${quote(root)} apply && git -C ${quote(root)} branch -D ${branch}`;

export const discardCommand = ({ root, branch }: GitResult) => `git -C ${quote(root)} branch -D ${branch}`;
