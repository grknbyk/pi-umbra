// umbra-image-viewer: a full-screen viewer for an image under a tool card. The wheel zooms toward
// the pointer and a drag pans, the way a map does.
//
// Kitty only. Its graphics protocol crops (x,y,w,h) and scales (c,r) on the terminal side, so a
// zoom step never decodes or re-encodes the image. The image goes out once through pi's own kitty
// cache, keyed by its id; every later frame is a placement with new crop controls.
//
// The click that opens it belongs to umbra-toolbox, which already owns pi's fullscreen mouse input
// and knows which card a row belongs to. The two meet on globalThis.__umbraImageViewer rather than
// an import, so either one loads, updates or goes away without the other.
import {
	allocateImageId,
	deleteKittyImage,
	getCapabilities,
	getCellDimensions,
	matchesKey,
	renderImage,
	truncateToWidth,
} from "@earendil-works/pi-tui";

/** Highest zoom, in screen pixels per image pixel. Past this a pixel is a block. */
const MAX_PIXEL_SCALE = 8;
const WHEEL_STEP = 1.2;
const KEY_STEP = 1.5;

/** One axis of the view: the source pixels shown, and where on screen they land. */
export type Axis = { srcStart: number; srcSpan: number; dispStart: number; dispSpan: number; center: number };

/** Centred when the image fits the view on this axis, clamped to its edges when it does not. */
export const axis = (imagePx: number, viewPx: number, scale: number, center: number): Axis => {
	const span = viewPx / scale;
	if (span >= imagePx) {
		const dispSpan = imagePx * scale;
		return { srcStart: 0, srcSpan: imagePx, dispStart: (viewPx - dispSpan) / 2, dispSpan, center: imagePx / 2 };
	}
	const clamped = Math.min(Math.max(center, span / 2), imagePx - span / 2);
	return { srcStart: clamped - span / 2, srcSpan: span, dispStart: 0, dispSpan: viewPx, center: clamped };
};

/** The centre that keeps the image point under `at` in place while the scale goes `from` → `to`. */
export const zoomCenter = (current: Axis, viewPx: number, at: number, from: number, to: number): number => {
	const point = current.srcStart + (at - current.dispStart) / from;
	return point - (at - viewPx / 2) / to;
};

const imageIdOf = (line: string): number | undefined => {
	const found = /\x1b_G(?:[^;]*,)?i=(\d+)[,;]/.exec(line);
	return found ? Number(found[1]) : undefined;
};

class ImageViewer {
	private zoom = 1;
	private cx: number;
	private cy: number;
	private drag?: { x: number; y: number; cx: number; cy: number };
	private head: string[];
	private tail: string;

	constructor(
		private readonly tui: any,
		private readonly widthPx: number,
		private readonly heightPx: number,
		sequence: string,
		private readonly close: () => void,
	) {
		this.cx = widthPx / 2;
		this.cy = heightPx / 2;
		// The transmission renderImage built, minus its size: every frame puts its own crop and
		// cell size in front of the same payload.
		const first = /^\x1b_G([^;]*);/.exec(sequence)!;
		this.head = first[1]!.split(",").filter((control) => !/^[cr]=/.test(control));
		this.tail = sequence.slice(first[0].length);
	}

	private geometry() {
		const cell = getCellDimensions();
		const cols = Math.max(1, Number(this.tui.terminal?.columns) || 80);
		const rows = Math.max(1, (Number(this.tui.terminal?.rows) || 24) - 1);
		const viewW = cols * cell.widthPx;
		const viewH = rows * cell.heightPx;
		// Fit only shrinks. Stretching a screenshot a few percent to fill the window blurs every
		// pixel and shows nothing more; the wheel is there for a closer look.
		const fit = Math.min(viewW / this.widthPx, viewH / this.heightPx, 1);
		const scale = fit * this.zoom;
		return {
			cell,
			cols,
			rows,
			viewW,
			viewH,
			fit,
			scale,
			x: axis(this.widthPx, viewW, scale, this.cx),
			y: axis(this.heightPx, viewH, scale, this.cy),
		};
	}

	private zoomAt(px: number, py: number, factor: number): void {
		const g = this.geometry();
		const maxZoom = Math.max(1, MAX_PIXEL_SCALE / g.fit);
		this.zoom = Math.min(Math.max(this.zoom * factor, 1), maxZoom);
		const next = g.fit * this.zoom;
		this.cx = zoomCenter(g.x, g.viewW, px, g.scale, next);
		this.cy = zoomCenter(g.y, g.viewH, py, g.scale, next);
		this.tui.requestRender();
	}

