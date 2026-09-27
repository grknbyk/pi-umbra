// pi registers a skill in the completion list under its bare name ("huh"), but only
// "/skill:huh" actually runs one. So the built-in dropdown offers "/huh", the user presses
// enter, and pi answers "Unknown command". The matching itself is already fuzzy; the name it
// matches against is what is wrong.
//
// This wraps the built-in provider and rewrites every skill row to the form that runs. It also
// re-runs the match against the prefixed name, so typing "/skill:hu" still finds "skill:huh"
// after the built-in fuzzy pass has given up on it.
//
// It also fills the mid-sentence slash menu that two repatch entries open. pi's editor gates the
// menu on the line starting with "/", so a "/name" written inside a sentence never reached a
// provider at all; the patches lift that gate and the branch below decides what appears.
//
// Contract taken from pi-tui's CombinedAutocompleteProvider: `prefix` is the text before the
// cursor INCLUDING the leading slash, and `item.value` is the bare command name — applyCompletion
// writes `${before}/${value} ` itself, so the value carries neither slash nor trailing space.
// That holds only while the token starts the line. Mid-sentence the same method falls through to
// `${before}${value}`, which is why those rows carry their own slash.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SKILL_PREFIX = "skill:";
const MAX_ROWS = 12;

type Item = { value: string; label: string; description?: string };
type Suggestions = { items: Item[]; prefix: string } | null;

// Only complete while the command word is the whole line: "/pic" completes, "/skill:picasso go"
// does not, because there the user is writing the argument.
const commandWord = (before: string): string | null => {
    const match = /^\/(\S*)$/.exec(before);
    return match ? match[1] : null;
};

// The same token test the two repatch entries use to open the slash menu mid-sentence, so the
// menu and its contents agree on what counts: last token on the line, no space in it, and real
// text before it that ends in whitespace. "src/foo" and an indented "  /foo" both fail, which
// leaves paths and line-start commands to the built-in provider.
export const midPromptWord = (before: string): string | null => {
    const slash = before.lastIndexOf("/");
    if (slash < 1 || before.slice(slash + 1).includes(" ")) return null;
    const head = before.slice(0, slash);
    return head.trim() === "" || head === head.trimEnd() ? null : before.slice(slash + 1);
};

export default function skillFuzzy(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        ctx.ui.addAutocompleteProvider((current) => ({
            triggerCharacters: ["/"],

            async getSuggestions(lines: string[], line: number, col: number, options: never) {
                const before = (lines[line] ?? "").slice(0, col);

                // pi dispatches a command only when the whole message starts with a slash, so a
                // "/name" written mid-sentence is never run - it is text the model reads. pi's
                // system prompt already lists every skill and tells the model to open the
                // matching SKILL.md, so the bare name is what belongs here. The "skill:" form
                // below exists for the dispatcher, and the dispatcher never sees this one.
                const midWord = midPromptWord(before);
                if (midWord !== null) {
                    const query = midWord.toLowerCase();
                    const items = pi
                        .getCommands()
                        .filter((command) => command.source === "skill" && command.name.toLowerCase().includes(query))
                        .slice(0, MAX_ROWS)
                        .map((command) => ({
                            // applyCompletion writes `${before}${value}` for a token that does not
                            // start the line, so the value carries its own slash.
                            value: `/${command.name}`,
                            label: command.name,
                            description: command.description ?? "skill",
                        }));
                    return items.length === 0 ? null : { items, prefix: `/${midWord}` };
                }

                const base = (await current.getSuggestions(lines, line, col, options)) as Suggestions;
                const typed = commandWord(before);
                if (typed === null) return base;

                const commands = pi.getCommands();
                // "call-council" is both a skill and an extension command, and there the bare
                // "/call-council" is the real one. Only touch a name nothing else claims.
                const taken = new Set(
                    commands.filter((command) => command.source !== "skill").map((command) => command.name),
                );
                const skills = commands.filter(
                    (command) => command.source === "skill" && !taken.has(command.name),
                );
                const byName = new Map(skills.map((command) => [command.name, command]));

                const asSkill = (name: string, description?: string): Item => ({
                    value: `${SKILL_PREFIX}${name}`,
                    label: `${SKILL_PREFIX}${name}`,
                    description: description ?? byName.get(name)?.description ?? "skill",
                });

                const fixed = (base?.items ?? []).map((item) =>
                    byName.has(item.value) ? asSkill(item.value, item.description) : item,
                );

                const query = typed.toLowerCase().replace(/^skill:/, "");
                const shown = new Set(fixed.map((item) => item.value));
                const extra = query
                    ? skills
                          .filter((command) => command.name.toLowerCase().includes(query))
                          .map((command) => asSkill(command.name))
                          .filter((item) => !shown.has(item.value))
                          .slice(0, MAX_ROWS)
                    : [];

                const items = [...fixed, ...extra];
                if (items.length === 0) return null;
                return { items, prefix: base?.prefix ?? `/${typed}` };
            },

            applyCompletion(lines: string[], line: number, col: number, item: Item, prefix: string) {
                return current.applyCompletion(lines, line, col, item, prefix);
            },

            shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
                return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
            },
        }));
    });
}
