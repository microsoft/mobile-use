import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import { MobileUseError } from "../errors.js";
import { MuxConnection, usbFailure, writeMuxMessage, type UsbBackend } from "./usb.js";

const requestSchema = z.discriminatedUnion("MessageType", [
  z.object({ MessageType: z.literal("ListDevices") }),
  z.object({ MessageType: z.literal("ReadBUID") }),
  z.object({ MessageType: z.literal("ReadPairRecord"), PairRecordID: z.string() }),
  z.object({ MessageType: z.literal("Connect"), DeviceID: z.literal(1), PortNumber: z.number().int().min(1).max(65535) }),
]);

export class NativeUsbBridge {
  private readonly sockets = new Set<Socket>();
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;

  private constructor(private readonly server: Server, private readonly backend: UsbBackend,
    private readonly udid: string, private readonly report: (error: unknown) => void) {}

  static async start(backend: UsbBackend, udid: string, report: (error: unknown) => void): Promise<NativeUsbBridge> {
    const server = createServer();
    const bridge = new NativeUsbBridge(server, backend, udid, report);
    server.on("connection", (socket) => { void bridge.handle(socket); });
    await new Promise<void>((resolve, reject) => {
      const failed = () => { server.close(); reject(usbFailure("IOS_USB_UNAVAILABLE")); };
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", failed);
        server.on("error", report);
        resolve();
      });
    });
    return bridge;
  }

  get address(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw usbFailure("IOS_USB_UNAVAILABLE");
    return `tcp://127.0.0.1:${address.port}`;
  }

  private track(socket: Socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  private async handle(client: Socket): Promise<void> {
    this.track(client);
    const controller = new AbortController();
    client.once("close", () => controller.abort());
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    const mux = new MuxConnection(client);
    let dispatching = false;
    try {
      while (!signal.aborted) {
        const { tag, value } = await mux.receive(undefined, signal);
        dispatching = true;
        const request = requestSchema.safeParse(value);
        if (!request.success) throw usbFailure("IOS_USB_UNAVAILABLE");
        const command = request.data;
        if (command.MessageType === "ListDevices") {
          const present = (await this.backend.list(signal)).some((device) => device.udid === this.udid);
          // Synthetic ID: every Connect resolves the approved USB UDID afresh, never a caller's native DeviceID.
          writeMuxMessage(client, { DeviceList: present
            ? [{ DeviceID: 1, MessageType: "Attached", Properties: { DeviceID: 1, SerialNumber: this.udid, ConnectionType: "USB" } }]
            : [] }, tag);
        } else if (command.MessageType === "ReadBUID") {
          writeMuxMessage(client, { BUID: await this.backend.readBuid(signal) }, tag);
        } else if (command.MessageType === "ReadPairRecord") {
          if (command.PairRecordID !== this.udid) throw usbFailure("IOS_USB_UNAVAILABLE");
          writeMuxMessage(client, { PairRecordData: await this.backend.readPairRecord(this.udid, signal) }, tag);
        } else {
          const port = ((command.PortNumber & 0xff) << 8) | ((command.PortNumber >>> 8) & 0xff);
          let device: Socket;
          try { device = await this.backend.connect(this.udid, port, signal); }
          catch (error) {
            if (!(error instanceof MobileUseError) || error.code !== "WDA_UNAVAILABLE") throw error;
            writeMuxMessage(client, { MessageType: "Result", Number: 3 }, tag);
            dispatching = false;
            continue;
          }
          if (signal.aborted || client.destroyed) { device.destroy(); return; }
          this.track(device);
          client.once("close", () => device.destroy());
          device.once("close", () => client.destroy());
          writeMuxMessage(client, { MessageType: "Result", Number: 0 }, tag);
          client.pipe(device).pipe(client);
          client.resume();
          return;
        }
        dispatching = false;
      }
    } catch (error) {
      if (dispatching && !signal.aborted) this.report(error);
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
