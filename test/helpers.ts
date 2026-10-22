import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { parseDeviceList } from "../src/adb.js";
import type { AdbConnection, MonitorFactory, RunOptions } from "../src/adb.js";
import { checkCancelled, MobileUseError } from "../src/errors.js";
import type { ErrorCode } from "../src/errors.js";
import type { DeviceEndpoint } from "../src/types.js";

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

function xmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
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

export function editField(overrides: Record<string, string> = {}): string {
  return node({
    class: "android.widget.EditText", text: "", "resource-id": "example.poc:id/text",
    bounds: "[4,32][76,56]", focused: "true", clickable: "true", ...overrides,
  });
}

export function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.code, code);
    return true;
  };
}

export interface AdbCall {
  args: readonly string[];
  options: RunOptions;
}

export class FakeAdb implements AdbConnection {
  inventory = INVENTORY;
  image = png();
  xml = hierarchy();
  size = "Physical size: 80x160\n";
  properties: Record<string, string> = {
    "ro.build.version.sdk": "30", "ro.build.version.release": "11",
    "ro.serialno": USB, "ro.kernel.qemu": "0",
    "service.adb.tls.port": "37891", "persist.adb.tls_server.enable": "1",
  };
  calls: AdbCall[] = [];
  stopped = false;
  handler: ((call: AdbCall) => Promise<Buffer | undefined> | Buffer | undefined) | undefined;

  executable(): string { return "C:\\fixture-only\\adb.exe"; }

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
    if (command.startsWith("shell getprop ")) return Buffer.from(this.properties[args[4] ?? ""] ?? "");
    if (command === "exec-out screencap -p") return this.image;
    if (command === "shell -tt uiautomator dump /dev/tty") return Buffer.from(this.xml);
    if (command === "shell wm size") return Buffer.from(this.size);
    if (command.startsWith("shell input ")) return Buffer.alloc(0);
    if (command.startsWith("shell cmd package resolve-activity ")) return Buffer.from("example.poc/.MainActivity\n");
    if (command.startsWith("shell am start -W -n ")) return Buffer.from("Status: ok\nActivity: example.poc/.MainActivity\n");
    throw new Error(`Unexpected fixture command: ${command}`);
  }

  get inputs(): AdbCall[] { return this.calls.filter((call) => call.options.mutating); }
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
