# pi-umbra-inputbar

The input box with a `❯` prompt, the session name on its top border and a border colour you
pick. With several pi windows open, the name and the colour tell you which one you are in.

![The input bar with a session name and a coloured border](https://raw.githubusercontent.com/grknbyk/pi-umbra/main/assets/inputbar.webp)

```sh
pi install npm:pi-umbra-inputbar
```

## Border colour

| Command | Effect |
|---|---|
| `/umb-color` | show the current colour and the choices |
| `/umb-color <name>` | `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple` or `pink` |
| `/umb-color #rrggbb` | any colour |
| `/umb-color off` | back to the theme's border colour |

The colour is kept in `~/.pi/agent/input-color` and applies to every session.

| Name | Colour |
|---|---|
| red | `#ff6467` |
| orange | `#ff8904` |
| yellow | `#ffb900` |
| green | `#00d492` |
| cyan | `#00d3f2` |
| blue | `#51a2ff` |
| purple | `#a78bfa` |
| pink | `#fb64b6` |

## Session name

The name set with `/name` or `/umb-rename` sits at the right end of the top border and shows
on the next repaint. When the border has no room for it, it is left out.

## For extension authors

pi keeps one editor per session, so this package owns it. When Down is pressed with the
cursor already at the end of the text and no completion open, it emits `editor:down-at-end` on
`pi.events`. Listen for that instead of installing a second editor. A held key does not emit
it, so holding Down to the end of a long draft does not trigger anything.

MIT.
