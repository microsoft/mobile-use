import { decodePng } from "./android.js";
import { MobileUseError } from "./errors.js";
import type { Rect } from "./types.js";

export const MAX_CHANGED_SCREEN_FRACTION = 0.2;

export function interactionBand(
  display: { width: number; height: number },
  from: { x: number; y: number },
  to = from,
): Rect {
  const padding = Math.max(8, Math.ceil(Math.min(display.width, display.height) * 0.08));
  const top = Math.max(0, Math.min(from.y, to.y) - padding);
  const bottom = Math.min(display.height - 1, Math.max(from.y, to.y) + padding);
  // Protect the whole row, including a control's label, not just its touch point.
  return { x: 0, y: top, width: display.width, height: bottom - top + 1 };
}

export function compareScreens(previous: Buffer, current: Buffer, region: Rect): {
  changedPixels: number;
  regionChangedPixels: number;
  totalPixels: number;
} {
  const before = decodePng(previous);
  const after = decodePng(current);
  if (before.width !== after.width || before.height !== after.height) {
    throw new MobileUseError("STALE_OBSERVATION", "Screenshot dimensions changed before coordinate input.", "Inspect a new observation before input.");
  }
  let changedPixels = 0;
  let regionChangedPixels = 0;
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
      if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) {
        regionChangedPixels++;
      }
    }
  }
  return { changedPixels, regionChangedPixels, totalPixels: before.width * before.height };
}
