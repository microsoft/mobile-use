import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceCommand } from "./device-helper.js";
import { checkCancelled, MobileUseError, publicError } from "./errors.js";
import { MAX_RECORDING_TIME_SECONDS } from "./types.js";
import type { RecordingCapabilities, RecordingStatus, ScreenRecording } from "./types.js";

const BIT_RATE = 4_000_000;

function capabilitiesUnavailable(): MobileUseError {
  return new MobileUseError(
    "RECORDING_CAPABILITIES_UNAVAILABLE",
    "The selected device's native recorder duration capabilities could not be established from its help.",
    "Do not infer support from the Android version, guess flags, or start a trial recording. Report the unsupported or unrecognized recorder help; no recording was started.",
  );
}

export function parseRecordingCapabilities(output: string): RecordingCapabilities {
  if (Buffer.byteLength(output) > 64 * 1024 || !/^Usage:\s*screenrecord\b/m.test(output)) throw capabilitiesUnavailable();
  const lines = output.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => /^\s*--time-limit[ \t]+\S+[ \t]*$/.test(line) ? [index] : []);
  const start = headings.length === 1 ? headings[0] : undefined;
  if (start === undefined) throw capabilitiesUnavailable();
  const end = lines.findIndex((line, index) => index > start && /^\s*--[a-z]/.test(line));
  const section = lines.slice(start + 1, end === -1 ? undefined : end).join(" ").replace(/\s+/g, " ").trim();
  const limited = /^Set the maximum recording time, in seconds\. Default \/ maximum is (\d+)\.$/.exec(section);
  const unlimited = /^Set the maximum recording time, in seconds\. Default is (\d+)\. Set to 0 to remove the time limit\.$/.exec(section);
  const nativeDefault = Number(limited?.[1] ?? unlimited?.[1]);
  if ((!limited && !unlimited) || !Number.isSafeInteger(nativeDefault) || nativeDefault < 1 || nativeDefault > MAX_RECORDING_TIME_SECONDS) {
    throw capabilitiesUnavailable();
  }
  return {
    status: "available", source: "device-help", unlimitedSupported: unlimited !== null,
    maxTimeLimitSeconds: limited ? nativeDefault : MAX_RECORDING_TIME_SECONDS,
    nativeDefaultTimeLimitSeconds: nativeDefault,
  };
}

function invalidFile(): MobileUseError {
  return new MobileUseError(
    "INVALID_RECORDING_FILE",
    "Recording requires a new .mp4 file at an absolute local Windows drive path with an existing writable parent.",
    "Choose a local .mp4 destination. Existing files, UNC/device paths, alternate streams, and reserved Windows names are unsupported.",
  );
}

