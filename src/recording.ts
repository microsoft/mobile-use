import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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
    const destination = path.join(parent, path.basename(filePath));
    try {
      await lstat(destination);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        const probePath = path.join(parent, `.mobile-use-write-${randomUUID()}`);
        const probe = await open(probePath, "wx");
        try {
          checkCancelled(signal);
        } finally {
          try { await probe.close(); } finally { await rm(probePath); }
        }
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

export async function validateRecordingFile(filePath: string, signal?: AbortSignal): Promise<number> {
  const invalid = (): never => {
    throw new MobileUseError(
      "RECORDING_EXPORT_FAILED", "Android did not produce a finalized MP4 with valid movie, video-track, and sample metadata.",
      "Do not treat the recording as saved. Check recorder support, free space, and approved screen content.",
    );
  };
  const info = await lstat(filePath);
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 32) return invalid();
  const file = await open(filePath, "r");
  try {
    interface Box { kind: string; data: number; end: number }
    let count = 0;
    const read = async (offset: number, length: number): Promise<Buffer> => {
      checkCancelled(signal);
      if (offset < 0 || length < 0 || offset + length > info.size) return invalid();
      const bytes = Buffer.alloc(length);
      if ((await file.read(bytes, 0, length, offset)).bytesRead !== length) return invalid();
      return bytes;
    };
    const children = async (start: number, end: number): Promise<Box[]> => {
      const result: Box[] = [];
      while (start < end) {
        if (++count > 4096 || end - start < 8) return invalid();
        const header = await read(start, 8);
        const shortSize = header.readUInt32BE(0);
        const headerSize = shortSize === 1 ? 16 : 8;
        if (end - start < headerSize) return invalid();
        const size = shortSize === 1 ? Number((await read(start + 8, 8)).readBigUInt64BE())
          : shortSize === 0 ? end - start : shortSize;
        if (!Number.isSafeInteger(size) || size < headerSize || size > end - start) return invalid();
        result.push({ kind: header.toString("ascii", 4, 8), data: start + headerSize, end: start + size });
        start += size;
      }
      return result;
    };
    const one = (boxes: Box[], kind: string): Box => {
      const matches = boxes.filter((box) => box.kind === kind);
      return matches.length === 1 && matches[0] ? matches[0] : invalid();
    };
    const payload = (box: Box, minimum: number): Promise<Buffer> => {
      if (box.end - box.data < minimum) return invalid();
      return read(box.data, minimum);
    };
    const timed = async (box: Box, minimum: number): Promise<void> => {
      const version = (await payload(box, 4))[0];
      if (version !== 0 && version !== 1) return invalid();
      const value = await payload(box, minimum + (version === 1 ? 12 : 0));
      const duration = version === 1 ? value.readBigUInt64BE(24) : BigInt(value.readUInt32BE(16));
      if (value.readUInt32BE(version === 1 ? 20 : 12) === 0 || duration === 0n ||
        duration === (version === 1 ? 0xffffffffffffffffn : 0xffffffffn)) return invalid();
    };
    const rows = async (box: Box, width: number, visit: (bytes: Buffer, offset: number, index: number) => void | Promise<void>): Promise<number> => {
      const header = await payload(box, 8);
      const entries = header.readUInt32BE(4);
      if (header.readUInt32BE(0) !== 0 || entries < 1 || box.end - box.data !== 8 + entries * width) return invalid();
      for (let index = 0; index < entries;) {
        const length = Math.min(1024, entries - index);
        const bytes = await read(box.data + 8 + index * width, length * width);
        for (let entry = 0; entry < length; entry++) await visit(bytes, entry * width, index + entry);
        index += length;
      }
      return entries;
    };
    const top = await children(0, info.size);
    await payload(one(top, "ftyp"), 8);
    const media = top.filter((box) => box.kind === "mdat" && box.end > box.data);
    if (!media.length) return invalid();
    const movie = one(top, "moov");
    const movieBoxes = await children(movie.data, movie.end);
    await timed(one(movieBoxes, "mvhd"), 100);
    const tracks = movieBoxes.filter((box) => box.kind === "trak");
    const trackIds = new Set<number>();
    let videos = 0;
    for (const track of tracks) {
      const trackBoxes = await children(track.data, track.end);
      const trackHeader = one(trackBoxes, "tkhd");
      const version = (await payload(trackHeader, 4))[0];
      if (version !== 0 && version !== 1) return invalid();
      const header = await payload(trackHeader, version === 1 ? 96 : 84);
      const id = header.readUInt32BE(version === 1 ? 20 : 12);
      if (!id || trackIds.has(id)) return invalid();
      trackIds.add(id);
      const mdia = one(trackBoxes, "mdia");
      const metadata = await children(mdia.data, mdia.end);
      const handler = await payload(one(metadata, "hdlr"), 24);
      await payload(one(metadata, "mdhd"), 24);
      if (handler.toString("ascii", 8, 12) !== "vide") continue;
      videos++;
      await timed(one(metadata, "mdhd"), 24);
      if (!header.readUInt32BE(version === 1 ? 88 : 76) || !header.readUInt32BE(version === 1 ? 92 : 80)) return invalid();
      const minf = one(metadata, "minf");
      const mediaBoxes = await children(minf.data, minf.end);
      await payload(one(mediaBoxes, "vmhd"), 12);
      const dinf = one(mediaBoxes, "dinf");
      const dref = one(await children(dinf.data, dinf.end), "dref");
      const referenceHeader = await payload(dref, 8);
      const references = await children(dref.data + 8, dref.end);
      if (referenceHeader.readUInt32BE(0) !== 0 || !references.length ||
        references.length !== referenceHeader.readUInt32BE(4)) return invalid();
      for (const reference of references) {
        if (reference.kind !== "url " || (await payload(reference, 4)).readUInt32BE(0) !== 1) return invalid();
      }
      const table = one(mediaBoxes, "stbl");
      const tables = await children(table.data, table.end);
      const stsd = one(tables, "stsd");
      const descriptions = await children(stsd.data + 8, stsd.end);
      const descriptionHeader = await payload(stsd, 8);
      if (descriptionHeader.readUInt32BE(0) !== 0 || !descriptions.length ||
        descriptions.length !== descriptionHeader.readUInt32BE(4)) return invalid();
      for (const description of descriptions) {
        const visual = await payload(description, 78);
        if (!visual.readUInt16BE(6) || visual.readUInt16BE(6) > references.length ||
          !visual.readUInt16BE(24) || !visual.readUInt16BE(26)) return invalid();
        const configs = await children(description.data + 78, description.end);
        const configKinds: Readonly<Record<string, string>> = { avc1: "avcC", avc3: "avcC", hvc1: "hvcC", hev1: "hvcC", mp4v: "esds" };
        const configKind = configKinds[description.kind];
        if (!configKind) return invalid();
        await payload(one(configs, configKind), configKind === "avcC" ? 7 : configKind === "hvcC" ? 23 : 4);
      }
      const sizesBox = one(tables, "stsz");
      const sizes = await payload(sizesBox, 12);
      const fixedSize = sizes.readUInt32BE(4);
      const samples = sizes.readUInt32BE(8);
      if (sizes.readUInt32BE(0) !== 0 || !samples || sizesBox.end - sizesBox.data !== 12 + (fixedSize ? 0 : samples * 4)) return invalid();
      let timedSamples = 0;
      await rows(one(tables, "stts"), 8, (bytes, offset) => {
        const count = bytes.readUInt32BE(offset);
        if (!count || !bytes.readUInt32BE(offset + 4)) return invalid();
        timedSamples += count;
      });
      if (timedSamples !== samples) return invalid();
      const offsets = tables.filter((box) => box.kind === "stco" || box.kind === "co64");
      if (offsets.length !== 1 || !offsets[0]) return invalid();
      const offsetsBox = offsets[0];
      const chunkCount = (await payload(offsetsBox, 8)).readUInt32BE(4);
      const mapping = one(tables, "stsc");
      let previousChunk = 1;
      let previousSamples = 0;
      let mappedSamples = 0;
      const mappingCount = await rows(mapping, 12, (bytes, offset, index) => {
        const first = bytes.readUInt32BE(offset);
        const perChunk = bytes.readUInt32BE(offset + 4);
        const description = bytes.readUInt32BE(offset + 8);
        if ((index === 0 ? first !== 1 : first <= previousChunk) || first > chunkCount ||
          !perChunk || !description || description > descriptions.length) return invalid();
        mappedSamples += (first - previousChunk) * previousSamples;
        previousChunk = first;
        previousSamples = perChunk;
      });
      mappedSamples += (chunkCount + 1 - previousChunk) * previousSamples;
      if (mappedSamples !== samples) return invalid();
      let mappingIndex = 0;
      let perChunk = 0;
      let nextChunk = 1;
      let sampleIndex = 0;
      let sizeWindow: Buffer = Buffer.alloc(0);
      let windowStart = 0;
      await rows(offsetsBox, offsetsBox.kind === "stco" ? 4 : 8, async (bytes, offset, index) => {
        if (index + 1 === nextChunk) {
          perChunk = (await read(mapping.data + 8 + mappingIndex * 12, 12)).readUInt32BE(4);
          mappingIndex++;
          nextChunk = mappingIndex < mappingCount
            ? (await read(mapping.data + 8 + mappingIndex * 12, 4)).readUInt32BE(0) : chunkCount + 1;
        }
        let chunkBytes = fixedSize * perChunk;
        if (!fixedSize) {
          for (let entry = 0; entry < perChunk; entry++) {
            if (sampleIndex < windowStart || sampleIndex >= windowStart + sizeWindow.length / 4) {
              windowStart = sampleIndex;
              sizeWindow = await read(sizesBox.data + 12 + sampleIndex * 4, Math.min(1024, samples - sampleIndex) * 4);
            }
            const size = sizeWindow.readUInt32BE((sampleIndex - windowStart) * 4);
            if (!size) return invalid();
            chunkBytes += size;
            sampleIndex++;
          }
        }
        const position = offsetsBox.kind === "stco" ? bytes.readUInt32BE(offset) : Number(bytes.readBigUInt64BE(offset));
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(chunkBytes) ||
          !media.some((box) => position >= box.data && position + chunkBytes <= box.end)) return invalid();
      });
    }
    if (!videos) return invalid();
    return info.size;
  } finally {
    await file.close();
  }
}

