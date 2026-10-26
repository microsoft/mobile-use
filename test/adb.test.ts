import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { AdbClient, AdbTrackParser, createTransportMonitor, executeCommand, parseDeviceList, resolveAdbExecutable } from "../src/adb.js";
import type { CommandOptions, TransportMonitor } from "../src/adb.js";
import { LocalAdbServer } from "../src/adb-server.js";
import { MobileUseError } from "../src/errors.js";
import type { DeviceEndpoint } from "../src/types.js";
import { hasCode, INVENTORY, USB_LINE } from "./helpers.js";

test("inventory preserves complete states and never hides unsupported endpoints", () => {
  const devices = parseDeviceList(INVENTORY + "LOCKED unauthorized transport_id:19\nOFF offline transport_id:20\nemulator-5554 device transport_id:21\nOLD device\n");
  assert.deepEqual(devices.map((device) => device.kind), ["usb", "network", "usb", "usb", "emulator", "usb"]);
  assert.equal(devices[0]?.transportId, "7");
  assert.equal(devices[0]?.model, "POC Phone");
  assert.ok(devices.slice(2).every((device) => !device.selectable));
  assert.deepEqual(parseDeviceList("List of devices attached\r\n\r\n"), []);
  for (const malformed of [
    "", "* daemon failed to start *", "List of devices attached\nonly-a-serial\n",
    INVENTORY + USB_LINE, "List of devices attached\nA device transport_id:7\nB device transport_id:7\n",
  ]) assert.throws(() => parseDeviceList(malformed), hasCode("INVALID_DEVICE_LIST"));
});

test("only ADB's final transport field determines routing, not product/device metadata", () => {
  const devices = parseDeviceList("List of devices attached\nPOC_PHONE device usb:1-2 product:transport_id:0 device:transport_id:81 model:POC_Phone transport_id:7\n");
  assert.equal(devices[0]?.transportId, "7");
  assert.equal(devices[0]?.model, "POC Phone");
  assert.equal(devices[0]?.selectable, true);
  const metadataOnly = parseDeviceList("List of devices attached\nPOC_PHONE device product:transport_id:7\n");
  assert.equal(metadataOnly[0]?.transportId, null);
  assert.equal(metadataOnly[0]?.selectable, false);
  const noSerial = parseDeviceList("List of devices attached\n(no serial number) device transport_id:7\n");
  assert.equal(noSerial[0]?.endpointId, "(no serial number)");
  assert.equal(noSerial[0]?.state, "device");
  assert.equal(noSerial[0]?.selectable, false);
  assert.equal(parseDeviceList("List of devices attached\n(no serial number)\tdevice\ttransport_id:7\n")[0]?.endpointId, "(no serial number)");
  const permissions = parseDeviceList("List of devices attached\nLOCKED no permissions usb:1-3 transport_id:8\n");
  assert.equal(permissions[0]?.state, "no permissions");
  assert.equal(permissions[0]?.selectable, false);
});

test("transport IDs must be canonical nonzero uint64 values; zero must never mean implicit selection", () => {
  for (const invalid of ["0", "00", "007", "-1", "1other", "18446744073709551616"]) {
    assert.throws(() => parseDeviceList(`List of devices attached\nPOC_PHONE device transport_id:${invalid}\n`), hasCode("INVALID_DEVICE_LIST"));
  }
  assert.equal(parseDeviceList("List of devices attached\nPOC_PHONE device transport_id:18446744073709551615\n")[0]?.transportId, "18446744073709551615");
});

test("ADB track framing handles bytewise packets, multiple frames, and an empty inventory", () => {
  const parser = new AdbTrackParser();
  const body = `${USB_LINE}\n`;
  const wire = Buffer.from(`OKAY${Buffer.byteLength(body).toString(16).padStart(4, "0")}${body}0000`);
  const frames = [];
  for (const byte of wire) frames.push(...parser.push(Buffer.from([byte])));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.[0]?.transportId, "7");
  assert.deepEqual(frames[1], []);
});

