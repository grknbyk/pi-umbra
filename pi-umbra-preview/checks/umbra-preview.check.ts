// The two things in preview.ts that can be wrong without anything failing: the path a user typed
// is resolved to the wrong file, and pandoc is reported missing on a machine that has it.
//
//   bun run umbra-preview.check.ts
import assert from "node:assert";
import { join, resolve } from "node:path";
import { findPandoc, resolvePath } from "../extensions/umbra-preview.ts";

const cwd = process.platform === "win32" ? "C:\\work" : "/work";

// pi writes `@path` when a file is picked from its own completion, and a shell leaves quotes on a
// path with a space in it. Both reach the handler as typed.
assert.equal(resolvePath("notes.md", cwd), resolve(cwd, "notes.md"), "a relative path joins cwd");
assert.equal(resolvePath("@notes.md", cwd), resolve(cwd, "notes.md"), "the @ prefix is pi's, not the filename's");
assert.equal(resolvePath('  "a b.md"  ', cwd), resolve(cwd, "a b.md"), "quotes and padding come off");
assert.equal(resolvePath(join(cwd, "x.md"), cwd), join(cwd, "x.md"), "an absolute path is left alone");

// PATH wins, and nothing else is looked at when it answers.
const onPath = await findPandoc(
    () => {
        throw new Error("the fallback list must not be read when PATH answers");
    },
    async () => true,
);
assert.equal(onPath, "pandoc", "a pandoc on PATH is used as a bare command");

// The reason the fallback list exists: pandoc's own installer puts it somewhere the running shell
// does not know about yet, so the first preview after installing must still work.
const installed = "C:\\Users\\x\\AppData\\Local\\Pandoc\\pandoc.exe";
const found = await findPandoc((path) => path.endsWith("pandoc.exe") || path === "/usr/bin/pandoc", async () => false);
assert.ok(found !== undefined, "a pandoc off PATH must still be found");
assert.ok(found !== "pandoc", "an off-PATH pandoc is used by its full path, not by name");

// Nowhere on this machine: the caller has to be told, not handed a command that will not start.
assert.equal(await findPandoc(() => false, async () => false), undefined, "no pandoc means no pandoc");

void installed;
console.log("umbra-preview: all checks passed");
