import { crc32, inflateSync } from "node:zlib";
import { setTimeout } from "node:timers/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { AdbConnection, RunOptions } from "./adb.js";
import { localApkFile, parseAndroidUser, parseForegroundApp, parseInstalledApps, parsePackageStopped, validatePackageName } from "./apps.js";
import { checkCancelled, isRecord, MobileUseError, publicError } from "./errors.js";
import { doubleTap, prepareGestures } from "./gestures.js";
import { appendUnicodeText, isAdbText, prepareTextInput, unicodeHierarchy, validateText } from "./text-input.js";
export { validateText } from "./text-input.js";
import type { AppOperationResult, DeviceEndpoint, DeviceIdentity, ForegroundApp, InstalledApps, PreparedGestures, PreparedTextInput, Rect, ScreenElement, WakeResult } from "./types.js";

export interface Hierarchy {
  rotation: number;
  elements: Omit<ScreenElement, "ref">[];
}

export interface Screenshot {
  image: Buffer;
  width: number;
  height: number;
}

export interface DisplayState {
  width: number;
  height: number;
  rotation: number;
}

function diagnosticSection(lines: string[], heading: string, unavailable: () => never): string[] {
  const headings = lines.flatMap((line, index) => line.trim() === heading ? [index] : []);
  const start = headings.length === 1 ? headings[0] : undefined;
  if (start === undefined) return unavailable();
  const indentation = lines[start]?.search(/\S/) ?? -1;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (line.search(/\S/) <= indentation) break;
    body.push(line);
  }
  return body;
}

function displayStateError(cause?: string): MobileUseError {
  return new MobileUseError(
    "DISPLAY_STATE_UNAVAILABLE",
    `The primary display's geometry and rotation could not be verified${cause ? ` (${cause})` : ""}.`,
    "Observe again before input. Unrecognized or ambiguous display diagnostics cannot establish safe input geometry.",
    true,
  );
}

export function parseDisplayState(output: string): DisplayState {
  if (Buffer.byteLength(output) > 1024 * 1024) throw displayStateError();
  const unavailable = (): never => { throw displayStateError(); };
  const lines = output.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = /^\s*Display: mDisplayId=(0|[1-9]\d*)(?:\s|$)/.exec(line);
    return match ? [{ index, id: match[1] }] : [];
  });
  const primary = headings.filter((heading) => heading.id === "0");
  const start = primary.length === 1 ? primary[0]?.index : undefined;
  if (start === undefined) throw displayStateError();
  // DisplayRotation is a sibling of the display header in WindowManager diagnostics.
  const end = headings.find((heading) => heading.index > start)?.index;
  const display = lines.slice(start + 1, end);
  const sizes = display.filter((line) => /^\s*init=/.test(line))
    .flatMap((line) => [...line.matchAll(/\bcur=(\d+)x(\d+)(?=\s|$)/g)]);
  const rotationSection = diagnosticSection(display, "DisplayRotation", unavailable);
  const rotations = rotationSection.flatMap((line) => [...line.matchAll(/\bmRotation=(\S+)/g)]);
  const rotation = new Map<string, number>([
    ["0", 0], ["1", 1], ["2", 2], ["3", 3],
    ["ROTATION_0", 0], ["ROTATION_90", 1], ["ROTATION_180", 2], ["ROTATION_270", 3],
  ]).get(rotations.length === 1 ? rotations[0]?.[1] ?? "" : "");
  if (sizes.length !== 1 || rotation === undefined) throw displayStateError();
  const width = Number(sizes[0]?.[1]);
  const height = Number(sizes[0]?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > 8192 || height > 8192) throw displayStateError();
  return { width, height, rotation };
}

export interface KeyguardState {
  showing: boolean;
  secure: boolean;
  inputRestricted: boolean;
  screenOn: boolean;
  userId: number;
}

