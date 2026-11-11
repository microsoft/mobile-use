import { prepareHelper, verifyHelper } from "./device-helper.js";
import type { DeviceCommand, DeviceHelper } from "./device-helper.js";
import { MobileUseError } from "./errors.js";
import { gestureHelperBase64, gestureHelperSha256 } from "./gesture-helper-data.js";
import type { PreparedGestures } from "./types.js";

const helperClass = "dev.mobileuse.gestures.GestureMain";

function helperError(actionMayHaveRun = false): MobileUseError {
  return new MobileUseError(
    "GESTURE_HELPER_UNAVAILABLE",
    "The approved gesture helper is missing, changed, or incompatible with this Android build.",
    "Stop input and revoke this helper's session consent. Ask for fresh approval before mobile_tap with action.kind prepare; never fall back to separate input commands or replay uncertain taps.",
    false, actionMayHaveRun,
  );
}

const helper: DeviceHelper = {
  name: "gestures", fileName: "gestures.dex", mainClass: helperClass,
  base64: gestureHelperBase64, sha256: gestureHelperSha256,
  ready: "MOBILE_USE_GESTURES_V1_READY", unavailable: helperError,
};

export async function prepareGestures(command: DeviceCommand, signal?: AbortSignal): Promise<PreparedGestures> {
  return prepareHelper(command, helper, signal);
}

export async function doubleTap(
  command: DeviceCommand, remotePath: string | undefined,
  x: number, y: number, delayMs: number, ensureReady: () => Promise<void>, signal?: AbortSignal,
): Promise<number> {
  if (!remotePath) {
    throw new MobileUseError(
      "GESTURE_HELPER_NOT_PREPARED", "Double-tap requires explicit preparation of the bundled single-process helper.",
      "Obtain explicit approval or use matching scoped session consent to upload and run the gesture helper, then call mobile_tap with action.kind prepare and observe again.",
    );
  }
  if (![x, y].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff) ||
      !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 250) {
    throw new MobileUseError("INVALID_INPUT", "Invalid bounded gesture arguments.", "Use in-bounds integer coordinates and delayMs from 0 to 250.");
  }
  await verifyHelper(command, helper, remotePath, signal);
  await ensureReady();
  const response = await command([
    "shell", `CLASSPATH=${remotePath}`, "app_process", "/", helperClass, String(x), String(y), String(delayMs),
  ], { mutating: true, ...(signal ? { signal } : {}) });
  const match = /^MOBILE_USE_DOUBLE_TAP_V1 (\d{1,3})\r?\n?$/.exec(response.toString("utf8"));
  const actualGapMs = Number(match?.[1]);
  if (!match || actualGapMs < delayMs || actualGapMs > 300) throw helperError(true);
  return actualGapMs;
}
