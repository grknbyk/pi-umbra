# pi-umbra-help

`/umb-help` shows what pi-umbra has installed, and `/umb-doctor` shows what is broken.

```sh
pi install npm:pi-umbra-help
```

## /umb-help

- Every `/umb-*` command loaded in this session, with its description.
- The active theme.
- Your `piUmbraTheme` block from `~/.pi/agent/settings.json`, as written.

It reads the live session, so it lists only the umbra packages you have.

## /umb-doctor

Reports the faults that give no error of their own:

| Check | Why |
|---|---|
| a bundle patch is missing | after a pi update, the shimmer and /umb-loop stop without a word |
| two skills share a name | `~/.pi/agent/skills`, `<project>/.pi/skills` and `~/.agents/skills` are read in that order and the first copy wins, even when a later one is newer |
| the terminal kept its own background | the theme is not shown in full; it says where to set the colour in your terminal |
| no truecolor announced | `COLORTERM` is not set and the terminal is not a known truecolor one, so colours may band |
| the theme is not an umbra one | only a note; everything still works |

A patch is reported only when the package that needs it is installed. The fix it suggests is
to run that package's `patch.mjs` and restart pi. With nothing to report, it says
`umb-doctor: nothing to report.`

The patch check looks in the pi that is running. Set `PI_UMBRA_PI` to point it at another
one.

MIT.