export function parseKeyguardState(output: string): KeyguardState {
  const unavailable = (): never => {
    throw new MobileUseError(
      "KEYGUARD_STATE_UNAVAILABLE",
      "The device's lock-screen state could not be established.",
      "Wake and unlock the phone manually. Unrecognized OEM lock-screen diagnostics are not safe to dismiss.",
    );
  };
  if (Buffer.byteLength(output) > 128 * 1024) unavailable();
  const fields = (lines: string[]): Map<string, string> => {
    const indentation = lines.reduce((minimum, line) => Math.min(minimum, line.search(/\S/)), Infinity);
    const values = new Map<string, string>();
    for (const line of lines) {
      if (line.search(/\S/) !== indentation) continue;
      const match = /^\s*(\w+)=(\S+)\s*$/.exec(line);
      if (match?.[1] && match[2]) {
        if (values.has(match[1])) unavailable();
        values.set(match[1], match[2]);
      }
    }
    return values;
  };
  const delegateSection = diagnosticSection(output.split(/\r?\n/), "KeyguardServiceDelegate", unavailable);
  const delegate = fields(delegateSection);
  const monitor = fields(diagnosticSection(delegateSection, "KeyguardStateMonitor", unavailable));
  const flag = (values: Map<string, string>, name: string): boolean => {
    const value = values.get(name);
    if (value !== "true" && value !== "false") unavailable();
    return value === "true";
  };
  // Delegate caches can lag the live monitor, including USER_NULL before a user switch.
  const showing = flag(monitor, "mIsShowing");
  const inputRestricted = flag(monitor, "mInputRestricted");
  const secure = flag(delegate, "secure");
  const simSecure = flag(monitor, "mSimSecure");
  if (!flag(delegate, "systemIsReady") || !flag(delegate, "bootCompleted")) unavailable();
  const user = monitor.get("mCurrentUserId");
  const delegateUser = delegate.get("currentUser");
  if (!user || !/^(0|[1-9]\d*)$/.test(user) ||
    !Number.isSafeInteger(Number(user)) ||
    (delegateUser !== "-10000" && delegateUser !== user) ||
    (delegate.has("mCurrentUserId") && delegate.get("mCurrentUserId") !== user)) unavailable();
  const screen = delegate.get("screenState");
  if (!["SCREEN_STATE_OFF", "SCREEN_STATE_TURNING_ON", "SCREEN_STATE_ON", "SCREEN_STATE_TURNING_OFF"].includes(screen ?? "")) unavailable();
  return { showing, secure: secure || simSecure, inputRestricted, screenOn: screen === "SCREEN_STATE_ON", userId: Number(user) };
}

function invalidImage(): never {
  throw new MobileUseError(
    "INVALID_IMAGE",
    "Screen capture was not a complete supported PNG image.",
    "Observe again on an unlocked, non-protected primary display. Do not bypass capture protection.",
    true,
  );
}

function readPng(image: Buffer): { width: number; height: number; channels: number; raw: Buffer } {
  if (image.length > 5 * 1024 * 1024) {
    throw new MobileUseError(
      "CAPTURE_UNAVAILABLE",
      "The PNG exceeds the POC's 5 MiB image limit.",
      "Use a simpler non-sensitive screen. The plugin will not change device resolution automatically.",
    );
  }
  if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalidImage();
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let ended = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= image.length) {
    const size = image.readUInt32BE(offset);
    if (size > image.length - offset - 12) invalidImage();
    const type = image.subarray(offset + 4, offset + 8).toString("ascii");
    const data = image.subarray(offset + 8, offset + 8 + size);
    if (crc32(image.subarray(offset + 4, offset + 8 + size)) !== image.readUInt32BE(offset + 8 + size)) invalidImage();
    if (type === "IHDR") {
      if (offset !== 8 || size !== 13) invalidImage();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const color = data[9];
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (!width || !height || width > 8192 || height > 8192 || data[8] !== 8 || !channels ||
        data[10] !== 0 || data[11] !== 0 || data[12] !== 0) invalidImage();
    } else if (!width) {
      invalidImage();
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      if (size !== 0 || offset + 12 !== image.length) invalidImage();
      ended = true;
      break;
    } else if (/^[A-Z]/.test(type) || type === "tRNS") {
      invalidImage();
    }
    offset += size + 12;
  }
  const stride = width * channels + 1;
  const expected = stride * height;
  if (!ended || !compressed.length || expected > 64 * 1024 * 1024) invalidImage();
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  } catch {
    invalidImage();
  }
  if (raw.length !== expected) invalidImage();
  for (let row = 0; row < height; row++) {
    if ((raw[row * stride] ?? 255) > 4) invalidImage();
  }
  return { width, height, channels, raw };
}

export function validatePng(image: Buffer): { width: number; height: number } {
  const { width, height } = readPng(image);
  return { width, height };
}