function localDrivePath(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value) && !/[\u0000-\u001f\u007f<>:"|?*]/.test(value.slice(2)) &&
    value.slice(3).split("\\").every((part) => part.length > 0 && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export async function recordingDestination(filePath: string, signal?: AbortSignal): Promise<string> {
  checkCancelled(signal);
  if (!localDrivePath(filePath) || path.extname(filePath).toLowerCase() !== ".mp4") throw invalidFile();
  try {
    const parent = await realpath(path.dirname(filePath));
    if (!localDrivePath(parent) && !/^[A-Za-z]:\\$/.test(parent)) throw invalidFile();
    await access(parent, constants.W_OK);
    const destination = path.join(parent, path.basename(filePath));
    try {
      await lstat(destination);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        checkCancelled(signal);
        return destination;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof MobileUseError) throw error;
    throw invalidFile();
  }
  throw invalidFile();
}

export async function validateRecordingFile(filePath: string): Promise<number> {
  const invalid = (): never => {
    throw new MobileUseError(
      "RECORDING_EXPORT_FAILED", "Android did not produce a finalized MP4 recording with a valid file size.",
      "Do not treat the recording as saved. Check recorder support, free space, and approved screen content.",
    );
  };
  const info = await lstat(filePath);
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 32) return invalid();
  const file = await open(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const boxes = new Set<string>();
    let offset = 0;
    let count = 0;
    while (offset < info.size) {
      if (++count > 4096 || info.size - offset < 8) return invalid();
      const { bytesRead } = await file.read(header, 0, Math.min(16, info.size - offset), offset);
      if (bytesRead < 8) return invalid();
      const kind = header.toString("ascii", 4, 8);
      const shortSize = header.readUInt32BE(0);
      const size = shortSize === 1 ? Number(header.readBigUInt64BE(8))
        : shortSize === 0 ? info.size - offset : shortSize;
      const headerSize = shortSize === 1 ? 16 : 8;
      if (bytesRead < headerSize || !Number.isSafeInteger(size) || size < headerSize || size > info.size - offset) return invalid();
      if (["ftyp", "moov", "mdat"].includes(kind) && size > headerSize) boxes.add(kind);
      offset += size;
    }
    if (!["ftyp", "moov", "mdat"].every((kind) => boxes.has(kind))) return invalid();
    return info.size;
  } finally {
    await file.close();
  }
}

interface RecordingState {
  result: ScreenRecording;
  directory: string;
  argv: string[];
  pid: string | undefined;
  completion: Promise<void>;
  exited: boolean;
  failure: MobileUseError | undefined;
  cleaned: boolean;
}

export class ScreenRecorder {
  private state: RecordingState | undefined;

  constructor(private readonly command: DeviceCommand) {}

  async capabilities(signal?: AbortSignal): Promise<RecordingCapabilities> {
    let output: Buffer;
    try {
      // Native help writes to stderr even on success.
      output = await this.command(["shell", "/system/bin/screenrecord --help 2>&1"], signal ? { signal } : {});
    } catch (error) {
      if (error instanceof MobileUseError && error.code === "ADB_FAILED") throw capabilitiesUnavailable();
      throw error;
    }
    return parseRecordingCapabilities(output.toString("utf8"));
  }

  private failure(message: string, mayHaveRun = true): MobileUseError {
    return new MobileUseError(
      "RECORDING_FAILED", message,
      "Inspect recording status before another request. Never automatically restart an uncertain recording. Without a time limit, capture can continue until stopped or storage is exhausted.",
      false, mayHaveRun,
    );
  }

  async start(filePath: string, timeLimitSeconds: number | undefined, userId: number, signal?: AbortSignal): Promise<ScreenRecording> {
    if (timeLimitSeconds !== undefined && (!Number.isInteger(timeLimitSeconds) || timeLimitSeconds < 1 || timeLimitSeconds > MAX_RECORDING_TIME_SECONDS)) {
      throw new MobileUseError("INVALID_INPUT", `Recording timeLimitSeconds must be a positive integer no greater than ${MAX_RECORDING_TIME_SECONDS}.`, "Provide a supported duration in seconds, or omit it for unlimited recording.");
    }
    if (this.state && !this.state.cleaned) {
      throw new MobileUseError("RECORDING_ACTIVE", "This selection already has an active or unsaved recording.", "Stop and save that recording before starting another.");
    }
    const capabilities = await this.capabilities(signal);
    if ((timeLimitSeconds === undefined && !capabilities.unlimitedSupported) ||
      (timeLimitSeconds !== undefined && timeLimitSeconds > capabilities.maxTimeLimitSeconds)) {
      throw new MobileUseError(
        "RECORDING_DURATION_UNSUPPORTED",
        `This device's recorder supports only 1-${capabilities.maxTimeLimitSeconds} seconds; the requested ${timeLimitSeconds === undefined ? "unlimited recording" : `${timeLimitSeconds}-second limit`} is unsupported.`,
        `No recording was started. Ask the user to approve an explicit timeLimitSeconds between 1 and ${capabilities.maxTimeLimitSeconds}. Never silently shorten, segment, or restart the requested recording.`,
      );
    }
    const destination = await recordingDestination(filePath, signal);
    const id = randomUUID();
    const directory = `/data/local/tmp/mobile-use-recording-${id}`;
    await this.command(["shell", "mkdir", "-m", "700", directory], { mutating: true, ...(signal ? { signal } : {}) });
    const argv = ["/system/bin/screenrecord", "--bit-rate", String(BIT_RATE), "--time-limit", String(timeLimitSeconds ?? 0), `${directory}/capture.mp4`];
    const state: RecordingState = {
      result: { recordingId: id, status: "starting", startedAt: new Date().toISOString(), timeLimitSeconds: timeLimitSeconds ?? null, userId, filePath: destination },
      directory, argv, pid: undefined, completion: Promise.resolve(), exited: false, failure: undefined, cleaned: false,
    };
    this.state = state;
    const requestedTimeoutMs = timeLimitSeconds === undefined ? 0 : (timeLimitSeconds + 15) * 1000;
    // Node timers cannot represent longer finite deadlines; the native limit still applies.
    const timeoutMs = requestedTimeoutMs <= 2_147_483_647 ? requestedTimeoutMs : 0;
    // Keep the ADB shell attached to the selection, not the completed start request.
    state.completion = this.command([
      "shell", `umask 077; echo $$ > ${directory}/pid; exec ${argv.join(" ")}`,
    ], { mutating: true, timeoutMs }).then(() => {
      state.exited = true;
      state.result.status = "completed";
    }, (error: unknown) => {
      state.exited = true;
      const failure = publicError(error);
      state.failure = new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
    });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        checkCancelled(signal);
        if (state.failure) throw state.failure;
        if (state.exited) throw this.failure("The recorder exited before its running state could be verified.");
        const pid = (await this.command([
          "shell", `if [ -f ${directory}/pid ]; then cat ${directory}/pid; fi`,
        ], { timeoutMs: Math.max(1, deadline - Date.now()), ...(signal ? { signal } : {}) })).toString("utf8").trim();
        if (/^[1-9]\d{0,8}$/.test(pid)) {
          const cmdline = await this.command([
            "shell", `if [ -r /proc/${pid}/cmdline ] && [ -f ${directory}/capture.mp4 ]; then cat /proc/${pid}/cmdline; fi`,
          ], { timeoutMs: Math.max(1, deadline - Date.now()), ...(signal ? { signal } : {}) });
          if (cmdline.equals(Buffer.from(`${argv.join("\0")}\0`))) {
            state.pid = pid;
            if (state.failure) throw state.failure;
            if (state.exited) throw this.failure("The recorder exited during startup verification.");
            state.result.status = "recording";
            return { ...state.result };
          }
        } else if (pid) {
          throw this.failure("The recorder returned an invalid process identity.");
        }
        await delay(100);
      }
      throw this.failure("The recorder's running state could not be verified within five seconds.");
    } catch (error) {
      const failure = publicError(error);
      throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
    }
  }

  status(): RecordingStatus {
    if (!this.state) return { status: "idle" };
    if (this.state.failure) throw this.state.failure;
    return { ...this.state.result };
  }

  private async finish(state: RecordingState, signal?: AbortSignal): Promise<void> {
    if (state.exited) return;
    if (!state.pid) {
      const pid = (await this.command([
        "shell", `if [ -f ${state.directory}/pid ]; then cat ${state.directory}/pid; fi`,
      ], signal ? { signal } : {})).toString("utf8").trim();
      if (/^[1-9]\d{0,8}$/.test(pid)) state.pid = pid;
    }
    if (!state.pid) throw this.failure("The recorder's process identity was never verified; no stop signal was sent.");
    const expected = `${state.argv.join(" ")} `;
    const stopped = await this.command([
      "shell", `if [ ! -e /proc/${state.pid} ]; then echo EXITED; ` +
        `elif [ "$(tr '\\000' ' ' < /proc/${state.pid}/cmdline)" = '${expected}' ]; ` +
        `then kill -INT ${state.pid} && echo STOPPED; else echo MISMATCH; fi`,
    ], { mutating: true, ...(signal ? { signal } : {}) });
    if (!["STOPPED", "EXITED"].includes(stopped.toString("utf8").trim()) && !state.exited) {
      throw new MobileUseError("RECORDING_STOP_FAILED", "The recording process no longer matches; no stop was confirmed.", "Do not signal another process or replay automatically. Check status; unlimited capture has no fallback deadline.", false, true);
    }
    const deadline = Date.now() + 10_000;
    while (!state.exited) {
      checkCancelled(signal);
      if (Date.now() >= deadline) {
        throw new MobileUseError("RECORDING_STOP_FAILED", "The recorder did not confirm finalization within ten seconds.", "Check status before another stop request. Do not copy an unfinalized recording.", false, true);
      }
      await delay(50);
    }
    await state.completion;
  }

  async stop(recordingId: string, userId: number, signal?: AbortSignal): Promise<ScreenRecording> {
    const state = this.state;
    if (!state || state.result.recordingId !== recordingId) {
      throw new MobileUseError("RECORDING_NOT_FOUND", "That recording does not belong to this selection.", "Use the recording ID returned by start on the same target token.");
    }
    try {
      return await this.stopRecording(state, userId, signal);
    } catch (error) {
      const failure = publicError(error);
      throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
    }
  }

  private async stopRecording(state: RecordingState, userId: number, signal?: AbortSignal): Promise<ScreenRecording> {
    await this.finish(state, signal);
    if (state.failure) throw state.failure;
    if (state.result.userId !== userId) throw this.failure("The Android user changed; recording was stopped but its content will not be exported.");
    if (state.result.status !== "saved") {
      const remote = `${state.directory}/capture.mp4`;
      const size = (await this.command(["shell", "stat", "-c", "%s", remote], signal ? { signal } : {})).toString("utf8").trim();
      if (!/^[1-9]\d{0,15}$/.test(size) || !Number.isSafeInteger(Number(size))) throw this.failure("The recording file is empty, unavailable, or its size cannot be represented safely.");
      const destination = await recordingDestination(state.result.filePath, signal);
      if (destination !== state.result.filePath) throw invalidFile();
      const directory = await mkdtemp(path.join(path.dirname(destination), ".mobile-use-recording-"));
      try {
        const local = path.join(directory, "capture.mp4");
        await this.command(["pull", remote, local], { timeoutMs: 0, ...(signal ? { signal } : {}) });
        const sizeBytes = await validateRecordingFile(local);
        if (sizeBytes !== Number(size)) throw this.failure("The recording size changed during export.");
        checkCancelled(signal);
        await copyFile(local, destination, constants.COPYFILE_EXCL);
        state.result = { ...state.result, status: "saved", sizeBytes };
      } catch (error) {
        const failure = publicError(error);
        if (error instanceof MobileUseError) throw failure;
        throw new MobileUseError("RECORDING_EXPORT_FAILED", "The MP4 could not be saved to the approved destination.", "Check free space and permissions. Existing files are never overwritten; the completed device recording is retained.", false, true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (!state.cleaned) {
      try {
        await this.command([
          "shell", `rm -f ${state.directory}/capture.mp4 ${state.directory}/pid && rmdir ${state.directory}`,
        ], { mutating: true, ...(signal ? { signal } : {}) });
        state.cleaned = true;
      } catch (error) {
        const failure = publicError(error);
        if (!["ADB_FAILED", "INTERNAL_ERROR"].includes(failure.code)) {
          throw new MobileUseError(failure.code, "The MP4 was saved, but device recording cleanup was interrupted.", failure.remediation, false, true);
        }
        throw new MobileUseError("RECORDING_CLEANUP_FAILED", "The MP4 was saved, but device recording temporary files could not be removed.", "The saved path is available in status. Resolve the connection before explicitly requesting cleanup with stop again.", false, true);
      }
    }
    return { ...state.result };
  }
}