	private pan(dx: number, dy: number): void {
		const g = this.geometry();
		this.cx = g.x.center + dx / g.scale;
		this.cy = g.y.center + dy / g.scale;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const { cell, cols, rows, scale, x, y } = this.geometry();
		this.cx = x.center;
		this.cy = y.center;
		const col = Math.floor(x.dispStart / cell.widthPx);
		const row = Math.floor(y.dispStart / cell.heightPx);
		const srcX = Math.round(x.srcStart);
		const srcY = Math.round(y.srcStart);
		const controls = [
			`x=${srcX}`,
			`y=${srcY}`,
			`w=${Math.max(1, Math.min(this.widthPx - srcX, Math.round(x.srcSpan)))}`,
			`h=${Math.max(1, Math.min(this.heightPx - srcY, Math.round(y.srcSpan)))}`,
			`c=${Math.max(1, Math.min(cols - col, Math.round(x.dispSpan / cell.widthPx)))}`,
			`r=${Math.max(1, Math.min(rows - row, Math.round(y.dispSpan / cell.heightPx)))}`,
			`X=${Math.floor(x.dispStart - col * cell.widthPx)}`,
			`Y=${Math.floor(y.dispStart - row * cell.heightPx)}`,
		];
		const lines = Array.from({ length: rows }, () => "");
		lines[row] = " ".repeat(col) + `\x1b_G${[...this.head, ...controls].join(",")};${this.tail}`;
		const status = `  ${Math.round(scale * 100)}%  ·  wheel zoom  ·  drag move  ·  double-click zoom in  ·  0 fit  ·  esc close`;
		lines.push(`\x1b[2m${truncateToWidth(status, width)}\x1b[22m`);
		return lines;
	}

	handleMouse(event: any): { handled?: boolean; capture?: boolean } {
		const cell = getCellDimensions();
		const px = event.screenX * cell.widthPx + cell.widthPx / 2;
		const py = event.screenY * cell.heightPx + cell.heightPx / 2;
		if (event.type === "wheel") {
			// Only the sign: a touchpad sends many small steps, a wheel a few large ones.
			if (event.wheelDelta) this.zoomAt(px, py, event.wheelDelta < 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
			return { handled: true };
		}
		if (event.type === "press" && event.button === "left") {
			this.drag = { x: event.screenX, y: event.screenY, cx: this.cx, cy: this.cy };
			return { capture: true };
		}
		if (event.type === "drag" && this.drag) {
			const { scale } = this.geometry();
			this.cx = this.drag.cx - ((event.screenX - this.drag.x) * cell.widthPx) / scale;
			this.cy = this.drag.cy - ((event.screenY - this.drag.y) * cell.heightPx) / scale;
			this.tui.requestRender();
			return { handled: true };
		}
		if (event.type === "release") this.drag = undefined;
		if (event.type === "click" && event.clickCount === 2) this.zoomAt(px, py, 2);
		return { handled: true };
	}

	handleInput(data: string): void {
		const g = this.geometry();
		if (matchesKey(data, "escape") || data === "q") return this.close();
		if (data === "+" || data === "=") return this.zoomAt(g.viewW / 2, g.viewH / 2, KEY_STEP);
		if (data === "-") return this.zoomAt(g.viewW / 2, g.viewH / 2, 1 / KEY_STEP);
		if (data === "0") {
			this.zoom = 1;
			return this.tui.requestRender();
		}
		const step = 8;
		if (matchesKey(data, "left")) return this.pan(-g.viewW / step, 0);
		if (matchesKey(data, "right")) return this.pan(g.viewW / step, 0);
		if (matchesKey(data, "up")) return this.pan(0, -g.viewH / step);
		if (matchesKey(data, "down")) return this.pan(0, g.viewH / step);
	}

	invalidate(): void {}
}

/**
 * Opens the viewer when `row` of `tool` (a ToolExecutionComponent rendered at `width`) falls on
 * one of its images. False when it does not, or when the terminal is not kitty.
 */
export function openToolImageAt(tui: any, tool: any, row: number, width: number): boolean {
	if (getCapabilities().images !== "kitty" || typeof tui?.showOverlay !== "function") return false;
	const images: any[] = tool.imageComponents ?? [];
	if (images.length === 0) return false;
	const lines: string[] = tool.render(width);
	for (const image of images) {
		const id = image.getImageId?.();
		if (id === undefined) continue;
		const start = lines.findIndex((line) => imageIdOf(line) === id);
		if (start === -1 || row < start || row >= start + image.render(width).length) continue;
		open(tui, image.base64Data, image.dimensions);
		return true;
	}
	return false;
}

function open(tui: any, data: string, size: { widthPx: number; heightPx: number }): void {
	const id = allocateImageId();
	// Registers the id with pi's kitty cache, so only the first frame carries the payload.
	const sequence = renderImage(data, size, { maxWidthCells: 1, maxHeightCells: 1, imageId: id, moveCursor: false })!.sequence;
	// pi hands extensions a Proxy of the TUI that forwards `set` but not `delete`, so the override
	// is undone by assigning the old method back, never by deleting it.
	const ownComposite = tui.compositeOverlays;
	const close = () => {
		handle.hide();
		tui.compositeOverlays = ownComposite;
		tui.terminal?.write?.(deleteKittyImage(id));
		tui.requestRender();
	};
	const viewer = new ImageViewer(tui, size.widthPx, size.heightPx, sequence, close);
	// pi keeps a base line that holds an image instead of drawing an overlay over it, and the
	// viewer covers the whole screen. So the overlays are laid out over a blank screen, which
	// keeps their bounds and mouse routing right, and the frame is the viewer's own lines.
	tui.compositeOverlays = function (this: any, screen: string[], width: number, height: number) {
		ownComposite.call(this, screen.map(() => ""), width, height);
		return viewer.render(width);
	};
	const handle = tui.showOverlay(viewer, { width: "100%", maxHeight: "100%", anchor: "top-left" });
}

export default function () {
	(globalThis as { __umbraImageViewer?: unknown }).__umbraImageViewer = { openToolImageAt };
}
