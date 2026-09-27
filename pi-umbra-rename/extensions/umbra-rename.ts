import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// /umb-rename sets both names at once: the session display name (session selector,
// /resume) and the terminal window/tab title, which are separate APIs in pi.
export default function (pi: ExtensionAPI) {
	pi.registerCommand("umb-rename", {
		description: "Rename this session and the terminal title: /umb-rename <name>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// setSessionName lives on the API object; setTitle lives on the command context's UI.
			let newName = args.trim() || (await ctx.ui.input("Rename session", pi.getSessionName() ?? ""))?.trim();
			if (!newName) return;

			// The prefix belongs to the terminal title only. pi builds that title itself as
			// `π - <session name> - <cwd>`, so putting π in the session name too spelled it twice
			// in the tab and once more on the input bar, which shows the session name alone.
			pi.setSessionName(newName);
			ctx.ui.setTitle(`π - ${newName} - ${basename(ctx.sessionManager.getCwd())}`);
			ctx.ui.notify(`renamed: ${newName}`);
		},
	});
}
