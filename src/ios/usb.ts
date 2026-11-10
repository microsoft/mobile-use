import { createConnection, createServer, type Server, type Socket } from "node:net";
import * as plist from "plist";
import { z } from "zod";
import { checkCancelled, MobileUseError } from "../errors.js";

export const udidSchema = z.string().regex(/^[a-fA-F0-9-]{8,80}$/);
export interface UsbDevice { udid: string; deviceId: number }
export interface UsbBackend {
  list(signal?: AbortSignal): Promise<UsbDevice[]>;
  connect(udid: string, port: number, signal?: AbortSignal): Promise<Socket>;
}

export function usbFailure(code: "IOS_USB_UNAVAILABLE" | "DEVICE_NOT_FOUND" | "INVALID_DEVICE_LIST" | "WDA_UNAVAILABLE") {
  return new MobileUseError(code, "The selected iOS USB connection could not be verified.",
    "Check the Apple USB service, cable and manual device trust. No Wi-Fi fallback or automatic pairing is performed.");
}

export function usbMuxEndpoint(platform: NodeJS.Platform = process.platform): { path: string } | { host: string; port: number } {
  if (platform === "win32") return { host: "127.0.0.1", port: 27015 };
  if (platform === "darwin") return { path: "/var/run/usbmuxd" };
  throw new MobileUseError("UNSUPPORTED_HOST", "Managed iOS USB requires Windows or macOS.",
    "Use an external local WDA endpoint on another host.");
}

export class MuxConnection {
  private tag = 0;
  constructor(readonly socket: Socket, private readonly timeoutMs = 5000) { socket.pause(); }