test("ADB track framing rejects protocol failure, malformed sizes, and unbounded data", () => {
  assert.throws(() => new AdbTrackParser().push(Buffer.from("FAIL0000")), hasCode("ADB_SERVER_UNAVAILABLE"));
  assert.throws(() => new AdbTrackParser().push(Buffer.from("OKAYzzzz")), hasCode("INVALID_DEVICE_LIST"));
  assert.throws(() => new AdbTrackParser().push(Buffer.alloc(1024 * 1024 + 1)), hasCode("INVALID_DEVICE_LIST"));
});

test("inventory limits reject excessive output rather than silently dropping devices", () => {
  for (const output of [
    " ".repeat(512 * 1024 + 1),
    `List of devices attached\n${"A".repeat(513)} device transport_id:1\n`,
    `List of devices attached\n${Array.from({ length: 257 }, (_value, index) => `PHONE_${index} device transport_id:${index + 1}`).join("\n")}`,
  ]) assert.throws(() => parseDeviceList(output), hasCode("INVALID_DEVICE_LIST"));
});

async function executableFixture(t: TestContext) {
  const base = path.resolve(".test-artifacts");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "adb lookup "));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sdk = path.join(directory, "Android SDK");
  const tools = path.join(sdk, "platform-tools");
  await mkdir(tools, { recursive: true });
  const executable = path.join(tools, "adb.exe");
  await writeFile(executable, "not executable; lookup fixture only");
  return { directory, sdk, tools, executable };
}

test("Windows executable lookup respects explicit, SDK, and quoted PATH entries without cwd fallback", async (t) => {
  const { directory, sdk, tools, executable } = await executableFixture(t);
  assert.equal(resolveAdbExecutable({ MOBILE_USE_ADB_PATH: executable }, "win32"), executable);
  assert.equal(resolveAdbExecutable({ ANDROID_HOME: sdk }, "win32"), executable);
  assert.equal(resolveAdbExecutable({ ANDROID_SDK_ROOT: sdk }, "win32"), executable);
  assert.equal(resolveAdbExecutable({ LOCALAPPDATA: directory, ANDROID_HOME: sdk }, "win32"), executable);
  assert.equal(resolveAdbExecutable({ PATH: `"${tools}"` }, "win32"), executable);
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: ".\\adb.exe" }, "win32"), hasCode("ADB_CONFIG_UNSUPPORTED"));
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: path.join(directory, "adb.cmd") }, "win32"), hasCode("ADB_CONFIG_UNSUPPORTED"));
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: path.join(directory, "missing.exe") }, "win32"), hasCode("ADB_NOT_FOUND"));
  assert.throws(() => resolveAdbExecutable({ PATH: "." }, "win32"), hasCode("ADB_NOT_FOUND"));
  assert.throws(() => resolveAdbExecutable({ ANDROID_HOME: ".", ANDROID_SDK_ROOT: "." }, "win32"), hasCode("ADB_NOT_FOUND"));
  assert.throws(() => resolveAdbExecutable({}, "linux"), hasCode("UNSUPPORTED_HOST"));
});

test("Windows SDK lookup supports per-user defaults and skips non-executable directories", async (t) => {
  const { directory } = await executableFixture(t);
  const local = path.join(directory, "AppData", "Local");
  const sdk = path.join(local, "Android", "Sdk");
  const tools = path.join(sdk, "platform-tools");
  await mkdir(tools, { recursive: true });
  const executable = path.join(tools, "adb.exe");
  await writeFile(executable, "not executable; lookup fixture only");
  assert.equal(resolveAdbExecutable({ LOCALAPPDATA: local }, "win32"), executable);
  assert.equal(resolveAdbExecutable({ USERPROFILE: directory }, "win32"), executable);
  const unavailableSdk = path.join(directory, "directory-not-an-executable");
  await mkdir(path.join(unavailableSdk, "platform-tools", "adb.exe"), { recursive: true });
  assert.equal(resolveAdbExecutable({ ANDROID_HOME: unavailableSdk, PATH: tools }, "win32"), executable);
});