export function decodePng(image: Buffer): { width: number; height: number; channels: number; pixels: Buffer } {
  const { width, height, channels, raw } = readPng(image);
  const rowBytes = width * channels;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    for (let x = 0; x < rowBytes; x++) {
      const offset = y * rowBytes + x;
      const left = x >= channels ? pixels[offset - channels] ?? 0 : 0;
      const above = y > 0 ? pixels[offset - rowBytes] ?? 0 : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[offset - rowBytes - channels] ?? 0 : 0;
      let predictor = 0;
      switch (filter) {
        case 0: break;
        case 1: predictor = left; break;
        case 2: predictor = above; break;
        case 3: predictor = Math.floor((left + above) / 2); break;
        case 4: {
          const estimate = left + above - upperLeft;
          const a = Math.abs(estimate - left);
          const b = Math.abs(estimate - above);
          const c = Math.abs(estimate - upperLeft);
          predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft;
          break;
        }
        default: invalidImage();
      }
      pixels[offset] = (raw[y * (rowBytes + 1) + x + 1] ?? 0) + predictor;
    }
  }
  return { width, height, channels, pixels };
}

function hierarchyError(): never {
  throw new MobileUseError(
    "HIERARCHY_UNAVAILABLE",
    "UI Automator did not return a valid bounded hierarchy.",
    "Observe again after the screen is idle. Custom-drawn or protected screens may not expose semantic UI data.",
    true,
  );
}

function readAttributes(value: unknown): Record<string, string> {
  if (!isRecord(value)) hierarchyError();
  const attributes: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (typeof text !== "string") hierarchyError();
    attributes[name] = text;
  }
  return attributes;
}

function readFlag(attributes: Record<string, string>, name: string): boolean | null {
  switch (attributes[name]) {
    case undefined: return null;
    case "false": return false;
    case "true": return true;
    default: return hierarchyError();
  }
}

function readBounds(value: string): Rect {
  if (!value.startsWith("[") || !value.endsWith("]")) hierarchyError();
  const corners = value.slice(1, -1).split("][");
  if (corners.length !== 2) hierarchyError();
  const coordinates = corners.flatMap((corner) => corner.split(","));
  if (coordinates.length !== 4 || coordinates.some((coordinate) => !/^-?[0-9]+$/.test(coordinate))) hierarchyError();
  const numbers = coordinates.map(Number);
  if (!numbers.every(Number.isSafeInteger)) hierarchyError();
  const [x, y, right, bottom] = numbers;
  if (x === undefined || y === undefined || right === undefined || bottom === undefined) hierarchyError();
  const width = right - x;
  const height = bottom - y;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) hierarchyError();
  return { x, y, width, height };
}

function screenNode(attributes: Record<string, string>): Omit<ScreenElement, "ref"> | null {
  const className = attributes.class;
  if (!className || !attributes.bounds) hierarchyError();
  const bounds = readBounds(attributes.bounds);
  const password = readFlag(attributes, "password");
  const text = password === true ? "[redacted]" : attributes.text ?? "";
  const label = attributes["content-desc"] || attributes.hint || "";
  if (text.length + label.length > 4096) hierarchyError();
  const textHash = attributes["text-sha256"];
  if (textHash !== undefined && !/^[0-9a-f]{64}$/.test(textHash)) hierarchyError();
  const windowIdentity = attributes["window-identity"];
  if (windowIdentity !== undefined && (!/^[0-9a-f]{1,8}:u(0|[1-9]\d*)$/.test(windowIdentity) ||
      Number(windowIdentity.split(":u")[1]) > 0x7fffffff)) hierarchyError();
  const node = {
    bounds, className, text, label, password,
    ...(textHash !== undefined && password === false ? { textHash } : {}),
    ...(windowIdentity !== undefined ? { windowIdentity } : {}),
    resourceId: attributes["resource-id"] || null,
    editable: className.endsWith("EditText"),
    enabled: readFlag(attributes, "enabled"),
    focused: readFlag(attributes, "focused"),
    clickable: readFlag(attributes, "clickable"),
  };
  const meaningful = node.text || node.label || node.resourceId || node.editable || node.clickable;
  return meaningful && bounds.width > 0 && bounds.height > 0 ? node : null;
}

