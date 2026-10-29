import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions } from "./adb.js";
import { checkCancelled, MobileUseError, publicError } from "./errors.js";
import { gestureHelperBase64, gestureHelperSha256 } from "./gesture-helper-data.js";
import type { PreparedGestures } from "./types.js";

type DeviceCommand = (args: readonly string[], options?: RunOptions) => Promise<Buffer>;
const helperClass = "dev.mobileuse.gestures.GestureMain";

function helperError(actionMayHaveRun = false): MobileUseError {
  return new MobileUseError(
    "GESTURE_HELPER_UNAVAILABLE",
    "The approved gesture helper is missing, changed, or incompatible with this Android build.",
    "Stop input. Ask for approval to prepare the bundled helper again; never fall back to separate input commands or replay uncertain taps.",
    false, actionMayHaveRun,
  );
}

async function verifyHelper(command: DeviceCommand, remotePath: string, signal?: AbortSignal): Promise<void> {
  const checksum = await command(["shell", "sha256sum", remotePath], signal ? { signal } : {});
  if (checksum.toString("utf8").trim() !== `${gestureHelperSha256}  ${remotePath}`) throw helperError();
}

export async function prepareGestures(command: DeviceCommand, signal?: AbortSignal): Promise<PreparedGestures> {
  checkCancelled(signal);
  const bytes = Buffer.from(gestureHelperBase64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== gestureHelperSha256) throw helperError();
  const directory = await mkdtemp(path.join(tmpdir(), "mobile-use-gestures-"));
  const localPath = path.join(directory, "gestures.dex");
  const remoteDirectory = `/data/local/tmp/mobile-use-gestures-${randomUUID()}`;
  const remotePath = `${remoteDirectory}/gestures.dex`;
  const mutation = { mutating: true, ...(signal ? { signal } : {}) };
  let created = false;
  try {
    await writeFile(localPath, bytes, { flag: "wx" });
    await command(["shell", "mkdir", "-m", "700", remoteDirectory], mutation);
    created = true;
    await command(["push", localPath, remotePath], mutation);
    await command(["shell", "chmod", "400", remotePath], mutation);
    await verifyHelper(command, remotePath, signal);
    const checked = await command([
      "shell", `CLASSPATH=${remotePath}`, "app_process", "/", helperClass, "--check",
    ], mutation);
    if (checked.toString("utf8").trim() !== "MOBILE_USE_GESTURES_V1_READY") throw helperError(true);
    return { status: "prepared", sha256: gestureHelperSha256, remotePath };
  } catch (error) {
    const failure = publicError(error);
    throw new MobileUseError(failure.code, failure.message, failure.remediation, false, created || failure.actionMayHaveRun);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function doubleTap(
  command: DeviceCommand, remotePath: string | undefined,
  x: number, y: number, delayMs: number, signal?: AbortSignal,
): Promise<number> {
  if (!remotePath) {
    throw new MobileUseError(
      "GESTURE_HELPER_NOT_PREPARED", "Double-tap requires explicit preparation of the bundled single-process helper.",
      "Ask for approval to upload and run the gesture helper on the selected device, then call mobile_prepare_gestures and observe again.",
    );
  }
  if (![x, y].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff) ||
      !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 250) {
    throw new MobileUseError("INVALID_INPUT", "Invalid bounded gesture arguments.", "Use in-bounds integer coordinates and delayMs from 0 to 250.");
  }
  await verifyHelper(command, remotePath, signal);
  const response = await command([
    "shell", `CLASSPATH=${remotePath}`, "app_process", "/", helperClass, String(x), String(y), String(delayMs),
  ], { mutating: true, ...(signal ? { signal } : {}) });
  const match = /^MOBILE_USE_DOUBLE_TAP_V1 (\d{1,3})\r?\n?$/.exec(response.toString("utf8"));
  const actualGapMs = Number(match?.[1]);
  if (!match || actualGapMs < delayMs || actualGapMs > 300) throw helperError(true);
  return actualGapMs;
}