test("ADB commands pin the local server and exclude unrelated credentials and implicit targets", async (t) => {
  const { executable } = await executableFixture(t);
  let routed: readonly string[] = [];
  let environment: NodeJS.ProcessEnv = {};
  let request: CommandOptions | undefined;
  const client = new AdbClient({
    MOBILE_USE_ADB_PATH: executable, PATH: process.env.PATH ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "", PRIVATE_TEST_SECRET: "do not forward", ANDROID_SERIAL: "unselected",
  }, async (exe, args, options) => {
    assert.equal(exe, executable);
    routed = args;
    environment = options.env;
    request = options;
    return Buffer.from([0, 255, 13, 10]);
  }, "win32");
  assert.deepEqual(await client.run(["-t", "7", "exec-out", "screencap", "-p"]), Buffer.from([0, 255, 13, 10]));
  assert.deepEqual(routed, ["-H", "127.0.0.1", "-P", "5037", "-t", "7", "exec-out", "screencap", "-p"]);
  assert.equal(environment.PRIVATE_TEST_SECRET, undefined);
  assert.equal(environment.ANDROID_SERIAL, undefined);
  assert.equal(environment.MOBILE_USE_ADB_PATH, undefined);
  assert.ok(request?.signal);
  client.stop();
  assert.equal(request.signal.aborted, true);
  await assert.rejects(client.run(["devices", "-l"]), hasCode("SERVER_STOPPED"));
});

test("remote or non-default ADB server overrides fail before starting a command", async (t) => {
  const { executable } = await executableFixture(t);
  for (const extra of [
    { ADB_SERVER_SOCKET: "tcp:remote.example:5037" },
    { ANDROID_ADB_SERVER_ADDRESS: "192.0.2.20" },
    { ANDROID_ADB_SERVER_PORT: "5038" },
  ]) {
    const client = new AdbClient({ MOBILE_USE_ADB_PATH: executable, ...extra }, async () => {
      assert.fail("unsupported configuration must not run adb");
    }, "win32");
    await assert.rejects(client.run(["devices", "-l"]), hasCode("ADB_CONFIG_UNSUPPORTED"));
    await assert.rejects(client.startServer(), hasCode("ADB_CONFIG_UNSUPPORTED"));
    client.stop();
  }
});

test("bounded process execution is binary-safe and sanitizes failures", async () => {
  const env = { ...process.env };
  const bytes = await executeCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,13,10]))"], { env });
  assert.deepEqual(bytes, Buffer.from([0, 255, 13, 10]));
  await assert.rejects(executeCommand(process.execPath, ["-e", "process.stderr.write('private fixture text');process.exit(1)"], { env }), (error: unknown) => {
    hasCode("ADB_FAILED")(error);
    assert.ok(error instanceof MobileUseError);
    assert.doesNotMatch(JSON.stringify(error), /private fixture text/);
    return true;
  });
  await assert.rejects(executeCommand(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(17*1024*1024))"], { env }), hasCode("ADB_OUTPUT_LIMIT"));
});

