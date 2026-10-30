import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseDeviceList } from "../src/adb.js";
import type { AdbConnection, MonitorFactory, RunOptions } from "../src/adb.js";
import { checkCancelled, MobileUseError } from "../src/errors.js";
import type { ErrorCode } from "../src/errors.js";
import type { AdbServerResult, DeviceEndpoint } from "../src/types.js";

export const USB = "POC_PHONE";
export const WIFI = "192.0.2.10:37891";
export const USB_LINE = `${USB} device usb:1-2 product:poc model:POC_Phone device:poc transport_id:7`;
export const WIFI_LINE = `${WIFI} device product:poc model:POC_Phone device:poc transport_id:12`;
export const INVENTORY = `List of devices attached\n${USB_LINE}\n${WIFI_LINE}\n`;

export function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([header, data, checksum]);
}

export function mp4(): Buffer {
  const box = (kind: string, data: string): Buffer => {
    const bytes = Buffer.alloc(8 + data.length);
    bytes.writeUInt32BE(bytes.length);
    bytes.write(kind, 4, "ascii");
    bytes.write(data, 8, "ascii");
    return bytes;
  };
  return Buffer.concat([box("ftyp", "isom0000"), box("mdat", "fixture-only"), box("moov", "fixture-only")]);
}

export function recorderHelp(unlimited: boolean, defaultSeconds = 180): string {
  return "Usage: screenrecord [options] <filename>\n\nAndroid screenrecord. Records the display to MP4.\n" +
    "--time-limit TIME\n    Set the maximum recording time, in seconds. " +
    (unlimited ? `Default is ${defaultSeconds}. Set to 0\n    to remove the time limit.\n`
      : `Default / maximum is ${defaultSeconds}.\n`) +
    "--verbose\n    Display information.\n";
}

export function png(width = 80, height = 160, shade = 8, filter = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, shade);
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = filter;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function pixelPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
  channels: 3 | 4 = 4,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = pixel(x, y);
      for (let channel = 0; channel < channels; channel++) {
        raw[y * (width * channels + 1) + 1 + x * channels + channel] = rgba[channel] ?? 0;
      }
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function xmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
    .replaceAll("\t", "&#9;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;");
}

export function node(overrides: Record<string, string> = {}, children = ""): string {
  const attributes = {
    class: "android.widget.Button", text: "Demo", "resource-id": "example.poc:id/demo",
    "content-desc": "", bounds: "[4,8][44,28]", enabled: "true", clickable: "true",
    focused: "false", password: "false", ...overrides,
  };
  return `<node ${Object.entries(attributes).map(([key, value]) => `${key}="${xmlAttribute(value)}"`).join(" ")}>${children}</node>`;
}

export function hierarchy(nodes = node(), rotation = 0): string {
  return `<?xml version="1.0"?><hierarchy rotation="${rotation}">${nodes}</hierarchy>\nUI hierarchy dumped to: /dev/tty\n`;
}

export function displayDiagnostics(rotation = 0, width = 80, height = 160): string {
  return "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n" +
    "  Display: mDisplayId=0 stacks=1\n" +
    `    init=80x160 320dpi cur=${width}x${height} app=${width}x${height} rng=80x80-160x160\n` +
    "  DisplayRotation\n" +
    "    mCurrentAppOrientation=SCREEN_ORIENTATION_UNSPECIFIED\n" +
    `    mRotation=${rotation} mDeferredRotationPauseCount=0\n` +
    "    mUserRotationMode=USER_ROTATION_FREE mUserRotation=0\n" +
    "  unrelated=true\n";
}

export function editField(overrides: Record<string, string> = {}): string {
  return node({
    class: "android.widget.EditText", text: "", "resource-id": "example.poc:id/text",
    bounds: "[4,32][76,56]", focused: "true", clickable: "true", ...overrides,
  });
}

export function textHash(text: string, showingHint = false): string {
  return createHash("sha256").update(Buffer.from([showingHint ? 1 : 0]))
    .update(Buffer.from(text, "utf16le").swap16()).digest("hex");
}

export function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.code, code);
    return true;
  };
}

