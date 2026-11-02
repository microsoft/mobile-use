import assert from "node:assert/strict";
import test from "node:test";
import { compareScreens, interactionRegion } from "../src/screen-guard.js";
import { chunk, hasCode, pixelPng } from "./helpers.js";

test("visual regions protect full target bounds and a clipped margin, not unrelated rows", () => {
  const display = { width: 720, height: 1600 };
  assert.deepEqual(interactionRegion(display, { x: 600, y: 160, width: 60, height: 24 }), {
    x: 542, y: 102, width: 176, height: 140,
  });
  assert.deepEqual(interactionRegion(display, { x: 0, y: 0, width: 20, height: 30 }), { x: 0, y: 0, width: 78, height: 88 });
  assert.deepEqual(interactionRegion(display, { x: 700, y: 1580, width: 20, height: 20 }), { x: 642, y: 1522, width: 78, height: 78 });
  assert.deepEqual(interactionRegion({ width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }), { x: 0, y: 0, width: 1, height: 1 });
  for (const bounds of [
    { x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: 719, y: 0, width: 2, height: 1 }, { x: 0, y: 1599, width: 1, height: 2 },
    { x: 0.5, y: 0, width: 1, height: 1 },
  ]) assert.throws(() => interactionRegion(display, bounds), hasCode("INVALID_INPUT"));
});

test("comparison counts pixels rather than compressed PNG bytes, metadata, or channel encoding", () => {
  const rgb = pixelPng(80, 160, () => [40, 80, 120, 255], 3);
  const rgba = pixelPng(80, 160, () => [40, 80, 120, 255]);
  const metadata = Buffer.concat([rgba.subarray(0, -12), chunk("tEXt", Buffer.from("fixture\0different encoding")), rgba.subarray(-12)]);
  const region = interactionRegion({ width: 80, height: 160 }, { x: 32, y: 72, width: 16, height: 16 });
  for (const other of [rgb, metadata]) {
    assert.equal(rgba.equals(other), false);
    assert.deepEqual(compareScreens(rgba, other, region), {
      changedPixels: 0, regionChangedPixels: 0, totalPixels: 12_800, changedBounds: null, regionChangedBounds: null,
    });
  }
});

test("a full-size changing ad and status bar are distinguished from a stable search row", () => {
  const before = pixelPng(720, 1600, () => [255, 255, 255, 255]);
  const after = pixelPng(720, 1600, (_x, y) => y < 48 || (y >= 500 && y < 650)
    ? [80, 80, 80, 255] : [255, 255, 255, 255]);
  const region = interactionRegion({ width: 720, height: 1600 }, { x: 600, y: 160, width: 60, height: 24 });
  assert.deepEqual(compareScreens(before, after, region), {
    changedPixels: 720 * 198, regionChangedPixels: 0, totalPixels: 720 * 1600,
    changedBounds: { x: 0, y: 0, width: 720, height: 650 }, regionChangedBounds: null,
  });
});

test("a single changed pixel at either corner of a protected rectangle is detected, including alpha", () => {
  const before = pixelPng(80, 160, () => [255, 255, 255, 255]);
  const region = interactionRegion({ width: 80, height: 160 }, { x: 32, y: 72, width: 16, height: 16 });
  for (const [px, py] of [[24, 64], [55, 95]]) {
    const after = pixelPng(80, 160, (x, y) => [255, 255, 255, x === px && y === py ? 254 : 255]);
    assert.deepEqual(compareScreens(before, after, region), {
      changedPixels: 1, regionChangedPixels: 1, totalPixels: 12_800,
      changedBounds: { x: px, y: py, width: 1, height: 1 },
      regionChangedBounds: { x: px, y: py, width: 1, height: 1 },
    });
  }
});

test("different dimensions and corrupt captures fail explicitly", () => {
  const before = pixelPng(80, 160, () => [255, 255, 255, 255]);
  const region = interactionRegion({ width: 80, height: 160 }, { x: 32, y: 72, width: 16, height: 16 });
  assert.throws(() => compareScreens(before, pixelPng(160, 80, () => [255, 255, 255, 255]), region), hasCode("STALE_OBSERVATION"));
  assert.throws(() => compareScreens(before, Buffer.from("invalid image"), region), hasCode("INVALID_IMAGE"));
});