test("app rejection diagnostics preserve operation-specific errors without leaking details or implying transport loss", async () => {
  for (const [diagnostic, code] of [
    ["Failure [INSTALL_FAILED_INVALID_APK: private file not found]", "APP_INSTALL_FAILED"],
    ["Failure [DELETE_FAILED_INTERNAL_ERROR: private package not found]", "APP_UNINSTALL_FAILED"],
  ] as const) {
    await assert.rejects(executeCommand(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(diagnostic)});process.exit(1)`], {
      env: { ...process.env }, mutating: true,
    }), (error: unknown) => {
      hasCode(code)(error);
      assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
      assert.doesNotMatch(JSON.stringify(error), /private|not found/);
      return true;
    });
  }
});

test("process execution honors an operation-specific deadline and preserves uncertain delivery", async () => {
  await assert.rejects(executeCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    env: { ...process.env }, timeoutMs: 200, mutating: true,
  }), (error: unknown) => {
    hasCode("ADB_TIMEOUT")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
});

test("a missing local ADB server is not misreported as a lost phone transport", async () => {
  for (const details of [
    "adb.exe: cannot connect to daemon at tcp:127.0.0.1:5037: cannot connect to 127.0.0.1:5037: No connection could be made (10061)",
    "* failed to start daemon *",
    "adb: failed to check server version: cannot connect to server",
    "ADB server didn't ACK",
  ]) {
    await assert.rejects(executeCommand(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(details)});process.exit(1)`], {
      env: { ...process.env },
    }), (error: unknown) => {
      hasCode("ADB_SERVER_UNAVAILABLE")(error);
      assert.ok(error instanceof MobileUseError);
      assert.match(error.remediation, /approval to use mobile_start_adb_server/);
      assert.equal(error.actionMayHaveRun, false);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(JSON.stringify(error), /10061|didn't ACK/);
      return true;
    });
  }
  await assert.rejects(executeCommand(process.execPath, ["-e", "process.stderr.write('cannot connect to 192.0.2.1:37001: connection refused');process.exit(1)"], {
    env: { ...process.env }, mutating: true,
  }), (error: unknown) => {
    hasCode("TRANSPORT_LOST")(error);
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.actionMayHaveRun, true);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("approved startup pins the executable, sanitizes the daemon environment, and parses raw inventory", async (t) => {
  const { executable } = await executableFixture(t);
  const server = new LocalAdbServer();
  let startupCalls = 0;
  let startupSignal: AbortSignal | undefined;
  server.ensureRunning = async (exe, env, version, signal) => {
    startupCalls++;
    startupSignal = signal;
    assert.equal(exe, executable);
    assert.equal(version, 41);
    assert.equal(env.PRIVATE_TEST_SECRET, undefined);
    assert.equal(env.ANDROID_SERIAL, undefined);
    assert.equal(env.ADB_SERVER_SOCKET, undefined);
    assert.equal(env.ADB_VENDOR_KEYS, undefined);
    return { startupAttempted: true, inventory: Buffer.from(`${USB_LINE}\n`) };
  };
  const calls: string[][] = [];
  const client = new AdbClient({
    MOBILE_USE_ADB_PATH: executable, PRIVATE_TEST_SECRET: "do not forward", ANDROID_SERIAL: "unselected",
    ADB_VENDOR_KEYS: "private fixture key path",
  }, async (_exe, args) => {
    calls.push([...args]);
    return Buffer.from("Android Debug Bridge version 1.0.41\nVersion 36.0.0-12345\n");
  }, "win32", server);
  t.after(() => client.stop());
  const result = await client.startServer();
  assert.equal(result.status, "ready");
  assert.equal(result.serverAddress, "127.0.0.1:5037");
  assert.equal(result.startupAttempted, true);
  assert.equal(result.devices[0]?.endpointId, "POC_PHONE");
  assert.equal(startupCalls, 1);
  assert.deepEqual(calls, [["-H", "127.0.0.1", "-P", "5037", "version"]], "no ADB client discovery/start-server/kill-server");
  assert.ok(startupSignal);
  client.stop();
  assert.equal(startupSignal.aborted, true);
  await assert.rejects(client.startServer(), hasCode("SERVER_STOPPED"));
  assert.equal(startupCalls, 1);
});

test("ordinary inventory uses read-only protocol discovery and never launches an ADB client", async (t) => {
  const { executable } = await executableFixture(t);
  const server = new LocalAdbServer();
  let queries = 0;
  server.inventory = async (signal) => {
    assert.ok(signal);
    queries++;
    return Buffer.from(`${USB_LINE}\n`);
  };
  const client = new AdbClient({ MOBILE_USE_ADB_PATH: executable }, async () =>
    assert.fail("inventory must not invoke a client with automatic daemon startup/replacement"), "win32", server);
  t.after(() => client.stop());
  assert.equal((await client.run(["devices", "-l"])).toString(), `List of devices attached\n${USB_LINE}\n`);
  assert.equal(queries, 1);
});

test("malformed post-start inventory is an error with startup uncertainty, not an empty list", async (t) => {
  const { executable } = await executableFixture(t);
  const server = new LocalAdbServer();
  server.ensureRunning = async () => ({ startupAttempted: true, inventory: Buffer.from("malformed\n") });
  const client = new AdbClient({ MOBILE_USE_ADB_PATH: executable }, async () =>
    Buffer.from("Android Debug Bridge version 1.0.41\nVersion 36.0.0\n"), "win32", server);
  t.after(() => client.stop());
  await assert.rejects(client.startServer(), (error: unknown) => {
    hasCode("INVALID_DEVICE_LIST")(error);
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.actionMayHaveRun, true);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("cancelling a spawned mutating command reports uncertainty and stops that child only", async () => {
  const controller = new AbortController();
  const pending = executeCommand(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
    env: { ...process.env }, signal: controller.signal, mutating: true,
  });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(pending, (error: unknown) => {
      hasCode("CANCELLED")(error);
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.actionMayHaveRun, true);
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    clearTimeout(timer);
  }
});

test("the command deadline is enforced rather than leaving an owned subprocess alive", { timeout: 20_000 }, async () => {
  await assert.rejects(executeCommand(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { env: { ...process.env } }), hasCode("ADB_TIMEOUT"));
});

async function monitorFixture(t: TestContext, answer = true) {
  let peer: Socket | undefined;
  let monitor: TransportMonitor | undefined;
  let request = "";
  const server = createServer();
  const connected = new Promise<void>((resolve) => {
    server.once("connection", (socket) => {
      peer = socket;
      socket.on("data", (data: Buffer) => {
        request += data.toString("ascii");
        if (answer && request.length === 24) {
          const body = `${USB_LINE}\n`;
          socket.write("OK");
          socket.write(`AY${Buffer.byteLength(body).toString(16).padStart(4, "0")}${body}`);
        }
      });
      resolve();
    });
  });
  t.after(async () => {
    monitor?.close();
    peer?.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const factory = createTransportMonitor(() => createConnection({ host: "127.0.0.1", port: address.port }));
  return {
    factory, connected,
    get peer() { assert.ok(peer); return peer; },
    get request() { return request; },
    own(value: TransportMonitor) { monitor = value; return value; },
  };
}

test("the tracking socket uses the exact service and reports server closure after readiness", async (t) => {
  const fixture = await monitorFixture(t);
  let notifyLost: (() => void) | undefined;
  const lost = new Promise<void>((resolve) => { notifyLost = resolve; });
  const frames: DeviceEndpoint[][] = [];
  const monitor = fixture.own(await fixture.factory((inventory) => frames.push(inventory), () => notifyLost?.(), new AbortController().signal));
  assert.equal(fixture.request, "0014host:track-devices-l");
  assert.equal(monitor.initial[0]?.transportId, "7");
  fixture.peer.write("0000");
  fixture.peer.end();
  await lost;
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], []);
});

test("cancelling pending monitoring rejects immediately without a lingering readiness deadline", async (t) => {
  const fixture = await monitorFixture(t, false);
  const controller = new AbortController();
  const pending = fixture.factory(() => assert.fail("no inventory expected"), () => assert.fail("not yet ready"), controller.signal);
  await fixture.connected;
  controller.abort();
  await assert.rejects(pending, hasCode("CANCELLED"));
});

test("intentional tracking close does not masquerade as transport loss", async (t) => {
  const fixture = await monitorFixture(t);
  let lost = 0;
  const monitor = fixture.own(await fixture.factory(() => {}, () => { lost++; }, new AbortController().signal));
  monitor.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lost, 0);
});