export function keyguardPolicy(overrides: Record<string, string> = {}): string {
  const fields = {
    showing: "false", secure: "false", inputRestricted: "false",
    systemIsReady: "true", bootCompleted: "true", currentUser: "0",
    screenState: "SCREEN_STATE_ON", mIsShowing: "false", mSimSecure: "false",
    mInputRestricted: "false", mCurrentUserId: "0", ...overrides,
  };
  return "WINDOW MANAGER POLICY STATE (dumpsys window policy)\n  KeyguardServiceDelegate\n" +
    Object.entries(fields).filter(([name]) => !name.startsWith("m")).map(([name, value]) => `    ${name}=${value}`).join("\n") +
    "\n    KeyguardStateMonitor\n" +
    Object.entries(fields).filter(([name]) => name.startsWith("m")).map(([name, value]) => `      ${name}=${value}`).join("\n") +
    `\n    mCurrentUserId=${fields.mCurrentUserId}` +
    "\n  Looper state:\n    unrelated=true\n";
}

export interface AdbCall {
  args: readonly string[];
  options: RunOptions;
}

export class FakeAdb implements AdbConnection {
  inventory = INVENTORY;
  image = png();
  xml = hierarchy();
  display = displayDiagnostics();
  userId = 0;
  apps = new Set(["android", "example.poc"]);
  stoppedApps = new Set<string>();
  gestureFiles = new Map<string, Buffer>();
  foreground: string | null = "example.poc/.MainActivity";
  keyguard = {
    showing: false, secure: false, simSecure: false, inputRestricted: false,
    screenState: "SCREEN_STATE_ON", userId: 0,
  };
  properties: Record<string, string> = {
    "ro.build.version.sdk": "30", "ro.build.version.release": "11",
    "ro.serialno": USB, "ro.kernel.qemu": "0",
    "service.adb.tls.port": "37891", "persist.adb.tls_server.enable": "1",
  };
  calls: AdbCall[] = [];
  stopped = false;
  startServerCalls = 0;
  startupAttempted = true;
  startServerHandler: ((signal?: AbortSignal) => Promise<AdbServerResult>) | undefined;
  handler: ((call: AdbCall) => Promise<Buffer | undefined> | Buffer | undefined) | undefined;
  recordingBytes = mp4();
  recordingHelp = recorderHelp(true);
  recordingArgv: string[] | undefined;
  recordingExit: ((error?: MobileUseError) => void) | undefined;

  executable(): string { return "C:\\fixture-only\\adb.exe"; }

