# pi-umbra-skill-matcher

Makes `/huh` run the skill `huh`, and opens skill completion in the middle of a sentence.

```sh
pi install npm:pi-umbra-skill-matcher
node ~/.pi/agent/npm/node_modules/pi-umbra-skill-matcher/patch.mjs
```

Restart pi after the patch.

## What changes

pi's completion menu lists a skill as `/huh`, but only `/skill:huh` runs it, so picking it
from the menu ends in "Unknown command".

- At the start of the line, skill rows complete to `/skill:name`, and `/skill:hu` still finds
  `huh`. Up to 12 skill rows are shown.
- `/huh` typed in full runs the skill. A name that another command already uses is left to
  that command.
- In the middle of a sentence, `/` opens the same menu, and the skill name is inserted as
  plain `/name` text. The skill does not run; the model reads the name.

The mid-sentence menu opens only for the last word on the line, when it has no space in it
and follows text and a space. `src/foo` or an indented `/foo` stays a path.

## The patch

The command table and the rule that keeps the slash menu at the start of the line are
inside pi's bundle, out of reach of the extension API. `patch.mjs` makes four small edits
there.

A pi update replaces the bundle and removes the patch without any error, so run the script
again after every update.

| Command | Effect |
|---|---|
| `node .../patch.mjs` | apply the patch; a part already applied is skipped |
| `node .../patch.mjs --check` | change nothing, exit 1 if a part is missing |

Set `PI_UMBRA_PI` to the `pi-coding-agent` directory if pi is not found. If pi's code has
changed and a patch no longer fits, the script says so and writes nothing for it.
Reinstalling pi removes every patch.

MIT.