export async function pullRecording(
  command: DeviceCommand, remote: string, local: string, signal?: AbortSignal, idleTimeoutMs = 30_000,
): Promise<void> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let stalled = false;
  let monitorFailure: unknown;
  const monitor = (async () => {
    let size = 0;
    let progressedAt = Date.now();
    while (!combined.aborted) {
      await delay(Math.min(1000, idleTimeoutMs / 4), undefined, { signal: combined });
      let nextSize = 0;
      try {
        nextSize = (await stat(local)).size;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (nextSize > size) {
        size = nextSize;
        progressedAt = Date.now();
      } else if (Date.now() - progressedAt >= idleTimeoutMs) {
        stalled = true;
        controller.abort();
      }
    }
  })().catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError" && combined.aborted) return;
    monitorFailure = error;
    controller.abort();
  });
  try {
    await command(["pull", remote, local], { timeoutMs: 0, signal: combined });
    checkCancelled(signal);
  } catch (error) {
    if (!stalled && monitorFailure === undefined) throw error;
  } finally {
    controller.abort();
    await monitor;
  }
  if (monitorFailure !== undefined) throw monitorFailure;
  if (stalled) {
    throw new MobileUseError("ADB_TIMEOUT", `Recording export made no file-size progress for ${idleTimeoutMs / 1000} seconds.`,
      "The device recording is retained. Check the connection and local storage before explicitly retrying stop.");
  }
}