  async startServer(signal?: AbortSignal): Promise<AdbServerResult> {
    if (this.stopped) throw new MobileUseError("SERVER_STOPPED", "Fixture stopped.", "Start a new fixture.");
    checkCancelled(signal);
    this.startServerCalls++;
    if (this.startServerHandler) return this.startServerHandler(signal);
    return {
      status: "ready", serverAddress: "127.0.0.1:5037", startupAttempted: this.startupAttempted,
      devices: parseDeviceList(this.inventory),
    };
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
    if (this.stopped) throw new MobileUseError("SERVER_STOPPED", "Fixture stopped.", "Start a new fixture.");
    checkCancelled(options.signal);
    const call = { args: [...args], options };
    this.calls.push(call);
    const custom = await this.handler?.(call);
    if (custom !== undefined) return custom;
    if (args.join(" ") === "devices -l") return Buffer.from(this.inventory);
    if (args.join(" ") === "version") return Buffer.from("Android Debug Bridge version 1.0.41\nVersion 36.0.0-12345\n");
    assert.equal(args[0], "-t", "all device-bound fixture commands need an exact transport");
    assert.match(args[1] ?? "", /^\d+$/);
    const command = args.slice(2).join(" ");
    if (command === "shell /system/bin/screenrecord --help 2>&1") return Buffer.from(this.recordingHelp);
    if (command.startsWith("shell mkdir -m 700 /data/local/tmp/mobile-use-recording-")) return Buffer.alloc(0);
    if (command.startsWith("shell umask 077; echo $$ > /data/local/tmp/mobile-use-recording-")) {
      this.recordingArgv = (command.split("; exec ")[1] ?? "").split(" ");
      return new Promise<Buffer>((resolve, reject) => {
        const abort = (): void => {
          this.recordingExit?.(new MobileUseError("CANCELLED", "Fixture recording interrupted.", "Do not replay.", false, true));
        };
        this.recordingExit = (error) => {
          options.signal?.removeEventListener("abort", abort);
          this.recordingExit = undefined;
          if (error) reject(error);
          else resolve(Buffer.alloc(0));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
    if (command.startsWith("shell if [ -f /data/local/tmp/mobile-use-recording-")) return Buffer.from("12345\n");
    if (command.startsWith("shell if [ -r /proc/12345/cmdline ] && [ -f /data/local/tmp/mobile-use-recording-")) {
      return Buffer.from(`${this.recordingArgv?.join("\0")}\0`);
    }
    if (command.startsWith("shell if [ ! -e /proc/12345 ];")) {
      this.recordingExit?.();
      return Buffer.from("STOPPED\n");
    }
    if (command.startsWith("shell stat -c %s /data/local/tmp/mobile-use-recording-")) {
      return Buffer.from(`${this.recordingBytes.length}\n`);
    }
    if (args[2] === "pull" && args[3]?.startsWith("/data/local/tmp/mobile-use-recording-")) {
      await writeFile(args[4] ?? "", this.recordingBytes);
      return Buffer.from("1 file pulled\n");
    }
    if (command.startsWith("shell rm -f /data/local/tmp/mobile-use-recording-")) return Buffer.alloc(0);
    if (args[2] === "push") {
      this.gestureFiles.set(args[4] ?? "", await readFile(args[3] ?? ""));
      return Buffer.from("1 file pushed\n");
    }
    if (command.startsWith("shell mkdir -m 700 /data/local/tmp/mobile-use-gestures-") ||
      command.startsWith("shell chmod 400 /data/local/tmp/mobile-use-gestures-") ||
      command.startsWith("shell mkdir -m 700 /data/local/tmp/mobile-use-text-") ||
      command.startsWith("shell chmod 400 /data/local/tmp/mobile-use-text-")) return Buffer.alloc(0);
    if (command.startsWith("shell sha256sum /data/local/tmp/mobile-use-gestures-") ||
      command.startsWith("shell sha256sum /data/local/tmp/mobile-use-text-")) {
      const file = args[4] ?? "";
      const bytes = this.gestureFiles.get(file);
      if (!bytes) throw new MobileUseError("ADB_FAILED", "Fixture helper missing.", "Prepare again.");
      return Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}  ${file}\n`);
    }
    if (args[3]?.startsWith("CLASSPATH=") && args[4] === "app_process") {
      if (args[6] === "dev.mobileuse.text.TextMain") {
        if (args[7] === "--dump") return Buffer.from(this.xml.replace(/<node ([^>]+)>/g, (node: string, attributes: string) => {
          if (!attributes.includes('class="android.widget.EditText"')) return node;
          if (!attributes.includes('window-identity="')) node = node.replace(">", ` window-identity="abc:u${this.userId}">`);
          if (attributes.includes('password="true"') || attributes.includes('text-sha256="')) return node;
          const value = /text="([^"]*)"/.exec(attributes)?.[1] ?? "";
          const decoded = value.replaceAll("&#9;", "\t").replaceAll("&#10;", "\n").replaceAll("&#13;", "\r")
            .replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&amp;", "&");
          return node.replace(">", ` text-sha256="${textHash(decoded)}">`);
        }));
        return Buffer.from(args.at(-1) === "--check" ? "MOBILE_USE_TEXT_V1_READY\n" : "MOBILE_USE_TEXT_V1_OK\n");
      }
      if (args.at(-1) === "--check") return Buffer.from("MOBILE_USE_GESTURES_V1_READY\n");
      return Buffer.from(`MOBILE_USE_DOUBLE_TAP_V1 ${args.at(-1)}\n`);
    }
    if (command === "shell am get-current-user") return Buffer.from(`${this.userId}\n`);
    if (command.startsWith("shell pm list packages --user ")) {
      return Buffer.from([...this.apps].map((name) => `package:${name}\n`).join(""));
    }
    if (command === "shell dumpsys activity activities") {
      const activity = this.foreground ? `ActivityRecord{abc u${this.userId} ${this.foreground} t1}` : "null";
      return Buffer.from(`ACTIVITY MANAGER ACTIVITIES\nDisplay #0 (activities from top to bottom):\n  topResumedActivity=${activity}\n`);
    }
    if (command.startsWith("shell am force-stop --user ")) {
      const name = args.at(-1) ?? "";
      this.stoppedApps.add(name);
      if (this.foreground?.startsWith(`${name}/`)) this.foreground = null;
      return Buffer.alloc(0);
    }
    if (command.startsWith("shell dumpsys package ")) {
      return Buffer.from(`  User ${this.userId}: installed=true stopped=${this.stoppedApps.has(args.at(-1) ?? "")}\n`);
    }
    if (command.startsWith("shell pm uninstall --user ")) {
      this.apps.delete(args.at(-1) ?? "");
      return Buffer.from("Success\n");
    }
    if (args[2] === "install") {
      this.apps.add("example.installed");
      return Buffer.from("Performing Streamed Install\nSuccess\n");
    }
    if (command.startsWith("shell getprop ")) return Buffer.from(this.properties[args[4] ?? ""] ?? "");
    if (command === "exec-out screencap -p") return this.image;
    if (command === "shell -tt uiautomator dump /dev/tty") return Buffer.from(this.xml);
    if (command === "shell dumpsys window displays") return Buffer.from(this.display);
    if (command === "shell dumpsys window policy") {
      return Buffer.from(keyguardPolicy({
        showing: String(this.keyguard.showing), mIsShowing: String(this.keyguard.showing),
        secure: String(this.keyguard.secure), mSimSecure: String(this.keyguard.simSecure),
        inputRestricted: String(this.keyguard.inputRestricted), mInputRestricted: String(this.keyguard.inputRestricted),
        screenState: this.keyguard.screenState,
        currentUser: String(this.keyguard.userId), mCurrentUserId: String(this.keyguard.userId),
      }));
    }
    if (command === "shell input keyevent 224") this.keyguard.screenState = "SCREEN_STATE_ON";
    if (command === "shell wm dismiss-keyguard") {
      assert.equal(this.keyguard.secure || this.keyguard.simSecure, false, "a secure keyguard must never be dismissed");
      this.keyguard.showing = false;
      this.keyguard.inputRestricted = false;
      return Buffer.alloc(0);
    }
    if (command.startsWith("shell input ")) return Buffer.alloc(0);
    if (command.startsWith("shell cmd package resolve-activity ")) return Buffer.from("example.poc/.MainActivity\n");
    if (command.startsWith("shell am start -W ")) {
      this.foreground = "example.poc/.MainActivity";
      return Buffer.from("Status: ok\nActivity: example.poc/.MainActivity\n");
    }
    throw new Error(`Unexpected fixture command: ${command}`);
  }

  get inputs(): AdbCall[] {
    return this.calls.filter((call) => call.options.mutating &&
      call.args[2] !== "push" && !["mkdir", "chmod"].includes(call.args[3] ?? "") &&
      call.args.at(-1) !== "--check");
  }
  stop(): void { this.stopped = true; }
}

interface MonitorSession {
  closed: boolean;
  onInventory: (inventory: DeviceEndpoint[]) => void;
  onLost: () => void;
  close: () => void;
}

export class FakeMonitors {
  sessions: MonitorSession[] = [];

  constructor(private readonly adb: FakeAdb) {}

  readonly factory: MonitorFactory = async (onInventory, onLost, signal) => {
    checkCancelled(signal);
    const session: MonitorSession = {
      closed: false, onInventory, onLost,
      close: () => {
        session.closed = true;
        signal.removeEventListener("abort", abort);
      },
    };
    const abort = (): void => {
      if (!session.closed) {
        session.close();
        onLost();
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    this.sessions.push(session);
    return { initial: parseDeviceList(this.adb.inventory), close: session.close };
  };

  emit(inventory: string): void {
    this.adb.inventory = inventory;
    for (const session of this.sessions) {
      if (!session.closed) session.onInventory(parseDeviceList(inventory));
    }
  }

  disconnect(): void {
    for (const session of this.sessions) {
      if (!session.closed) {
        session.close();
        session.onLost();
      }
    }
  }
}