export function parseHierarchy(output: string): Hierarchy {
  if (Buffer.byteLength(output) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(output)) hierarchyError();
  const opening = output.indexOf("<hierarchy");
  if (opening < 0) hierarchyError();
  const closing = output.lastIndexOf("</hierarchy>");
  const emptyRoot = /^<hierarchy\b[^>]*\/>/.exec(output.slice(opening));
  const document = emptyRoot?.[0] ?? (closing >= opening ? output.slice(opening, closing + 12) : "");
  if (!document || XMLValidator.validate(document) !== true) hierarchyError();
  const tree: unknown = new XMLParser({
    preserveOrder: true,
    ignoreDeclaration: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    // fast-xml-parser also gates XML numeric character references behind this option.
    htmlEntities: true,
  }).parse(document);
  if (!Array.isArray(tree) || tree.length !== 1) hierarchyError();
  const root: unknown = tree[0];
  if (!isRecord(root) || !Array.isArray(root.hierarchy)) hierarchyError();
  const rotation = readAttributes(root[":@"]).rotation;
  if (rotation === undefined || !["0", "1", "2", "3"].includes(rotation)) hierarchyError();

  const pending: { entry: unknown; depth: number }[] = [];
  const enqueue = (children: unknown[], depth: number): void => {
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ entry: children[index], depth });
    }
  };
  enqueue(root.hierarchy, 1);
  const elements: Hierarchy["elements"] = [];
  let traversed = 0;
  let bytes = 0;
  while (pending.length) {
    const frame = pending.pop();
    if (!frame || !isRecord(frame.entry) || !Array.isArray(frame.entry.node)) hierarchyError();
    if (frame.depth > 64 || ++traversed > 2000) hierarchyError();
    const element = screenNode(readAttributes(frame.entry[":@"]));
    if (element) {
      bytes += Buffer.byteLength(JSON.stringify(element));
      if (elements.length === 500 || bytes > 512 * 1024) hierarchyError();
      elements.push(element);
    }
    enqueue(frame.entry.node, frame.depth + 1);
  }
  return { rotation: Number(rotation), elements };
}

export class AndroidBackend {
  private gestureHelperPath: string | undefined;
  private textHelperPath: string | undefined;

  constructor(
    private readonly adb: AdbConnection,
    private readonly endpoint: DeviceEndpoint,
    private readonly targetSignal: AbortSignal,
    private readonly assertCurrent: () => void,
  ) {}

  private async command(args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
    this.assertCurrent();
    if (!this.endpoint.transportId) {
      throw new MobileUseError("TRANSPORT_LOST", "The selected endpoint has no transport ID.", "Rediscover and reselect.");
    }
    const signal = options.signal ? AbortSignal.any([this.targetSignal, options.signal]) : this.targetSignal;
    return this.adb.run(["-t", this.endpoint.transportId, ...args], { ...options, signal });
  }

  private async property(name: string, signal?: AbortSignal): Promise<string> {
    const output = await this.command(["shell", "getprop", name], signal ? { signal } : {});
    const value = output.toString("utf8").trim();
    if (output.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new MobileUseError("DEVICE_METADATA_UNAVAILABLE", "A device property is malformed or exceeds the POC's limit.", "Check the selected device's build and authorization.");
    }
    return value;
  }

  async identity(signal?: AbortSignal): Promise<DeviceIdentity> {
    const [sdk, androidVersion, serial, qemu] = await Promise.all([
      this.property("ro.build.version.sdk", signal),
      this.property("ro.build.version.release", signal),
      this.property("ro.serialno", signal),
      this.property("ro.kernel.qemu", signal),
    ]);
    if (!/^\d+$/.test(sdk) || !androidVersion) {
      throw new MobileUseError("DEVICE_METADATA_UNAVAILABLE", "The Android version could not be established.", "Check the selected device's build and authorization.");
    }
    const apiLevel = Number(sdk);
    if (!Number.isSafeInteger(apiLevel)) {
      throw new MobileUseError("DEVICE_METADATA_UNAVAILABLE", "The Android API level is invalid.", "Check the selected device's build.");
    }
    if (apiLevel < 30 || qemu === "1" || this.endpoint.kind === "emulator") {
      throw new MobileUseError("DEVICE_UNSUPPORTED", "A real Android 11+ phone or tablet is required.", "Select supported physical hardware.");
    }
    let wirelessEvidence: DeviceIdentity["wirelessEvidence"] = "not-applicable";
    if (this.endpoint.kind === "network" || this.endpoint.kind === "paired-wireless") {
      const [tlsPort, enabled] = await Promise.all([
        this.property("service.adb.tls.port", signal),
        this.property("persist.adb.tls_server.enable", signal),
      ]);
      const validPort = /^\d+$/.test(tlsPort) && Number(tlsPort) > 0 && Number(tlsPort) <= 65535;
      const addressPort = /:(\d+)$/.exec(this.endpoint.endpointId)?.[1];
      if (!validPort || !["1", "true"].includes(enabled) ||
        (this.endpoint.kind === "network" && addressPort !== tlsPort)) {
        throw new MobileUseError(
          "TRANSPORT_UNVERIFIED",
          "This endpoint could not be qualified as modern paired Wireless debugging.",
          "The user must pair/connect using Android Wireless debugging's connection address. Legacy TCP and unverifiable endpoints are not supported.",
        );
      }
      wirelessEvidence = this.endpoint.kind === "network" ? "device-tls-port" : "adb-tls-connect-service";
    }
    return {
      hardwareSerial: serial && !/^(unknown|null|0+)$/i.test(serial) ? serial : null,
      androidVersion, apiLevel, wirelessEvidence,
    };
  }