  request(message: Record<string, string | number>, signal?: AbortSignal): Promise<unknown> {
    checkCancelled(signal);
    const body = Buffer.from(plist.build({ ProgName: "mobile-use", ClientVersionString: "mobile-use-0.1", ...message }));
    const header = Buffer.alloc(16);
    const tag = ++this.tag;
    header.writeUInt32LE(body.length + 16, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(8, 8);
    header.writeUInt32LE(tag, 12);
    return new Promise((resolve, reject) => {
      let received: Buffer = Buffer.alloc(0);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.pause();
        this.socket.off("data", data);
        this.socket.off("error", fail);
        this.socket.off("close", closed);
        signal?.removeEventListener("abort", aborted);
      };
      const fail = (error: Error) => { cleanup(); this.socket.destroy(); reject(error); };
      const closed = () => fail(usbFailure("IOS_USB_UNAVAILABLE"));
      const aborted = () => {
        try { checkCancelled(signal); } catch (error) {
          cleanup(); this.socket.destroy(); reject(error);
        }
      };
      const data = (chunk: Buffer) => {
        if (received.length + chunk.length > 8 * 1024 * 1024 + 65536) {
          fail(usbFailure("IOS_USB_UNAVAILABLE")); return;
        }
        received = Buffer.concat([received, chunk]);
        if (received.length < 16) return;
        const length = received.readUInt32LE(0);
        if (length < 16 || length > 8 * 1024 * 1024 || received.readUInt32LE(4) !== 1 ||
          received.readUInt32LE(8) !== 8 || received.readUInt32LE(12) !== tag) {
          fail(usbFailure("IOS_USB_UNAVAILABLE")); return;
        }
        if (received.length < length) return;
        let value: unknown;
        try {
          const xml = received.subarray(16, length).toString("utf8");
          if (/<!ENTITY/i.test(xml)) throw usbFailure("IOS_USB_UNAVAILABLE");
          value = plist.parse(xml);
        } catch {
          fail(usbFailure("IOS_USB_UNAVAILABLE")); return;
        }
        cleanup();
        if (received.length > length) this.socket.unshift(received.subarray(length));
        resolve(value);
      };
      const timer = setTimeout(closed, this.timeoutMs);
      this.socket.on("data", data);
      this.socket.once("error", fail);
      this.socket.once("close", closed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      this.socket.resume();
      this.socket.write(Buffer.concat([header, body]));
    });
  }
}

async function openMux(signal?: AbortSignal): Promise<Socket> {
  checkCancelled(signal);
  const socket = createConnection(usbMuxEndpoint());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const failed = () => { cleanup(); socket.destroy(); reject(usbFailure("IOS_USB_UNAVAILABLE")); };
    const connected = () => { cleanup(); resolve(socket); };
    const aborted = () => {
      cleanup(); socket.destroy();
      try { checkCancelled(signal); } catch (error) { reject(error); }
    };
    const timer = setTimeout(failed, 5000);
    socket.once("connect", connected);
    socket.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export function parseUsbDevices(value: unknown): UsbDevice[] {
  const parsed = z.array(z.object({
    DeviceID: z.number().int().positive().max(0xffffffff).optional(),
    Properties: z.object({
      SerialNumber: z.string(), ConnectionType: z.string(),
      DeviceID: z.number().int().positive().max(0xffffffff).optional(),
    }),
  })).safeParse(value);
  if (!parsed.success) throw usbFailure("INVALID_DEVICE_LIST");
  const devices = parsed.data.filter((entry) => entry.Properties.ConnectionType === "USB").map((entry) => {
    const udid = udidSchema.safeParse(entry.Properties.SerialNumber);
    const deviceId = entry.DeviceID ?? entry.Properties.DeviceID;
    if (!udid.success || deviceId === undefined) throw usbFailure("INVALID_DEVICE_LIST");
    return { udid: udid.data, deviceId };
  });
  if (new Set(devices.map((entry) => entry.udid)).size !== devices.length ||
    new Set(devices.map((entry) => entry.deviceId)).size !== devices.length) throw usbFailure("INVALID_DEVICE_LIST");
  return devices;
}

export class AppleUsbBackend implements UsbBackend {
  constructor(private readonly open: (signal?: AbortSignal) => Promise<Socket> = openMux) {}

  async list(signal?: AbortSignal): Promise<UsbDevice[]> {
    const mux = new MuxConnection(await this.open(signal));
    try {
      const reply = z.object({ DeviceList: z.unknown() }).safeParse(await mux.request({ MessageType: "ListDevices" }, signal));
      if (!reply.success) throw usbFailure("INVALID_DEVICE_LIST");
      return parseUsbDevices(reply.data.DeviceList);
    } finally { mux.socket.destroy(); }
  }

  async connect(udid: string, port: number, signal?: AbortSignal): Promise<Socket> {
    const mux = new MuxConnection(await this.open(signal));
    try {
      const reply = z.object({ DeviceList: z.unknown() }).safeParse(await mux.request({ MessageType: "ListDevices" }, signal));
      if (!reply.success) throw usbFailure("INVALID_DEVICE_LIST");
      const device = parseUsbDevices(reply.data.DeviceList).find((entry) => entry.udid === udid);
      if (!device) throw usbFailure("DEVICE_NOT_FOUND");
      const connected = z.object({ MessageType: z.literal("Result"), Number: z.number().int() }).safeParse(
        await mux.request({ MessageType: "Connect", DeviceID: device.deviceId,
          PortNumber: ((port & 0xff) << 8) | ((port >>> 8) & 0xff) }, signal));
      if (!connected.success) throw usbFailure("IOS_USB_UNAVAILABLE");
      if (connected.data.Number === 3) throw usbFailure("WDA_UNAVAILABLE");
      if (connected.data.Number !== 0) throw usbFailure("IOS_USB_UNAVAILABLE");
      return mux.socket;
    } catch (error) { mux.socket.destroy(); throw error; }
  }
}

export class UsbProxy {
  private readonly sockets = new Set<Socket>();
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;
  private constructor(private readonly server: Server, private readonly backend: UsbBackend,
    private readonly udid: string, private readonly devicePort: number,
    private readonly report: (error: unknown) => void) {}

  static async start(backend: UsbBackend, udid: string, devicePort: number, report: (error: unknown) => void): Promise<UsbProxy> {
    const server = createServer();
    const proxy = new UsbProxy(server, backend, udid, devicePort, report);
    server.on("connection", (socket) => { void proxy.pipe(socket); });
    await new Promise<void>((resolve, reject) => {
      const failed = () => { server.close(); reject(usbFailure("IOS_USB_UNAVAILABLE")); };
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", failed);
        server.on("error", report);
        resolve();
      });
    });
    return proxy;
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw usbFailure("IOS_USB_UNAVAILABLE");
    return `http://127.0.0.1:${address.port}`;
  }

  private track(socket: Socket, reportError: () => boolean) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => {
      if (!this.closing && reportError()) this.report(usbFailure("IOS_USB_UNAVAILABLE"));
      socket.destroy();
    });
  }

  private async pipe(client: Socket): Promise<void> {
    this.track(client, () => false);
    client.pause();
    try {
      const device = await this.backend.connect(this.udid, this.devicePort, this.lifetime.signal);
      if (this.closing || client.destroyed) { device.destroy(); return; }
      this.track(device, () => !client.destroyed);
      client.once("close", () => device.destroy());
      device.once("close", () => client.destroy());
      client.pipe(device).pipe(client);
      client.resume();
    } catch (error) {
      if (!this.closing) this.report(error);
      client.destroy();
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort();
      for (const socket of this.sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(usbFailure("IOS_USB_UNAVAILABLE")) : resolve());
      });
    })();
    return this.closing;
  }
}
