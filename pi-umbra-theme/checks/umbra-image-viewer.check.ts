// The image viewer behind a click on a tool card's image: the map-style zoom keeps the point under
// the pointer in place, a click lands on the right image rows, frames crop through kitty controls,
// and closing puts pi's overlay compositing back and frees the image.
//
// Run it with:  bun run umbra-image-viewer.check.ts
import assert from "node:assert/strict";
import { Image, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import viewer, { axis, openToolImageAt, zoomCenter } from "../extensions/umbra-image-viewer.ts";

// Loading the extension is what lets umbra-toolbox find it.
viewer();
assert.equal((globalThis as any).__umbraImageViewer?.openToolImageAt, openToolImageAt, "registered for umbra-toolbox");

// The zoom keeps the image point under the pointer where it was.
const before = axis(4000, 800, 0.2, 2000);
const at = 100;
const point = before.srcStart + (at - before.dispStart) / 0.2;
const after = axis(4000, 800, 0.4, zoomCenter(before, 800, at, 0.2, 0.4));
assert.equal(after.srcStart + (at - after.dispStart) / 0.4, point, "point under the pointer stays put");
assert.deepEqual(axis(100, 800, 1, 0), { srcStart: 0, srcSpan: 100, dispStart: 350, dispSpan: 100, center: 50 }, "a small image is centred");
assert.equal(axis(4000, 800, 1, -50).srcStart, 0, "panning stops at the left edge");
assert.equal(axis(4000, 800, 1, 99999).srcStart, 3200, "and at the right edge");

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
setCellDimensions({ widthPx: 10, heightPx: 20 });
// 400x200 PNG header is enough: the viewer never decodes the pixels.
const png = Buffer.alloc(33);
Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
png.writeUInt32BE(400, 16);
png.writeUInt32BE(200, 20);
const image = new Image(png.toString("base64"), "image/png", { fallbackColor: (s) => s }, { maxWidthCells: 20 });
const tool = {
	imageComponents: [image],
	render: (width: number) => ["", "title", "summary", "", ...image.render(width)],
};

const writes: string[] = [];
let overlay: any;
let hidden = false;
const ownComposite = function () {
	return ["base"];
};
// compositeOverlays lives on the prototype in pi, so the viewer's override is an own property.
const tui: any = Object.assign(Object.create({ compositeOverlays: ownComposite }), {
	terminal: { columns: 80, rows: 25, write: (s: string) => writes.push(s) },
	requestRender() {},
	showOverlay(component: any) {
		overlay = component;
		return { hide: () => (hidden = true) };
	},
});

assert.equal(openToolImageAt(tui, tool, 2, 80), false, "a click on the summary is not the image");
assert.equal(openToolImageAt(tui, tool, 4, 80), true, "a click on the image's first row opens it");
assert.ok(overlay, "the viewer is an overlay");

const frame = () => tui.compositeOverlays(["x", "y"], 80, 25) as string[];
let lines = frame();
assert.equal(lines.length, 25, "the frame fills the terminal");
const controls = () => /\x1b_G([^;]*);/.exec(lines.find((l) => l.includes("\x1b_G"))!)![1]!;
assert.match(controls(), /x=0,y=0,w=400,h=200,c=40,r=10,/, "fit shows the whole image at its own size, 40x10 cells of 10x20 px");
assert.match(lines.at(-1)!, / 100% /, "and says so: fit never stretches a smaller image");
assert.match(controls(), /(^|,)i=\d+/, "under its own kitty id");

const wheelUp = () => overlay.handleMouse({ type: "wheel", wheelDelta: -3, screenX: 40, screenY: 12, x: 40, y: 12 });
wheelUp();
lines = frame();
assert.match(controls(), /w=400,h=200,c=48,/, "wheel up first grows a small image whole");
for (let i = 0; i < 4; i++) wheelUp();
lines = frame();
assert.doesNotMatch(controls(), /w=400/, "until it outgrows the window: then a narrower crop");

const cropX = () => Number(/x=(\d+)/.exec(controls())![1]);
const x0 = cropX();
overlay.handleMouse({ type: "press", button: "left", screenX: 40, screenY: 12 });
overlay.handleMouse({ type: "drag", button: "left", screenX: 30, screenY: 12 });
lines = frame();
assert.ok(cropX() > x0, "dragging left moves the view right");

overlay.handleInput("\x1b");
assert.ok(hidden, "esc closes");
assert.equal(tui.compositeOverlays, ownComposite, "pi's compositing is back");
assert.ok(writes.some((w) => w.includes("a=d,d=I")), "the viewer's copy of the image is freed");

console.log("umbra-image-viewer.check.ts ok - zoom holds the pointer, hit rows, kitty crop, close restores");
