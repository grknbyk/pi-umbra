// umbra-toolbox: every tool call drawn as a card, with rich edit/write diffs, grouping of
// consecutive calls and click-to-expand in fullscreen. /umb-toolbox switches it (on, compact, off)
// and opens its settings; they persist in ~/.pi/agent/umbra-toolbox.json.
//
// Adapted from the render layer of pi-cc-extensions 0.9.6 by minuque (MIT, see
// LICENSE-pi-cc-extensions). Only that layer is here: its footer, header, working line and
// aliases are covered by umbra's own extensions already.
export { default } from "./renderer/index.ts";
