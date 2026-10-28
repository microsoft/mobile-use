import assert from "node:assert/strict";
import test from "node:test";
import { compareScreens, interactionBand } from "../src/screen-guard.js";
import { chunk, hasCode, pixelPng } from "./helpers.js";

test("interaction bands protect the whole target row and the complete swipe path with clipped padding", () => {
  const display = { width: 720, height: 1600 };
  assert.deepEqual(interactionBand(display, { x: 630, y: 171 }), { x: 0, y: 113, width: 720, height: 117 });
  assert.deepEqual(interactionBand(display, { x: 0, y: 0 }), { x: 0, y: 0, width: 720, height: 59 });
  assert.deepEqual(interactionBand(display, { x: 719, y: 1599 }), { x: 0, y: 1541, width: 720, height: 59 });
  assert.deepEqual(interactionBand(display, { x: 360, y: 1400 }, { x: 360, y: 400 }), {
    x: 0, y: 342, width: 720, height: 1117,
  });
  assert.deepEqual(interactionBand({ width: 1, height: 1 }, { x: 0, y: 0 }), { x: 0, y: 0, width: 1, height: 1 });
});

test("comparison counts pixels rather than compressed PNG bytes, metadata, or channel encoding", () => {
  const rgb = pixelPng(80, 160, () => [40, 80, 120, 255], 3);
  const rgba = pixelPng(80, 160, () => [40, 80, 120, 255]);
  const metadata = Buffer.concat([rgba.subarray(0, -12), chunk("tEXt", Buffer.from("fixture\0different encoding")), rgba.subarray(-12)]);
  const region = interactionBand({ width: 80, height: 160 }, { x: 40, y: 80 });
  for (const other of [rgb, metadata]) {
    assert.equal(rgba.equals(other), false);
    assert.deepEqual(compareScreens(rgba, other, region), { changedPixels: 0, regionChangedPixels: 0, totalPixels: 12_800 });
  }
});

test("a full-size changing ad and status bar are distinguished from a stable search row", () => {
  const before = pixelPng(720, 1600, () => [255, 255, 255, 255]);
  const after = pixelPng(720, 1600, (_x, y) => y < 48 || (y >= 500 && y < 650)
    ? [80, 80, 80, 255] : [255, 255, 255, 255]);
  const region = interactionBand({ width: 720, height: 1600 }, { x: 630, y: 171 });
  assert.deepEqual(compareScreens(before, after, region), {
    changedPixels: 720 * 198, regionChangedPixels: 0, totalPixels: 720 * 1600,
  });
});

test("a single changed pixel at either edge of a protected row is detected, including alpha", () => {
  const before = pixelPng(80, 160, () => [255, 255, 255, 255]);
  const region = interactionBand({ width: 80, height: 160 }, { x: 40, y: 80 });
  for (const [px, py] of [[0, 72], [79, 88]]) {
    const after = pixelPng(80, 160, (x, y) => [255, 255, 255, x === px && y === py ? 254 : 255]);
    assert.deepEqual(compareScreens(before, after, region), {
      changedPixels: 1, regionChangedPixels: 1, totalPixels: 12_800,
    });
  }
});

test("different dimensions and corrupt captures fail explicitly", () => {
  const before = pixelPng(80, 160, () => [255, 255, 255, 255]);
  const region = interactionBand({ width: 80, height: 160 }, { x: 40, y: 80 });
  assert.throws(() => compareScreens(before, pixelPng(160, 80, () => [255, 255, 255, 255]), region), hasCode("STALE_OBSERVATION"));
  assert.throws(() => compareScreens(before, Buffer.from("invalid image"), region), hasCode("INVALID_IMAGE"));
});
