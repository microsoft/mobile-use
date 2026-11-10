import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import test from "node:test";
import { once } from "node:events";
import * as plist from "plist";
import { AppleUsbBackend, MuxConnection, parseUsbDevices, usbMuxEndpoint } from "../src/ios/usb.js";
import { IOS_UDID } from "./ios-runtime-fixture.js";

function frame(value: plist.PlistValue, tag: number): Buffer {
  const body = Buffer.from(plist.build(value));
  const header = Buffer.alloc(16);
  header.writeUInt32LE(body.length + 16);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(8, 8);
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, body]);
}

test("USB inventory filters Wi-Fi and rejects missing IDs and duplicate physical targets", () => {
  const usb = { DeviceID: 7, Properties: { SerialNumber: IOS_UDID, ConnectionType: "USB" } };
  const wifi = { DeviceID: 8, Properties: { SerialNumber: IOS_UDID, ConnectionType: "Network" } };
  assert.deepEqual(parseUsbDevices([usb, wifi]), [{ udid: IOS_UDID, deviceId: 7 }]);
  for (const invalid of [[usb, usb], [{ Properties: usb.Properties }]]) {
    assert.throws(() => parseUsbDevices(invalid), { code: "INVALID_DEVICE_LIST" });
  }
  assert.deepEqual(usbMuxEndpoint("win32"), { host: "127.0.0.1", port: 27015 });
  assert.deepEqual(usbMuxEndpoint("darwin"), { path: "/var/run/usbmuxd" });
});

test("usbmux handles fragmented frames, preserves raw connection bytes and rejects mismatched tags", async (t) => {
  for (const badTag of [false, true]) {
    const server = createServer((socket) => {
      socket.once("data", (request: Buffer) => {
        const tag = request.readUInt32LE(12);
        const reply = frame({ MessageType: "Result", Number: 0 }, badTag ? tag + 1 : tag);
        socket.write(reply.subarray(0, 7));
        socket.write(Buffer.concat([reply.subarray(7), Buffer.from("raw-wda")]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const socket = createConnection(address.port, "127.0.0.1");
    await once(socket, "connect");
    t.after(() => { socket.destroy(); server.close(); });
    const mux = new MuxConnection(socket, 500);
    if (badTag) await assert.rejects(mux.request({ MessageType: "Connect" }), { code: "IOS_USB_UNAVAILABLE" });
    else {
      assert.deepEqual(await mux.request({ MessageType: "Connect" }), { MessageType: "Result", Number: 0 });
      const remaining = await new Promise<Buffer>((resolve) => { socket.once("data", resolve); socket.resume(); });
      assert.equal(remaining.toString(), "raw-wda");
    }
  }
});

test("each USB connection re-enumerates the selected UDID, uses current DeviceID and swaps port byte order", async (t) => {
  let deviceId = 1;
  let resultCode = 0;
  const connections: Array<{ DeviceID: number; PortNumber: number }> = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 16 && pending.length >= pending.readUInt32LE(0)) {
        const length = pending.readUInt32LE(0);
        const tag = pending.readUInt32LE(12);
        const request = plist.parse(pending.subarray(16, length).toString("utf8"));
        pending = pending.subarray(length);
        assert.ok(typeof request === "object" && request !== null && !Array.isArray(request) && "MessageType" in request);
        if (request.MessageType === "ListDevices") {
          socket.write(frame({ DeviceList: [{ DeviceID: deviceId, Properties: { SerialNumber: IOS_UDID, ConnectionType: "USB" } }] }, tag));
        } else {
          assert.ok("DeviceID" in request && "PortNumber" in request);
          assert.equal(typeof request.DeviceID, "number");
          assert.equal(typeof request.PortNumber, "number");
          if (typeof request.DeviceID === "number" && typeof request.PortNumber === "number") {
            connections.push({ DeviceID: request.DeviceID, PortNumber: request.PortNumber });
          }
          socket.write(frame({ MessageType: "Result", Number: resultCode }, tag));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const backend = new AppleUsbBackend(async () => {
    const socket = createConnection(address.port, "127.0.0.1");
    await once(socket, "connect");
    return socket;
  });
  assert.deepEqual(await backend.list(), [{ udid: IOS_UDID, deviceId: 1 }]);
  (await backend.connect(IOS_UDID, 8100)).destroy();
  deviceId = 99;
  (await backend.connect(IOS_UDID, 8100)).destroy();
  assert.deepEqual(connections, [{ DeviceID: 1, PortNumber: 42015 }, { DeviceID: 99, PortNumber: 42015 }]);
  resultCode = 3;
  await assert.rejects(backend.connect(IOS_UDID, 8100), { code: "WDA_UNAVAILABLE" });
  resultCode = 2;
  await assert.rejects(backend.connect(IOS_UDID, 8100), { code: "IOS_USB_UNAVAILABLE" });
});

test("cancelling a usbmux request closes its pending socket without claiming a device reply", async (t) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("data", () => {}); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = createConnection(address.port, "127.0.0.1");
  await once(socket, "connect");
  t.after(async () => {
    socket.destroy();
    for (const connection of sockets) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const controller = new AbortController();
  const pending = new MuxConnection(socket).request({ MessageType: "ListDevices" }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(socket.destroyed, true);
});
