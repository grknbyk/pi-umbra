/**
 * 自定义 footer 插件芯片布局：行、顺序、隐藏。
 * 纯函数，供 config 规范化、footer 渲染、配置面板共用。
 */

export const PI_USAGE_KEY = "pi-usage";
export const PI_USAGE_SOURCE = "@narumitw/pi-usage";
const LEGACY_PI_USAGE_KEYS = new Set(["localUsage", "piUsage"]);
export const SKIP_FOOTER_STATUS_KEY = "model";

export type FooterLineId = 1 | 2 | 3;

export type FooterChipLayout = {
	footerHiddenKeys: string[];
	footerLine1Keys: string[];
	footerLine2Keys: string[];
	footerLine3Keys: string[];
};

export const DEFAULT_FOOTER_CHIP_LAYOUT: FooterChipLayout = {
	footerHiddenKeys: [],
	footerLine1Keys: [PI_USAGE_KEY],
	footerLine2Keys: [],
	footerLine3Keys: [],
};

export function isSkippedFooterStatusKey(key: string): boolean {
	return key === SKIP_FOOTER_STATUS_KEY;
}

/** 未单独配置时的默认行：usage 类和本包用量在 line1，其余 line2。不会默认进 line3。 */
export function defaultFooterLine(key: string): FooterLineId {
	if (key === PI_USAGE_KEY) return 1;
	if (/usage|quota|balance/i.test(key)) return 1;
	return 2;
}

