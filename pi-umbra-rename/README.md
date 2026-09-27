# pi-umbra-rename

`/umb-rename` sets the session name and the terminal title in one step. pi keeps them apart,
so after `/name` the window tab still shows the old title.

```sh
pi install npm:pi-umbra-rename
```

| Command | Effect |
|---|---|
| `/umb-rename api refactor` | rename straight away |
| `/umb-rename` | ask for the name first; an empty answer changes nothing |

The session name shows in `/resume` and, with pi-umbra-inputbar, on the input border. The
terminal title becomes `π - api refactor - <folder>`.

MIT.
