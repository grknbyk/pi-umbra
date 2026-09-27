import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import { OFFICIAL_SCROLL_TO_END_KEY, patchRegistry, TOOL_MOUSE_TUI_SLOT } from "../../utils/patch-keys.ts";

patchRegistry.ensure(TOOL_MOUSE_TUI_SLOT, () => null);
export function getToolMouseTui(): any {
	return patchRegistry.get(TOOL_MOUSE_TUI_SLOT);
}
export function setToolMouseTui(tui: any): void {
	patchRegistry.install(TOOL_MOUSE_TUI_SLOT, tui);
}

// 交互开关只取决于配置模式：原实现按 isLazyProxyTui(toolMouseTui) 分两分支，
// 两分支恒真（0.84+ 惰性 Proxy 下判定不再影响开关），折叠为单条件。
export function toolMouseInteractionActive(): boolean {
	return config.mode !== "off";
}

/** 惰性 Proxy 官方 fullscreen（TuiAltScreen）判定。 */
export function fullscreenLazyTui(tui: any): boolean {
	return isLazyProxyTui(tui) && tui.mode === "fullscreen";
}

/**
 * Gives pi back its own jump-to-latest indicator. An older toolbox hid it behind a
 * "Back to bottom" button and kept the original under OFFICIAL_SCROLL_TO_END_KEY; a /reload
 * inside that same pi would otherwise leave the indicator gone.
 */
export function restoreOfficialScrollToEnd(tui: any): void {
	if (!tui) return;
	const original = tui[OFFICIAL_SCROLL_TO_END_KEY]?.original;
	if (typeof original === "function") tui.scrollToEndIndicator = original;
	tui[OFFICIAL_SCROLL_TO_END_KEY] = undefined;
}