  async screenshot(signal?: AbortSignal): Promise<Screenshot> {
    const image = await this.command(["exec-out", "screencap", "-p"], signal ? { signal } : {});
    return { image, ...validatePng(image) };
  }

  async hierarchy(signal?: AbortSignal): Promise<Hierarchy> {
    if (this.textHelperPath) {
      const before = await this.displayState(signal);
      const output = await unicodeHierarchy((args, options) => this.command(args, options), this.textHelperPath, before.rotation, signal);
      const after = await this.displayState(signal);
      if (before.rotation !== after.rotation || before.width !== after.width || before.height !== after.height) {
        throw new MobileUseError("STALE_OBSERVATION", "Display state changed during Unicode hierarchy capture.", "Observe again on the primary display.");
      }
      return parseHierarchy(output.toString("utf8"));
    }
    // UI Automator opens /dev/tty as a file; raw exec-out has no controlling terminal.
    const output = await this.command(["shell", "-tt", "uiautomator", "dump", "/dev/tty"], signal ? { signal } : {});
    return parseHierarchy(output.toString("utf8"));
  }

  async displayState(signal?: AbortSignal): Promise<DisplayState> {
    for (let attempt = 0; ; attempt++) {
      checkCancelled(signal);
      const deadline = AbortSignal.timeout(2000);
      const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const output = await this.command(["shell", "dumpsys", "window", "displays"], { signal: readSignal });
        this.assertCurrent();
        checkCancelled(signal);
        checkCancelled(this.targetSignal);
        if (deadline.aborted) throw displayStateError("ADB_TIMEOUT");
        return parseDisplayState(output.toString("utf8"));
      } catch (error) {
        this.assertCurrent();
        checkCancelled(signal);
        checkCancelled(this.targetSignal);
        const failure = publicError(error);
        const timedOut = failure.code === "CANCELLED" && deadline.aborted;
        if (!timedOut && !["DISPLAY_STATE_UNAVAILABLE", "ADB_FAILED", "ADB_TIMEOUT"].includes(failure.code)) throw failure;
        if (attempt === 1) throw displayStateError(timedOut ? "ADB_TIMEOUT" : failure.code);
      }
    }
  }

  async tap(x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.input("tap", [x, y], signal);
  }

  async prepareGestures(signal?: AbortSignal): Promise<PreparedGestures> {
    this.gestureHelperPath = undefined;
    const prepared = await prepareGestures((args, options) => this.command(args, options), signal);
    this.gestureHelperPath = prepared.remotePath;
    return prepared;
  }

  async doubleTap(x: number, y: number, delayMs: number, signal?: AbortSignal): Promise<number> {
    return doubleTap((args, options) => this.command(args, options), this.gestureHelperPath, x, y, delayMs, signal);
  }

  async swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number, signal?: AbortSignal): Promise<void> {
    await this.input("swipe", [from.x, from.y, to.x, to.y, durationMs], signal);
  }

  async prepareTextInput(signal?: AbortSignal): Promise<PreparedTextInput> {
    this.textHelperPath = undefined;
    const prepared = await prepareTextInput((args, options) => this.command(args, options), signal);
    this.textHelperPath = prepared.remotePath;
    return prepared;
  }

  async typeText(text: string, signal?: AbortSignal, field?: ScreenElement, foreground?: ForegroundApp): Promise<void> {
    validateText(text);
    if (!isAdbText(text)) {
      if (!field || !foreground) {
        throw new MobileUseError("ELEMENT_CHANGED", "Unicode input requires a verified native field and foreground app.", "Observe and focus an approved non-password EditText again.");
      }
      await appendUnicodeText((args, options) => this.command(args, options), this.textHelperPath, text, field, foreground, signal);
      return;
    }
    // The allowlist excludes shell syntax and literal %, so only Android's space encoding is needed.
    await this.input("text", [text.split(" ").join("%s")], signal);
  }

  async key(key: "HOME" | "BACK" | "ENTER", signal?: AbortSignal): Promise<void> {
    await this.input("keyevent", [{ HOME: 3, BACK: 4, ENTER: 66 }[key]], signal);
  }

  async wake(signal?: AbortSignal): Promise<WakeResult> {
    let woken = false;
    try {
      // WAKEUP does not toggle an already awake display off.
      await this.input("keyevent", [224], signal);
      woken = true;
      const options = signal ? { signal } : {};
      let dismissed = false;
      let userId: number | undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        checkCancelled(signal);
        const output = await this.command(["shell", "dumpsys", "window", "policy"], options);
        const state = parseKeyguardState(output.toString("utf8"));
        if (userId !== undefined && userId !== state.userId) {
          throw new MobileUseError("WAKE_FAILED", "The Android user changed during wake.", "Unlock the intended user manually before continuing.");
        }
        userId = state.userId;
        if (state.showing || state.inputRestricted) {
          if (state.secure) {
            throw new MobileUseError(
              "MANUAL_UNLOCK_REQUIRED",
              "The phone requires manual authentication.",
              "Unlock it yourself using its PIN, password, pattern, or biometrics. Never send credentials to Copilot.",
            );
          }
          if (state.screenOn && !dismissed) {
            const response = await this.command(["shell", "wm", "dismiss-keyguard"], { ...options, mutating: true });
            if (response.toString("utf8").trim()) {
              throw new MobileUseError("WAKE_FAILED", "Android did not confirm the unsecured keyguard dismissal.", "Dismiss the lock screen manually; do not replay the action automatically.");
            }
            dismissed = true;
          }
        } else if (state.screenOn) {
          return { status: "awake-and-unlocked", keyguardDismissed: dismissed };
        }
        if (attempt < 9) await setTimeout(250, undefined, options);
      }
      throw new MobileUseError("WAKE_FAILED", "The display did not become awake and unlocked within the verification window.", "Check the phone and unlock it manually before continuing.");
    } catch (error) {
      const original = publicError(error);
      const failure = signal?.aborted
        ? new MobileUseError("CANCELLED", "The wake operation was cancelled.", "Check the phone before continuing; do not automatically replay the action.", false, original.actionMayHaveRun)
        : original;
      if (woken || failure.actionMayHaveRun || !(error instanceof MobileUseError)) {
        throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
      }
      throw failure;
    }
  }

  private async input(verb: "tap" | "swipe" | "text" | "keyevent", values: readonly (string | number)[], signal?: AbortSignal): Promise<void> {
    await this.command(["shell", "input", verb, ...values.map(String)], { mutating: true, ...(signal ? { signal } : {}) });
  }

  private async currentUser(signal?: AbortSignal): Promise<number> {
    const output = await this.command(["shell", "am", "get-current-user"], signal ? { signal } : {});
    return parseAndroidUser(output.toString("utf8"));
  }

  async listApps(signal?: AbortSignal): Promise<InstalledApps> {
    return this.appsForUser(await this.currentUser(signal), signal);
  }

  private async appsForUser(userId: number, signal?: AbortSignal): Promise<InstalledApps> {
    const output = await this.command(["shell", "pm", "list", "packages", "--user", String(userId)], signal ? { signal } : {});
    return parseInstalledApps(output.toString("utf8"), userId);
  }

  async getForegroundApp(signal?: AbortSignal): Promise<ForegroundApp | null> {
    const output = await this.command(["shell", "dumpsys", "activity", "activities"], signal ? { signal } : {});
    return parseForegroundApp(output.toString("utf8"));
  }

  private async requireInstalled(packageName: string, userId: number, signal?: AbortSignal): Promise<void> {
    if (!(await this.appsForUser(userId, signal)).apps.some((app) => app.packageName === packageName)) {
      throw new MobileUseError("APP_NOT_FOUND", "The requested app is not installed for the current Android user.", "List apps and use the exact requested package. No installation was attempted.");
    }
  }

  private async appMutation<T>(
    args: readonly string[],
    verify: (output: string) => Promise<T>,
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<T> {
    let dispatched = false;
    try {
      const output = await this.command(args, { mutating: true, timeoutMs, ...(signal ? { signal } : {}) });
      dispatched = true;
      this.assertCurrent();
      checkCancelled(signal);
      checkCancelled(this.targetSignal);
      return await verify(output.toString("utf8"));
    } catch (error) {
      const failure = publicError(error);
      if (dispatched || failure.actionMayHaveRun || !(error instanceof MobileUseError)) {
        throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
      }
      throw failure;
    }
  }

  async terminateApp(packageName: string, signal?: AbortSignal): Promise<AppOperationResult> {
    validatePackageName(packageName);
    const userId = await this.currentUser(signal);
    await this.requireInstalled(packageName, userId, signal);
    return this.appMutation(["shell", "am", "force-stop", "--user", String(userId), packageName], async (output) => {
      if (output.trim()) {
        throw new MobileUseError("APP_TERMINATE_FAILED", "Android did not confirm force-stop of the requested app.", "Check the app manually before repeating termination.");
      }
      const state = await this.command(["shell", "dumpsys", "package", packageName], signal ? { signal } : {});
      if (!parsePackageStopped(state.toString("utf8"), userId)) {
        throw new MobileUseError("APP_TERMINATE_FAILED", "The app is not marked stopped after force-stop.", "Check the app manually before repeating termination.");
      }
      return { status: "terminated", packageName, userId };
    }, signal);
  }

  async installApp(filePath: string, signal?: AbortSignal): Promise<AppOperationResult> {
    const apk = await localApkFile(filePath, signal);
    const userId = await this.currentUser(signal);
    return this.appMutation(["install", "--streaming", "--user", String(userId), apk], async (output) => {
      if (!/^(?:Performing Streamed Install\r?\n)?Success\s*$/.test(output.trim())) {
        throw new MobileUseError("APP_INSTALL_FAILED", "Android did not confirm the APK installation.", "Check the device's installed apps before considering another attempt. Do not bypass installation policy.");
      }
      return { status: "installed", packageName: null, userId };
    }, signal, 120_000);
  }

  async uninstallApp(packageName: string, signal?: AbortSignal): Promise<AppOperationResult> {
    validatePackageName(packageName);
    const userId = await this.currentUser(signal);
    await this.requireInstalled(packageName, userId, signal);
    return this.appMutation(["shell", "pm", "uninstall", "--user", String(userId), packageName], async (output) => {
      if (output.trim() !== "Success" ||
        (await this.appsForUser(userId, signal)).apps.some((app) => app.packageName === packageName)) {
        throw new MobileUseError("APP_UNINSTALL_FAILED", "Removal of the requested app was not confirmed.", "Check the current Android user's apps before considering another attempt.");
      }
      return { status: "uninstalled", packageName, userId };
    }, signal);
  }

  async launchApp(packageName: string, signal?: AbortSignal): Promise<number> {
    validatePackageName(packageName);
    const userId = await this.currentUser(signal);
    const options = signal ? { signal } : {};
    const resolved = (await this.command([
      "shell", "cmd", "package", "resolve-activity", "--brief", "--user", String(userId),
      "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", packageName,
    ], options)).toString("utf8");
    const components: string[] = [];
    for (const line of resolved.split("\n")) {
      const candidate = line.trim();
      const parts = candidate.split("/");
      if (parts.length === 2 && parts[0] === packageName && parts[1] &&
        /^\.?[A-Za-z0-9_.$]+$/.test(parts[1])) components.push(candidate);
    }
    const component = components.length === 1 ? components[0] : undefined;
    if (!component) {
      throw new MobileUseError("APP_NOT_FOUND", "No unique launcher was found for the requested installed app.", "Check the package name and current Android user; launching never installs an app.");
    }
    // Validated components cannot contain a single quote; quoting also preserves Java's $ names.
    const output = (await this.command(["shell", "am", "start", "-W", "--user", String(userId), "-n", `'${component}'`], {
      mutating: true, ...options,
    })).toString("utf8");
    if (!/^Status:\s*ok\s*$/m.test(output) || /^Error\b/m.test(output)) {
      throw new MobileUseError("APP_LAUNCH_FAILED", "Android did not confirm dispatch of the app launch.", "Observe the screen before attempting another launch.", false, true);
    }
    return userId;
  }
}
