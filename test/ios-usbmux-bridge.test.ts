import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { MobileUseError } from "../src/errors.js";
import { AppleUsbBackend, MuxConnection, writeMuxMessage } from "../src/ios/usb.js";
import { NativeUsbBridge } from "../src/ios/usbmux-bridge.js";
import { IOS_OTHER_UDID, IOS_UDID } from "./ios-runtime-fixture.js";

async function fixture(t: TestContext) {
  const sockets = new Set<Socket>();
  const state = { connected: true, deviceId: 7, connectResult: 0, listHook: undefined as (() => Promise<void>) | undefined };
  const connections: Array<{ deviceId: number; port: number }> = [];
  const pairReads: string[] = [];
  const failures: unknown[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    void (async () => {
      const mux = new MuxConnection(socket);
      for (;;) {
        const { tag, value } = await mux.receive();
        assert.ok(value && typeof value === "object" && !Array.isArray(value) && "MessageType" in value);
        if (value.MessageType === "ListDevices") {
          await state.listHook?.();
          writeMuxMessage(socket, { DeviceList: [
            { DeviceID: 9, Properties: { SerialNumber: IOS_UDID, ConnectionType: "Network" } },
            { DeviceID: 8, Properties: { SerialNumber: IOS_OTHER_UDID, ConnectionType: "USB" } },
            ...(state.connected
              ? [{ DeviceID: state.deviceId, Properties: { SerialNumber: IOS_UDID, ConnectionType: "USB" } }] : []),
          ] }, tag);
        } else if (value.MessageType === "ReadBUID") {
          writeMuxMessage(socket, { BUID: "fixture-buid" }, tag);
        } else if (value.MessageType === "ReadPairRecord") {
          assert.ok("PairRecordID" in value && typeof value.PairRecordID === "string");
          pairReads.push(value.PairRecordID);
          writeMuxMessage(socket, { PairRecordData: Buffer.from("fixture-private-pair-record") }, tag);
        } else {
          assert.equal(value.MessageType, "Connect");
          assert.ok("DeviceID" in value && typeof value.DeviceID === "number");
          assert.ok("PortNumber" in value && typeof value.PortNumber === "number");
          connections.push({ deviceId: value.DeviceID, port: value.PortNumber });
          writeMuxMessage(socket, { MessageType: "Result", Number: state.connectResult }, tag);
          if (state.connectResult !== 0) continue;
          socket.write("device-stream");
          socket.on("data", (chunk: Buffer) => socket.write(chunk));
          socket.resume();
          return;
        }
      }
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const backend = new AppleUsbBackend(async () => {
    const socket = createConnection(address.port, "127.0.0.1");
    await once(socket, "connect");
    return socket;
  });
  const bridge = await NativeUsbBridge.start(backend, IOS_UDID, (error) => failures.push(error));
  t.after(async () => {
    await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = async () => {
    const socket = createConnection(Number(new URL(bridge.address).port), "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    t.after(() => socket.destroy());
    return new MuxConnection(socket);
  };
  return { bridge, state, connections, pairReads, failures, client };
}

test("native usbmux exposes only the approved USB UDID and maps every Connect to its current USB transport", async (t) => {
  const f = await fixture(t);
  for (const deviceId of [7, 42]) {
    f.state.deviceId = deviceId;
    const mux = await f.client();
    assert.deepEqual(await mux.request({ MessageType: "ListDevices" }), { DeviceList: [{
      DeviceID: 1, MessageType: "Attached", Properties: { DeviceID: 1, SerialNumber: IOS_UDID, ConnectionType: "USB" },
    }] });
    assert.deepEqual(await mux.request({ MessageType: "ReadBUID" }), { BUID: "fixture-buid" });
    assert.deepEqual(await mux.request({ MessageType: "ReadPairRecord", PairRecordID: IOS_UDID }),
      { PairRecordData: new Uint8Array(Buffer.from("fixture-private-pair-record")) });
    assert.deepEqual(await mux.request({ MessageType: "Connect", DeviceID: 1, PortNumber: 42015 }),
      { MessageType: "Result", Number: 0 });
    const bytes = new Promise<Buffer>((resolve) => mux.socket.once("data", resolve));
    mux.socket.resume();
    assert.equal((await bytes).toString(), "device-stream");
    const echoed = new Promise<Buffer>((resolve) => mux.socket.once("data", resolve));
    mux.socket.write("lockdown-bytes");
    assert.equal((await echoed).toString(), "lockdown-bytes");
    mux.socket.destroy();
  }
  assert.deepEqual(f.connections, [{ deviceId: 7, port: 42015 }, { deviceId: 42, port: 42015 }]);
  assert.deepEqual(f.pairReads, [IOS_UDID, IOS_UDID]);
  assert.deepEqual(f.failures, []);
});

test("a cached native target cannot fall back to Wi-Fi after USB disconnects", async (t) => {
  const f = await fixture(t);
  const mux = await f.client();
  await mux.request({ MessageType: "ListDevices" });
  f.state.connected = false;
  assert.deepEqual(await mux.request({ MessageType: "ListDevices" }), { DeviceList: [] });
  await assert.rejects(mux.request({ MessageType: "Connect", DeviceID: 1, PortNumber: 42015 }), { code: "IOS_USB_UNAVAILABLE" });
  assert.deepEqual(f.connections, []);
  assert.ok(f.failures.some((error) => error instanceof MobileUseError && error.code === "DEVICE_NOT_FOUND"));
});

test("native connection refusal remains a usbmux result rather than poisoning runtime ownership", async (t) => {
  const f = await fixture(t);
  f.state.connectResult = 3;
  const mux = await f.client();
  assert.deepEqual(await mux.request({ MessageType: "Connect", DeviceID: 1, PortNumber: 42015 }),
    { MessageType: "Result", Number: 3 });
  assert.deepEqual(await mux.request({ MessageType: "ReadBUID" }), { BUID: "fixture-buid" });
  assert.deepEqual(f.connections, [{ deviceId: 7, port: 42015 }]);
  assert.deepEqual(f.failures, []);
});

test("native usbmux rejects foreign IDs, foreign pairing records and automatic pairing commands", async (t) => {
  const f = await fixture(t);
  for (const request of [
    { MessageType: "Connect", DeviceID: 9, PortNumber: 42015 },
    { MessageType: "ReadPairRecord", PairRecordID: IOS_OTHER_UDID },
    { MessageType: "SavePairRecord", PairRecordID: IOS_UDID },
  ]) {
    const mux = await f.client();
    await assert.rejects(mux.request(request), { code: "IOS_USB_UNAVAILABLE" });
  }
  assert.deepEqual(f.connections, []);
  assert.deepEqual(f.pairReads, []);
  assert.equal(f.failures.length, 3);
});

test("closing the native bridge aborts pending inventory and closes its owned client", async (t) => {
  const f = await fixture(t);
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  f.state.listHook = async () => { entered?.(); await blocked; };
  const mux = await f.client();
  const pending = assert.rejects(mux.request({ MessageType: "ListDevices" }), { code: "IOS_USB_UNAVAILABLE" });
  try {
    await waiting;
    await f.bridge.close();
    await pending;
    assert.equal(mux.socket.destroyed, true);
    assert.deepEqual(f.failures, []);
  } finally { release?.(); }
});