export async function copyRecording(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const output = await open(destination, "wx");
  try {
    await pipeline(createReadStream(source), output.createWriteStream(), { ...(signal ? { signal } : {}) });
    checkCancelled(signal);
  } catch (error) {
    await output.close();
    await rm(destination);
    checkCancelled(signal);
    throw error;
  } finally {
    await output.close();
  }
}

interface RecordingState {
  result: ScreenRecording;
  directory: string;
  argv: string[];
  pid: string | undefined;
  completion: Promise<void>;
  commandSettled: boolean;
  exited: boolean;
  failure: MobileUseError | undefined;
  exportFailure: MobileUseError | undefined;
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

  async start(filePath: string, timeLimitSeconds: number | undefined, ready: () => Promise<number>, signal?: AbortSignal): Promise<ScreenRecording> {
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
    const userId = await ready();
    checkCancelled(signal);
    const id = randomUUID();
    const directory = `/data/local/tmp/mobile-use-recording-${id}`;
    const argv = ["/system/bin/screenrecord", "--bit-rate", String(BIT_RATE), "--time-limit", String(timeLimitSeconds ?? 0), `${directory}/capture.mp4`];
    const state: RecordingState = {
      result: { recordingId: id, status: "starting", startedAt: new Date().toISOString(), timeLimitSeconds: timeLimitSeconds ?? null, userId, filePath: destination },
      directory, argv, pid: undefined, completion: Promise.resolve(), commandSettled: false, exited: false,
      failure: undefined, exportFailure: undefined, cleaned: false,
    };
    this.state = state;
    const requestedTimeoutMs = timeLimitSeconds === undefined ? 0 : (timeLimitSeconds + 15) * 1000;
    // Node timers cannot represent longer finite deadlines; the native limit still applies.
    const timeoutMs = requestedTimeoutMs <= 2_147_483_647 ? requestedTimeoutMs : 0;
    // Keep the ADB shell attached to the selection, not the completed start request.
    state.completion = this.command([
      "shell", `umask 077; mkdir -m 700 ${directory} || exit $?; echo $$ > ${directory}/pid || exit $?; exec ${argv.join(" ")}`,
    ], { mutating: true, timeoutMs }).then(() => {
      state.commandSettled = true;
      state.exited = true;
      state.result.status = "completed";
    }, (error: unknown) => {
      state.commandSettled = true;
      const failure = publicError(error);
      state.failure = new MobileUseError(failure.code, failure.message,
        `${failure.remediation} Recording ID: ${state.result.recordingId}. If this target is still available, explicitly request stop to verify and stop the owned process. This failed clip cannot be exported.`, false, true);
    });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        checkCancelled(signal);
        if (state.failure) throw state.failure;
        if (state.exited) return { ...state.result };
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
            if (state.exited) return { ...state.result };
            state.result.status = "recording";
            return { ...state.result };
          }
          if (state.failure) throw state.failure;
          if (state.exited) return { ...state.result };
        } else if (pid) {
          throw this.failure("The recorder returned an invalid process identity.");
        }
        await delay(100);
      }
      throw this.failure("The recorder's running state could not be verified within five seconds.");
    } catch (error) {
      const failure = publicError(error);
      if (state.exited && !state.failure && !signal?.aborted &&
        ["ADB_FAILED", "ADB_TIMEOUT", "RECORDING_FAILED"].includes(failure.code)) return { ...state.result };
      throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
    }
  }

  status(): RecordingStatus {
    if (!this.state) return { status: "idle" };
    if (this.state.failure) throw this.state.failure;
    if (this.state.exportFailure) throw this.state.exportFailure;
    return { ...this.state.result };
  }

  private async finish(state: RecordingState, signal?: AbortSignal): Promise<void> {
    if (state.exited && state.commandSettled) return;
    const deadline = Date.now() + 10_000;
    const options = () => ({ timeoutMs: Math.max(1, deadline - Date.now()), ...(signal ? { signal } : {}) });
    if (!state.pid) {
      const pid = (await this.command([
        "shell", `if [ -f ${state.directory}/pid ]; then cat ${state.directory}/pid; fi`,
      ], options())).toString("utf8").trim();
      if (/^[1-9]\d{0,8}$/.test(pid)) state.pid = pid;
    }
    if (!state.pid) throw this.failure("The recorder's process identity was never verified; no stop signal was sent.");
    const expected = `${state.argv.join(" ")} `;
    const identity = `if [ ! -e /proc/${state.pid} ]; then echo EXITED; ` +
      `elif [ "$(tr '\\000' ' ' < /proc/${state.pid}/cmdline)" = '${expected}' ]; `;
    const stopped = await this.command([
      "shell", identity + `then kill -INT ${state.pid} && echo STOPPED; else echo MISMATCH; fi`,
    ], { ...options(), mutating: true });
    if (!["STOPPED", "EXITED"].includes(stopped.toString("utf8").trim()) && !state.exited) {
      throw new MobileUseError("RECORDING_STOP_FAILED", "The recording process no longer matches; no stop was confirmed.", "Do not signal another process or replay automatically. Check status; unlimited capture has no fallback deadline.", false, true);
    }
    if (stopped.toString("utf8").trim() === "EXITED") state.exited = true;
    while (!state.exited || !state.commandSettled) {
      checkCancelled(signal);
      if (Date.now() >= deadline) {
        throw new MobileUseError("RECORDING_STOP_FAILED", "The recorder did not confirm finalization within ten seconds.", "Check status before another stop request. Do not copy an unfinalized recording.", false, true);
      }
      await delay(50);
      if (!state.exited) {
        const status = (await this.command(["shell", identity + "then echo RUNNING; else echo MISMATCH; fi"],
          options())).toString("utf8").trim();
        if (status === "EXITED") state.exited = true;
        else if (status !== "RUNNING") throw this.failure("The owned recorder's exit could not be confirmed.");
      }
    }
    await state.completion;
  }

  async stop(recordingId: string, readUser: () => Promise<number>, signal?: AbortSignal): Promise<ScreenRecording> {
    const state = this.state;
    if (!state || state.result.recordingId !== recordingId) {
      throw new MobileUseError("RECORDING_NOT_FOUND", "That recording does not belong to this selection.", "Use the recording ID returned by start on the same target token.");
    }
    try {
      return await this.stopRecording(state, readUser, signal);
    } catch (error) {
      const failure = publicError(error);
      throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
    }
  }

  private async verifyExportUser(state: RecordingState, readUser: () => Promise<number>): Promise<void> {
    if (state.exportFailure) throw state.exportFailure;
    try {
      if (state.result.userId !== await readUser()) {
        throw this.failure("The Android user changed; recording was stopped and this clip can never be exported.");
      }
    } catch (error) {
      state.exportFailure = publicError(error);
      throw state.exportFailure;
    }
  }

  private async stopRecording(state: RecordingState, readUser: () => Promise<number>, signal?: AbortSignal): Promise<ScreenRecording> {
    await this.finish(state, signal);
    if (state.failure) throw state.failure;
    if (state.result.status !== "saved") {
      await this.verifyExportUser(state, readUser);
      const remote = `${state.directory}/capture.mp4`;
      const size = (await this.command(["shell", "stat", "-c", "%s", remote], signal ? { signal } : {})).toString("utf8").trim();
      if (!/^[1-9]\d{0,15}$/.test(size) || !Number.isSafeInteger(Number(size))) throw this.failure("The recording file is empty, unavailable, or its size cannot be represented safely.");
      const destination = await recordingDestination(state.result.filePath, signal);
      if (destination !== state.result.filePath) throw invalidFile();
      const directory = await mkdtemp(path.join(path.dirname(destination), ".mobile-use-recording-"));
      try {
        const local = path.join(directory, "capture.mp4");
        await pullRecording(this.command, remote, local, signal);
        const sizeBytes = await validateRecordingFile(local, signal);
        if (sizeBytes !== Number(size)) throw this.failure("The recording size changed during export.");
        await this.verifyExportUser(state, readUser);
        checkCancelled(signal);
        await copyRecording(local, destination, signal);
        if (signal?.aborted) {
          await rm(destination);
          checkCancelled(signal);
        }
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
