# pi-umbra

Seven dark themes for [pi](https://pi.dev), and extensions for the parts of its terminal a
theme cannot reach: tool calls drawn as cards, a status footer, an input bar that shows the
session name, a working line that names the running tool, and a handful of commands pi does
not ship.

[![A one-minute tour: tool cards and diffs, the working line, a question from the model, parallel branches, the card settings and the seven themes](https://raw.githubusercontent.com/grknbyk/pi-umbra/main/assets/demo.webp)](https://github.com/grknbyk/pi-umbra/blob/main/assets/demo.mp4)

A one-minute tour; click it for the [MP4](https://github.com/grknbyk/pi-umbra/blob/main/assets/demo.mp4).

## Install

```sh
pi install npm:pi-umbra
```

That installs all eight packages. Two of them patch pi's bundle, because the extension API
has no hook for what they change. Run the two scripts once now and again after every pi
update, then restart pi:

```sh
node ~/.pi/agent/npm/node_modules/pi-umbra/node_modules/pi-umbra-shimmer/patch.mjs
node ~/.pi/agent/npm/node_modules/pi-umbra/node_modules/pi-umbra-subagents/patch.mjs
```

Coming from 0.4 or older: pi-umbra-skill-matcher is gone, because pi completes and runs
`/skill:name` itself since 1.0. Its bundle patch stays in pi until pi is reinstalled, and until
then a `/` typed mid-sentence opens file completion. Reinstall pi to drop it:
`npm install -g @earendil-works/pi-coding-agent`.

`/umb-doctor` tells you when a patch has gone missing.

Each package also installs on its own, for example `pi install npm:pi-umbra-theme`. The
patch script then sits at `~/.pi/agent/npm/node_modules/<package>/patch.mjs`.

## Packages

| Package | What it adds | Commands |
|---|---|---|
| [pi-umbra-theme](pi-umbra-theme) | seven themes, terminal background, footer, gutter beside model text, tool cards, image viewer, working line | `/umb-bg`, `/umb-toolbox` |
| [pi-umbra-inputbar](pi-umbra-inputbar) | `❯` prompt, session name on the input border, border colour | `/umb-color` |
| [pi-umbra-ask](pi-umbra-ask) | `ask_user_question`, a tool the model calls to ask you something and wait | |
| [pi-umbra-shimmer](pi-umbra-shimmer) | a wave of colour through the working line (bundle patch) | `/umb-shimmer` |
| [pi-umbra-copy-chat](pi-umbra-copy-chat) | the whole session on the clipboard as Markdown | `/umb-copy-chat` |
| [pi-umbra-preview](pi-umbra-preview) | render a document with pandoc and open it in the browser | `/umb-preview` |
| [pi-umbra-help](pi-umbra-help) | what is installed and what is broken | `/umb-help`, `/umb-doctor` |
| [pi-umbra-subagents](pi-umbra-subagents) | parallel pi branches, read-only or in their own git worktree, with a live agent tree, and a prompt loop (bundle patch) | `/umb-fan`, `/umb-agents`, `/umb-loop` |
Each package README covers its commands, keys and settings in full.

## Themes

![The seven umbra themes](https://raw.githubusercontent.com/grknbyk/pi-umbra/main/assets/themes.webp)

`umbra-ember-ash`, `umbra-astral-veil`, `umbra-deep-current`, `umbra-onyx-slate`,
`umbra-tidal-drift`, `umbra-venom-dusk` and `umbra-violet-forge`. Pick one in `/settings`,
or set `"theme"` in `~/.pi/agent/settings.json`.

## Where settings live

| File | Written by | Holds |
|---|---|---|
| `~/.pi/agent/settings.json`, key `piUmbraTheme` | you | terminal background, gutter, working line |
| `~/.pi/agent/umbra-toolbox.json` | `/umb-toolbox` | tool card mode and diff options |
| `~/.pi/agent/input-color` | `/umb-color` | input border colour |
| `~/.pi/agent/shimmer` | `/umb-shimmer` | shimmer mode and speed |

A full `piUmbraTheme` block with every key:

```json
"piUmbraTheme": {
  "background": "auto",
  "messages": { "assistantPrefix": true },
  "working": { "tokens": true, "elapsed": true, "tools": {} }
}
```

## License

MIT.
