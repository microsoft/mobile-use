import { decodePng } from "./android.js";
import { MobileUseError } from "./errors.js";
import type { Rect } from "./types.js";

export function containsPoint(bounds: Rect, point: { x: number; y: number }): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width &&
    point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

export function interactionRegion(
  display: { width: number; height: number },
  bounds: Rect,
): Rect {
  if (!Object.values(bounds).every(Number.isSafeInteger) || bounds.x < 0 || bounds.y < 0 ||
    bounds.width < 1 || bounds.height < 1 ||
    bounds.x + bounds.width > display.width || bounds.y + bounds.height > display.height) {
    throw new MobileUseError("INVALID_INPUT", "Visual target bounds must fit the observed display.", "Supply the complete visible control or swipe surface bounds from a fresh screenshot.");
  }
  const padding = Math.max(8, Math.ceil(Math.min(display.width, display.height) * 0.08));
  const x = Math.max(0, bounds.x - padding);
  const y = Math.max(0, bounds.y - padding);
  return {
    x, y,
    width: Math.min(display.width, bounds.x + bounds.width + padding) - x,
    height: Math.min(display.height, bounds.y + bounds.height + padding) - y,
  };
}

export function compareScreens(previous: Buffer, current: Buffer, region: Rect): {
  changedPixels: number;
  regionChangedPixels: number;
  totalPixels: number;
  changedBounds: Rect | null;
  regionChangedBounds: Rect | null;
} {
  const before = decodePng(previous);
  const after = decodePng(current);
  if (before.width !== after.width || before.height !== after.height) {
    throw new MobileUseError("STALE_OBSERVATION", "Screenshot dimensions changed before coordinate input.", "Inspect a new observation before input.");
  }
  let changedPixels = 0;
  let regionChangedPixels = 0;
  const changedBounds = { left: before.width, top: before.height, right: -1, bottom: -1 };
  const regionBounds = { ...changedBounds };
  const extend = (bounds: typeof changedBounds, x: number, y: number): void => {
    bounds.left = Math.min(bounds.left, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x);
    bounds.bottom = Math.max(bounds.bottom, y);
  };
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const pixel = y * before.width + x;
      let changed = false;
      for (let channel = 0; channel < 4; channel++) {
        const a = channel < before.channels ? before.pixels[pixel * before.channels + channel] : 255;
        const b = channel < after.channels ? after.pixels[pixel * after.channels + channel] : 255;
        if (a !== b) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      changedPixels++;
      extend(changedBounds, x, y);
      if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) {
        regionChangedPixels++;
        extend(regionBounds, x, y);
      }
    }
  }
  const rect = (bounds: typeof changedBounds): Rect | null => bounds.right < 0 ? null : ({
    x: bounds.left, y: bounds.top, width: bounds.right - bounds.left + 1, height: bounds.bottom - bounds.top + 1,
  });
  return {
    changedPixels, regionChangedPixels, totalPixels: before.width * before.height,
    changedBounds: rect(changedBounds), regionChangedBounds: rect(regionBounds),
  };
}