export function normalizeFooterKeyList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		let key = item.trim();
		if (LEGACY_PI_USAGE_KEYS.has(key)) key = PI_USAGE_KEY;
		if (!key || isSkippedFooterStatusKey(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

function takeUnique(keys: string[], seen: Set<string>): string[] {
	const out: string[] = [];
	for (const key of keys) {
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

/** 跨行去重（line1 → line2 → line3）；补上 pi-usage 槽位。 */
export function normalizeFooterChipLayout(source: Record<string, unknown>): FooterChipLayout {
	const hasHidden = Array.isArray(source.footerHiddenKeys);
	const hasAnyLine = [source.footerLine1Keys, source.footerLine2Keys, source.footerLine3Keys].some(
		Array.isArray,
	);
	const seen = new Set<string>();
	let footerLine1Keys = takeUnique(normalizeFooterKeyList(source.footerLine1Keys), seen);
	const footerLine2Keys = takeUnique(normalizeFooterKeyList(source.footerLine2Keys), seen);
	const footerLine3Keys = takeUnique(normalizeFooterKeyList(source.footerLine3Keys), seen);
	const footerHiddenKeys = normalizeFooterKeyList(source.footerHiddenKeys);

	if (!seen.has(PI_USAGE_KEY)) {
		footerLine1Keys = [PI_USAGE_KEY, ...footerLine1Keys];
	}
	if (!hasHidden && !hasAnyLine) {
		return { ...DEFAULT_FOOTER_CHIP_LAYOUT };
	}
	return { footerHiddenKeys, footerLine1Keys, footerLine2Keys, footerLine3Keys };
}

/** 面板描述用：pi-usage 数据来自 @narumitw/pi-usage，其它芯片用来源 setStatus key。 */
export function footerChipSource(key: string): string {
	return key === PI_USAGE_KEY ? PI_USAGE_SOURCE : key;
}

export function footerChipDescription(key: string, liveText: string): string {
	const source = footerChipSource(key);
	const live = liveText.trim();
	if (live) return `${live} · from ${source}`;
	if (key === PI_USAGE_KEY) return `From ${source}. No text right now.`;
	return `inactive · from ${source}`;
}

export function footerLineOfKey(layout: FooterChipLayout, key: string): FooterLineId | undefined {
	if (layout.footerLine1Keys.includes(key)) return 1;
	if (layout.footerLine2Keys.includes(key)) return 2;
	if (layout.footerLine3Keys.includes(key)) return 3;
	return undefined;
}

function keysOnLine(layout: FooterChipLayout, line: FooterLineId): string[] {
	if (line === 1) return layout.footerLine1Keys;
	if (line === 2) return layout.footerLine2Keys;
	return layout.footerLine3Keys;
}

function withLineKeys(
	layout: FooterChipLayout,
	line: FooterLineId,
	keys: string[],
): FooterChipLayout {
	if (line === 1) return { ...layout, footerLine1Keys: keys };
	if (line === 2) return { ...layout, footerLine2Keys: keys };
	return { ...layout, footerLine3Keys: keys };
}

/**
 * 配置里还没有的 live key 接到默认行末尾（按 key 字母序，避免每次渲染乱序）。
 * pi-usage 由 normalize 保证已在某一行。
 */
export function resolveFooterChipLayout(
	layout: FooterChipLayout,
	liveKeys: readonly string[],
): FooterChipLayout {
	const known = new Set([
		...layout.footerLine1Keys,
		...layout.footerLine2Keys,
		...layout.footerLine3Keys,
	]);
	const extras = [
		...new Set(liveKeys.filter((key) => key && !isSkippedFooterStatusKey(key) && !known.has(key))),
	].sort((a, b) => a.localeCompare(b));
	const next: FooterChipLayout = {
		footerHiddenKeys: [...layout.footerHiddenKeys],
		footerLine1Keys: [...layout.footerLine1Keys],
		footerLine2Keys: [...layout.footerLine2Keys],
		footerLine3Keys: [...layout.footerLine3Keys],
	};
	for (const key of extras) {
		if (defaultFooterLine(key) === 1) next.footerLine1Keys.push(key);
		else next.footerLine2Keys.push(key);
	}
	return next;
}

export function moveFooterKeyToLine(
	layout: FooterChipLayout,
	key: string,
	line: FooterLineId,
): FooterChipLayout {
	if (isSkippedFooterStatusKey(key)) return layout;
	const current = footerLineOfKey(layout, key);
	if (current === line) return layout;
	const stripped: FooterChipLayout = {
		footerHiddenKeys: [...layout.footerHiddenKeys],
		footerLine1Keys: layout.footerLine1Keys.filter((item) => item !== key),
		footerLine2Keys: layout.footerLine2Keys.filter((item) => item !== key),
		footerLine3Keys: layout.footerLine3Keys.filter((item) => item !== key),
	};
	return withLineKeys(stripped, line, [...keysOnLine(stripped, line), key]);
}

export function shiftFooterKeyLine(
	layout: FooterChipLayout,
	key: string,
	delta: -1 | 1,
): FooterChipLayout {
	const current = footerLineOfKey(layout, key);
	if (!current) return layout;
	const next = (current + delta) as number;
	if (next < 1 || next > 3) return layout;
	return moveFooterKeyToLine(layout, key, next as FooterLineId);
}

export function reorderFooterKey(
	layout: FooterChipLayout,
	key: string,
	delta: -1 | 1,
): FooterChipLayout {
	const line = footerLineOfKey(layout, key);
	if (!line) return layout;
	const keys = [...keysOnLine(layout, line)];
	const index = keys.indexOf(key);
	const nextIndex = index + delta;
	if (index < 0 || nextIndex < 0 || nextIndex >= keys.length) return layout;
	const swap = keys[nextIndex]!;
	keys[nextIndex] = key;
	keys[index] = swap;
	return withLineKeys(layout, line, keys);
}

export function toggleFooterKeyHidden(layout: FooterChipLayout, key: string): FooterChipLayout {
	if (isSkippedFooterStatusKey(key)) return layout;
	const hidden = new Set(layout.footerHiddenKeys);
	if (hidden.has(key)) hidden.delete(key);
	else hidden.add(key);
	return { ...layout, footerHiddenKeys: [...hidden] };
}

/** 按行顺序收集可见、且当前有文案的插件芯片文本。 */
export function visibleFooterPluginTexts(
	lineKeys: readonly string[],
	hiddenKeys: readonly string[],
	texts: ReadonlyMap<string, string>,
): string[] {
	const hidden = new Set(hiddenKeys);
	const out: string[] = [];
	for (const key of lineKeys) {
		if (hidden.has(key)) continue;
		const text = texts
			.get(key)
			?.replace(/[\r\n\t]+/g, " ")
			.trim();
		if (text) out.push(text);
	}
	return out;
}

export function formatFooterChipSummary(layout: FooterChipLayout): string {
	const hidden = layout.footerHiddenKeys.length;
	return `hidden=${hidden} · L1=${layout.footerLine1Keys.length} · L2=${layout.footerLine2Keys.length} · L3=${layout.footerLine3Keys.length}`;
}

export function orderedFooterKeys(layout: FooterChipLayout): string[] {
	return [...layout.footerLine1Keys, ...layout.footerLine2Keys, ...layout.footerLine3Keys];
}
