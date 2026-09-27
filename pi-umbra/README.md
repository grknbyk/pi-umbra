# pi-umbra

Every pi-umbra package in one install: seven dark themes, tool calls drawn as cards, a
status footer, an input bar with the session name, a working line that names the running
tool, parallel read-only branches with a live panel, and the `/umb-*` commands.

![A one-minute tour: tool cards and diffs, the working line, a question from the model, parallel branches, the card settings and the seven themes](https://raw.githubusercontent.com/grknbyk/pi-umbra/main/assets/demo.webp)

```sh
pi install npm:pi-umbra
```

The ten packages ship bundled inside this one tarball. Three of them patch pi's bundle, so
run the three scripts once now and again after every pi update, then restart pi:

```sh
node ~/.pi/agent/npm/node_modules/pi-umbra/node_modules/pi-umbra-shimmer/patch.mjs
node ~/.pi/agent/npm/node_modules/pi-umbra/node_modules/pi-umbra-skill-matcher/patch.mjs
node ~/.pi/agent/npm/node_modules/pi-umbra/node_modules/pi-umbra-subagents/patch.mjs
```

| Package | What it adds |
|---|---|
| [pi-umbra-theme](https://www.npmjs.com/package/pi-umbra-theme) | seven themes, terminal background, footer, gutter, tool cards, image viewer, working line |
| [pi-umbra-inputbar](https://www.npmjs.com/package/pi-umbra-inputbar) | `❯` prompt, session name on the input border, `/umb-color` |
| [pi-umbra-ask](https://www.npmjs.com/package/pi-umbra-ask) | a tool the model calls to ask you a question and wait |
| [pi-umbra-shimmer](https://www.npmjs.com/package/pi-umbra-shimmer) | a wave of colour through the working line, `/umb-shimmer` |
| [pi-umbra-skill-matcher](https://www.npmjs.com/package/pi-umbra-skill-matcher) | `/name` runs `skill:name`, completion mid-sentence |
| [pi-umbra-rename](https://www.npmjs.com/package/pi-umbra-rename) | `/umb-rename`, session name and terminal title |
| [pi-umbra-copy-chat](https://www.npmjs.com/package/pi-umbra-copy-chat) | `/umb-copy-chat`, the session on the clipboard |
| [pi-umbra-preview](https://www.npmjs.com/package/pi-umbra-preview) | `/umb-preview`, render a document in the browser |
| [pi-umbra-help](https://www.npmjs.com/package/pi-umbra-help) | `/umb-help` and `/umb-doctor` |
| [pi-umbra-subagents](https://www.npmjs.com/package/pi-umbra-subagents) | parallel read-only pi branches with a live panel, `/umb-fan`, `/umb-loop` |

Full documentation: [github.com/grknbyk/pi-umbra](https://github.com/grknbyk/pi-umbra).

MIT.
