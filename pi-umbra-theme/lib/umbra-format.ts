// Numbers the status line and the footer both print. They sit next to each other on screen, so a
// count that reads "1.2k" in one place and "1200" in the other is the kind of drift that only
// shows up in a screenshot.

/** 695 → "695", 7013 → "7.0k", 224310 → "224k", 1000000 → "1000k" */
export const compact = (count: number): string => {
	if (count < 1000) return `${count}`;
	if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
	// 999_500 and up would round to "1000k".
	if (count < 999_500) return `${Math.round(count / 1000)}k`;
	// "1M", not "1.0M": the context window reads 538k/1M.
	if (count < 100_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

/** 4200 → "4s", 65000 → "1m 5s". Seconds alone stop reading as a duration past a minute. */
export const elapsed = (ms: number): string => {
	const total = Math.max(0, Math.floor(ms / 1000));
	return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
};
