# pi-umbra-shimmer

A wave of colour through pi's working line, over the spinner and the text. The band blends
from the theme's accent to its bright accent and back as it moves.

![The working line with the shimmer](https://raw.githubusercontent.com/grknbyk/pi-umbra/main/assets/working.webp)

```sh
pi install npm:pi-umbra-shimmer
node ~/.pi/agent/npm/node_modules/pi-umbra-shimmer/patch.mjs
```

Restart pi after the patch.

## Command

| Command | Effect |
|---|---|
| `/umb-shimmer` | show the current setting |
| `/umb-shimmer classic` | a band sweeps left to right, 2 s per pass (default) |
| `/umb-shimmer kitt` | a narrower band runs back and forth, 1.1 s each way |
| `/umb-shimmer off` | no wave; the line is drawn in the muted colour |
| `/umb-shimmer classic 2` | any mode with a speed from 0.25 to 8, where 2 is twice as fast |

The setting is kept in `~/.pi/agent/shimmer`. With pi-umbra-theme installed, the spinner
frames keep pace with the wave.

## The patch

pi draws the working line with a colour it picks itself and gives extensions no way to
change it. `patch.mjs` makes three small edits to pi's installed bundle so the extension can
paint it. The edits do nothing unless the extension is loaded.

A pi update replaces the bundle and removes the patch without any error, so run the script
again after every update.

| Command | Effect |
|---|---|
| `node .../patch.mjs` | apply the patch; a part already applied is skipped |
| `node .../patch.mjs --check` | change nothing, exit 1 if a part is missing |

The script finds pi next to where the package is installed, then under bun's global
directory. Set `PI_UMBRA_PI` to the `pi-coding-agent` directory if yours is elsewhere. If
pi's code has changed and a patch no longer fits, the script says so and writes nothing for
it. Reinstalling pi removes every patch.

MIT.
