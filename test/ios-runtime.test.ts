import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { MobileUseError } from "../src/errors.js";
import { createMobileService } from "../src/service-factory.js";
import { IosMobileUseService } from "../src/ios/device-session.js";
import { runtimeCommands, runtimeFailure, type OwnedProcess, type RuntimeCommands } from "../src/ios/runtime-process.js";
import { availableTunnelPort, ManagedIosRuntime, ManagedIosRuntimePool, readRuntimeConfig } from "../src/ios/runtime.js";
import { MuxConnection, usbFailure, type UsbBackend } from "../src/ios/usb.js";
import { createIosFixture } from "./ios-fixture.js";
import { IOS_ENDPOINT, IOS_OTHER_UDID, IOS_UDID, runtimeFixture, waitRuntimeState } from "./ios-runtime-fixture.js";

test("managed mode constructs lazily without throwing, validates runtime configuration on demand, and coexists with external WDA", async () => {
  assert.equal(createMobileService({ MOBILE_USE_PLATFORM: "ios" }).iosRuntime, undefined);
  const config = { MOBILE_USE_PLATFORM: "ios", MOBILE_USE_IOS_RUNTIME: "managed",
    MOBILE_USE_IOS_RUNNER_BUNDLE_ID: "example.runner.xctrunner" };
  assert.equal(typeof createMobileService(config).iosRuntime, "function");
  const coexisting = createMobileService({ ...config, MOBILE_USE_WDA_URL: "http://127.0.0.1:8100" });
  assert.ok(coexisting.iosRuntime);
  assert.equal((await coexisting.iosRuntime({ kind: "status" })).state, "idle");
  for (const environment of [
    { MOBILE_USE_PLATFORM: "ios", MOBILE_USE_IOS_RUNTIME: "managed" },
    { ...config, MOBILE_USE_IOS_RUNTIME: "automatic" },
    { ...config, MOBILE_USE_IOS_RUNNER_BUNDLE_ID: "example.runner" },
    { ...config, MOBILE_USE_IOS_RUNNER_IPA: "relative.ipa" },
    { ...config, MOBILE_USE_IOS_TUNNEL_PORT: "65535" },
    { ...config, MOBILE_USE_IOS_TUNNEL_PORT: "65536" },
  ]) {
    const service = createMobileService(environment);
    assert.ok(service.iosRuntime);
    await assert.rejects(service.iosRuntime({ kind: "status" }), { code: "IOS_RUNTIME_CONFIG_INVALID" });
    await assert.rejects(service.iosRuntime({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false }),
      { code: "IOS_RUNTIME_CONFIG_INVALID" });
    await assert.rejects(service.doctor(), { code: "IOS_RUNTIME_CONFIG_INVALID" });
  }
});

test("tunnel-info allocation leaves room for the derived userspace listener, including ephemeral allocations", async () => {
  const allocations = [65535, 65534];
  assert.equal(await availableTunnelPort(0, async () => {
    const port = allocations.shift();
    assert.ok(port);
    return port;
  }), 65534);
  assert.equal(allocations.length, 0);
  await assert.rejects(availableTunnelPort(65535, async () => {
    assert.fail("Invalid explicit ports must fail before binding.");
  }), { code: "IOS_RUNTIME_CONFIG_INVALID" });
  await assert.rejects(availableTunnelPort(0, async () => 65535), { code: "IOS_RUNTIME_CONFLICT" });
});

test("tunnel allocation rejects an occupied adjacent listener and retries an automatic port pair", async (t) => {
  const candidate = await availableTunnelPort(0);
  const occupied = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(candidate + 1, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  await assert.rejects(availableTunnelPort(candidate), { code: "IOS_RUNTIME_CONFLICT" });
  let attempts = 0;
  const automatic = await availableTunnelPort(0, async () => {
    attempts++;
    return availableTunnelPort(attempts === 1 ? candidate : 0);
  });
  assert.notEqual(automatic, candidate);
  assert.equal(attempts, 2);
  assert.equal(occupied.listening, true);
});

test("managed userspace tunnels reject unsupported iOS versions before acquiring resources", async (t) => {
  for (const version of ["16.7", "17.0", "17.3.1", "17.4", "17.4.0"]) {
    const f = await runtimeFixture(t);
    f.state.productVersion = version;
    await assert.rejects(f.start(), { code: "DEVICE_UNSUPPORTED" });
    assert.deepEqual(f.events, []);
    await assert.rejects(readFile(join(f.directory, "locks", `${IOS_UDID}.lock`)), { code: "ENOENT" });
  }
  for (const version of ["17.4.1", "17.5", "18.0"]) {
    const f = await runtimeFixture(t);
    f.state.productVersion = version;
    assert.equal((await f.start()).state, "awaiting-developer-trust");
  }
});

test("doctor/discovery never launch or install; trust gates WDA and USB identity remains distinct from IDFV", async (t) => {
  const f = await runtimeFixture(t);
  assert.equal((await f.service.doctor()).status, "runtime-not-ready");
  const devices = await f.service.listDevices();
  assert.equal(devices.length, 2);
  assert.equal(devices[0]?.kind, "usb");
  assert.equal(devices[0]?.selectable, false);
  assert.equal(f.calls.some((entry) => entry.kind === "start" || entry.args.includes("install")), false);
  await assert.rejects(f.service.selectDevice(IOS_ENDPOINT), { code: "IOS_RUNTIME_NOT_READY" });
  const started = await f.start();
  assert.equal(started.state, "awaiting-developer-trust");
  assert.equal(f.events.includes("install"), false);
  assert.equal(f.events.includes("start-wda"), false);
  await assert.rejects(f.runtime.control({ kind: "confirm_trust", runtimeToken: randomUUID() }), { code: "IOS_RUNTIME_CONFLICT" });
  assert.ok(started.runtimeToken);
  await f.runtime.control({ kind: "confirm_trust", runtimeToken: started.runtimeToken });
  await waitRuntimeState(f.runtime, "ready");
  const selected = await f.service.selectDevice(IOS_ENDPOINT);
  assert.equal(selected.endpoint.transportId, IOS_UDID);
  assert.equal(selected.identity.udid, IOS_UDID);
  assert.equal(selected.identity.vendorId, f.http.state.uuid);
  assert.equal((await f.service.doctor()).status, "ready");
  const screen = await f.service.observe(selected.targetToken, undefined, false);
  assert.equal(screen.observation.platform, "ios");
  assert.ok(f.service.iosRuntime);
  await assert.rejects(f.service.iosRuntime({ kind: "stop", runtimeToken: randomUUID() }), { code: "IOS_RUNTIME_CONFLICT" });
  assert.equal(f.runtime.status().state, "ready");
  await f.service.observe(selected.targetToken, undefined, false);
  const tunnel = f.calls.find((entry) => entry.args.includes("tunnel"));
  const wda = f.calls.find((entry) => entry.args.includes("runwda"));
  assert.ok(tunnel && wda);
  assert.equal(wda.args[wda.args.indexOf("--tunnel-info-port") + 1],
    tunnel.args[tunnel.args.indexOf("--tunnel-info-port") + 1]);
  await f.service.iosRuntime?.({ kind: "stop", runtimeToken: started.runtimeToken });
  assert.equal(f.http.state.sessionId, null);
  assert.equal(f.runtime.status().state, "stopped");
  assert.equal(f.runtime.status().wdaPortClosed, true);
  assert.deepEqual(f.events, ["start-tunnel", "image", "start-wda", "stop-wda", "stop-tunnel"]);
  await assert.rejects(f.service.observe(selected.targetToken), { code: "TARGET_NOT_SELECTED" });
  const restarted = await f.ready();
  assert.notEqual(restarted.runtimeToken, started.runtimeToken);
  const reselected = await f.service.selectDevice(IOS_ENDPOINT);
  assert.notEqual(reselected.targetToken, selected.targetToken);
});

test("explicit install uses the supplied IPA once and retains it on shutdown", async (t) => {
  const f = await runtimeFixture(t, { ipa: true });
  await f.ready();
  assert.equal(f.runtime.status().installedThisRun, true);
  const installation = f.calls.filter((entry) => entry.args.includes("install"));
  assert.equal(installation.length, 1);
  assert.equal(installation[0]?.signal, undefined);
  assert.ok(installation[0]?.args.includes(join(f.directory, "signed.ipa")));
  const imageAuto = f.calls.findIndex((call) => call.args.includes("image") && call.args.includes("auto"));
  const imageList = f.calls.findIndex((call) => call.args.includes("image") && call.args.includes("list"));
  const install = f.calls.findIndex((call) => call.args.includes("install"));
  assert.ok(imageAuto >= 0 && imageAuto < imageList && imageList < install);
  await f.service.stop();
  assert.equal(f.calls.some((entry) => entry.args.includes("uninstall")), false);
  assert.deepEqual(f.events, ["start-tunnel", "image", "install", "start-wda", "stop-wda", "stop-tunnel"]);
});

test("zero-exit image preparation requires mounted-image evidence before installation or trust", async (t) => {
  for (const failure of ["not-mounted", "malformed", "invalid-signature", "error-after-signature"]) {
    const f = await runtimeFixture(t, { ipa: true });
    if (failure === "not-mounted") f.state.imageAutoNoMount = true;
    if (failure === "malformed") f.state.imageListOutput = "not-json";
    if (failure === "invalid-signature") {
      f.state.imageListOutput = JSON.stringify({ level: "INFO", msg: "image signature", signature: "not-a-signature" });
    }
    if (failure === "error-after-signature") {
      f.state.imageListOutput = [
        JSON.stringify({ level: "INFO", msg: "image signature", signature: "aabbccdd" }),
        JSON.stringify({ level: "ERROR", msg: "image lookup failed" }),
      ].join("\n");
    }
    await assert.rejects(f.start(), (error: unknown) =>
      error instanceof MobileUseError && error.code === "IOS_RUNTIME_FAILED" && error.actionMayHaveRun);
    assert.equal(f.runtime.status().state, "failed");
    assert.equal(f.runtime.status().error?.code, "IOS_RUNTIME_FAILED");
    assert.equal(f.events.includes("install"), false);
    assert.equal(f.events.includes("start-wda"), false);
    assert.deepEqual(f.events, ["start-tunnel", "image", "stop-tunnel"]);
  }
});

test("all device subprocesses share an owned USB-only endpoint and shutdown closes it", async (t) => {
  const f = await runtimeFixture(t, { ipa: true });
  const inherited = process.env.USBMUXD_SOCKET_ADDRESS;
  await f.ready();
  const calls = f.calls.filter((call) => call.args.includes("--udid"));
  const endpoint = calls[0]?.environment?.USBMUXD_SOCKET_ADDRESS;
  assert.ok(endpoint);
  assert.match(endpoint, /^tcp:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(calls.some((call) => call.args.includes("install")));
  for (const call of calls) assert.equal(call.environment?.USBMUXD_SOCKET_ADDRESS, endpoint);
  assert.equal(f.calls.find((call) => call.args.includes("version"))?.environment, undefined);
  assert.equal(process.env.USBMUXD_SOCKET_ADDRESS, inherited);
  const socket = createConnection(Number(new URL(endpoint).port), "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const reply = await new MuxConnection(socket).request({ MessageType: "ListDevices" });
  assert.deepEqual(reply, { DeviceList: [{
    DeviceID: 1, MessageType: "Attached", Properties: { DeviceID: 1, SerialNumber: IOS_UDID, ConnectionType: "USB" },
  }] });
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  await f.service.stop();
  await closed;
});

test("long preparation is acknowledged immediately and status/doctor stay available after request completion", async (t) => {
  const f = await runtimeFixture(t);
  let release: (() => void) | undefined;
  const image = new Promise<void>((resolve) => { release = resolve; });
  f.state.imageHook = () => image;
  const controller = new AbortController();
  assert.ok(f.service.iosRuntime);
  try {
    const started = await Promise.race([
      f.service.iosRuntime({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false }, controller.signal),
      delay(500).then(() => { throw new Error("Startup did not acknowledge background preparation."); }),
    ]);
    assert.equal(started.state, "preparing");
    assert.ok(started.runtimeToken);
    controller.abort();
    for (let i = 0; i < 100 && !f.events.includes("image"); i++) await delay(5);
    assert.ok(f.events.includes("image"));
    const status = await f.service.iosRuntime({ kind: "status" });
    assert.equal(status.state, "preparing");
    assert.equal(status.error, null);
    assert.equal((await f.service.doctor()).status, "runtime-not-ready");
    assert.equal((await f.service.listDevices())[0]?.selectable, false);
  } finally { release?.(); }
  await waitRuntimeState(f.runtime, "awaiting-developer-trust");
});

test("cancellation during install waits for its outcome, cleans resources and reports installation side effects", async (t) => {
  const f = await runtimeFixture(t, { ipa: true });
  f.state.installHook = async () => {
    const token = f.runtime.status().runtimeToken;
    assert.ok(token);
    f.runtime.cancelPending(token);
    await delay(5);
  };
  const started = await f.runtime.control({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: true });
  assert.equal(started.state, "preparing");
  await assert.rejects(waitRuntimeState(f.runtime, "awaiting-developer-trust"),
    (error: unknown) => error instanceof MobileUseError && error.code === "CANCELLED" && error.actionMayHaveRun);
  assert.equal(f.runtime.status().installedThisRun, true);
  assert.equal(f.runtime.status().error?.actionMayHaveRun, true);
  assert.deepEqual(f.events, ["start-tunnel", "image", "install", "stop-tunnel"]);
});

test("foreign WDA and invalid device info fail before tunnel/image/install and never take over", async (t) => {
  for (const scenario of ["foreign", "bad-info"]) {
    const f = await runtimeFixture(t, { ipa: true });
    if (scenario === "foreign") f.state.running = true;
    else f.state.badInfo = true;
    await assert.rejects(f.start(), { code: scenario === "foreign" ? "IOS_RUNTIME_CONFLICT" : "IOS_RUNTIME_FAILED" });
    assert.deepEqual(f.events, []);
    assert.equal(f.http.calls.some((entry) => entry.method !== "GET"), false);
  }
});

test("failed installation keeps its uncertain result and stops the tunnel without uninstalling", async (t) => {
  const f = await runtimeFixture(t, { ipa: true });
  f.state.failInstall = true;
  await assert.rejects(f.start(), (error: unknown) =>
    error instanceof MobileUseError && error.code === "IOS_RUNTIME_FAILED" && error.actionMayHaveRun);
  assert.equal(f.runtime.status().installedThisRun, false);
  assert.deepEqual(f.events, ["start-tunnel", "image", "install", "stop-tunnel"]);
});

test("a Runner appearing during human trust confirmation is not launched over or stopped", async (t) => {
  const f = await runtimeFixture(t);
  const started = await f.start();
  f.state.running = true;
  assert.ok(started.runtimeToken);
  await f.runtime.control({ kind: "confirm_trust", runtimeToken: started.runtimeToken });
  await assert.rejects(waitRuntimeState(f.runtime, "ready"), { code: "IOS_RUNTIME_CONFLICT" });
  assert.deepEqual(f.events, ["start-tunnel", "image", "stop-tunnel"]);
  assert.equal(f.state.running, true);
});

test("per-UDID locks prevent overlapping runtimes and are released after normal cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-runtime-lock-"));
  const a = await runtimeFixture(t, { directory });
  const b = await runtimeFixture(t, { directory });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const started = await a.start();
  await assert.rejects(b.start(), { code: "IOS_RUNTIME_CONFLICT" });
  assert.deepEqual(b.events, []);
  assert.ok(started.runtimeToken);
  await a.runtime.control({ kind: "stop", runtimeToken: started.runtimeToken });
  await b.runtime.close();
  assert.equal((await b.start()).state, "awaiting-developer-trust");
});

test("occupied tunnel ports are not reused and malformed/foreign sessions never become ready", async (t) => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = await runtimeFixture(t, { tunnelPort: address.port });
  await assert.rejects(f.start(), { code: "IOS_RUNTIME_CONFLICT" });
  assert.deepEqual(f.events, []);
  const foreign = await runtimeFixture(t);
  const started = await foreign.start();
  foreign.http.state.sessionId = "foreign-session";
  assert.ok(started.runtimeToken);
  await foreign.runtime.control({ kind: "confirm_trust", runtimeToken: started.runtimeToken });
  await assert.rejects(waitRuntimeState(foreign.runtime, "ready"), { code: "WDA_SESSION_CONFLICT" });
  assert.equal(foreign.http.calls.some((entry) => entry.method === "DELETE"), false);
});

test("USB loss invalidates selected targets without switching to another connected device", async (t) => {
  const f = await runtimeFixture(t);
  await f.ready();
  const selected = await f.service.selectDevice(IOS_ENDPOINT);
  f.state.connected = false;
  await assert.rejects(f.service.observe(selected.targetToken), { code: "DEVICE_NOT_FOUND" });
  assert.equal(f.runtime.status().state, "failed");
  await assert.rejects(f.service.observe(selected.targetToken), { code: "TRANSPORT_LOST" });
  f.state.connected = true;
});

test("unexpected managed process exit cleans owned resources and invalidates the selection", async (t) => {
  const f = await runtimeFixture(t);
  await f.ready();
  const selected = await f.service.selectDevice(IOS_ENDPOINT);
  f.crash("tunnel");
  for (let i = 0; i < 100 && !f.events.includes("stop-tunnel"); i++) await delay(5);
  assert.ok(f.events.includes("stop-wda"));
  assert.ok(f.events.includes("stop-tunnel"));
  assert.equal(f.runtime.status().state, "failed");
  await assert.rejects(f.service.observe(selected.targetToken), { code: "TRANSPORT_LOST" });
});

test("cancelling one in-flight UI request does not kill the managed runtime or replay input", async (t) => {
  const f = await runtimeFixture(t);
  await f.ready();
  const selected = await f.service.selectDevice(IOS_ENDPOINT);
  const screen = await f.service.observe(selected.targetToken, undefined, false);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  f.http.state.actionHook = () => new Promise<void>((resolve) => { release = resolve; entered?.(); });
  const controller = new AbortController();
  const input = f.service.act(selected.targetToken, screen.observation.observationId,
    { kind: "key", key: "HOME" }, controller.signal);
  await dispatched;
  controller.abort();
  try {
    const result = await input;
    assert.equal(result.error?.actionMayHaveRun, true);
    assert.equal(f.runtime.status().state, "ready");
    assert.equal(f.http.calls.filter((call) => call.path === "/wda/homescreen").length, 1);
  } finally { release?.(); f.http.state.actionHook = undefined; }
  await f.service.observe(selected.targetToken, undefined, false);
});

test("host process exit alone is not device stop; remaining cleanup still runs and failure is explicit", async (t) => {
  const f = await runtimeFixture(t);
  const ready = await f.ready();
  f.state.leaveRunnerRunning = true;
  f.allowCleanupFailure();
  assert.ok(ready.runtimeToken);
  await assert.rejects(f.runtime.control({ kind: "stop", runtimeToken: ready.runtimeToken }), { code: "IOS_RUNTIME_CLEANUP_FAILED" });
  assert.equal(f.runtime.status().wdaPortClosed, false);
  assert.equal(f.runtime.status().state, "cleanup-failed");
  assert.deepEqual(f.events.slice(-2), ["stop-wda", "stop-tunnel"]);
});

test("cleanup failures retain the matching-token UDID lock and prevent another runtime from starting", async (t) => {
  for (const failure of ["tunnel-stop", "open-port", "device-loss"]) {
    const f = await runtimeFixture(t);
    const ready = await f.ready();
    assert.ok(ready.runtimeToken);
    f.allowCleanupFailure();
    if (failure === "tunnel-stop") f.state.failTunnelStop = true;
    if (failure === "open-port") f.state.leaveRunnerRunning = true;
    if (failure === "device-loss") f.state.connected = false;
    await assert.rejects(f.runtime.control({ kind: "stop", runtimeToken: ready.runtimeToken }),
      { code: "IOS_RUNTIME_CLEANUP_FAILED" });
    assert.equal(f.runtime.status().state, "cleanup-failed");
    const lock = JSON.parse(await readFile(join(f.directory, "locks", `${IOS_UDID}.lock`), "utf8"));
    assert.equal(lock.token, ready.runtimeToken);
    const other = await runtimeFixture(t, { directory: f.directory });
    await assert.rejects(other.start(), { code: "IOS_RUNTIME_CONFLICT" });
    assert.deepEqual(other.events, []);
  }
});

test("failed owned-session DELETE retains the UDID lock and cleanup-failed status on tool stop and shutdown", async (t) => {
  for (const stop of ["tool", "shutdown"]) {
    const f = await runtimeFixture(t);
    const ready = await f.ready();
    assert.ok(ready.runtimeToken);
    await f.service.selectDevice(IOS_ENDPOINT);
    f.http.state.failSessionDelete = true;
    f.allowCleanupFailure();
    assert.ok(f.service.iosRuntime);
    const operation = stop === "tool"
      ? f.service.iosRuntime({ kind: "stop", runtimeToken: ready.runtimeToken })
      : f.service.stop();
    await assert.rejects(operation, { code: "IOS_RUNTIME_CLEANUP_FAILED" });
    assert.equal(f.runtime.status().state, "cleanup-failed");
    assert.equal(f.runtime.status().error?.code, "IOS_RUNTIME_CLEANUP_FAILED");
    assert.equal(f.runtime.status().wdaPortClosed, true);
    assert.equal(f.http.calls.filter((call) => call.method === "DELETE").length, 1);
    assert.deepEqual(f.events.slice(-2), ["stop-wda", "stop-tunnel"]);
    const lock = JSON.parse(await readFile(join(f.directory, "locks", `${IOS_UDID}.lock`), "utf8"));
    assert.equal(lock.token, ready.runtimeToken);
    const other = await runtimeFixture(t, { directory: f.directory });
    await assert.rejects(other.start(), { code: "IOS_RUNTIME_CONFLICT" });
    assert.deepEqual(other.events, []);
  }
});

test("WDA port closure is verified after both owned launcher and tunnel have exited", async (t) => {
  const f = await runtimeFixture(t);
  const ready = await f.ready();
  f.state.closeRunnerWithTunnel = true;
  assert.ok(ready.runtimeToken);
  const stopped = await f.runtime.control({ kind: "stop", runtimeToken: ready.runtimeToken });
  assert.equal(stopped.wdaPortClosed, true);
  assert.equal(stopped.state, "stopped");
});

test("USB revalidation cannot verify an old token across a concurrent runtime generation change", async (t) => {
  const f = await runtimeFixture(t);
  const ready = await f.ready();
  assert.ok(ready.runtimeToken);
  const token = ready.runtimeToken;
  f.state.listHook = async () => {
    f.state.listHook = undefined;
    await f.runtime.control({ kind: "stop", runtimeToken: token });
    await f.ready();
  };
  await assert.rejects(f.runtime.verify(token), { code: "IOS_RUNTIME_CONFLICT" });
});

test("native launcher isolates stdout in logs, observes child exit and stops only its owned child", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-runtime-native-"));
  const log = join(directory, "child.log");
  const inherited = process.env.USBMUXD_SOCKET_ADDRESS;
  const inheritedHost = process.env.GO_IOS_AGENT_HOST;
  const environment = { USBMUXD_SOCKET_ADDRESS: "tcp://127.0.0.1:12345", GO_IOS_AGENT_HOST: "192.0.2.1",
    ENABLE_GO_IOS_AGENT: "user" };
  const child = await runtimeCommands.start(process.execPath, [
    "-e", "console.log('fixture-output', process.env.USBMUXD_SOCKET_ADDRESS, process.env.GO_IOS_AGENT_HOST, JSON.stringify(process.env.ENABLE_GO_IOS_AGENT)); setInterval(() => {}, 1000)",
  ], log, environment);
  t.after(async () => { await child.stop(); await rm(directory, { recursive: true, force: true }); });
  child.assertRunning();
  for (let attempt = 0; attempt < 100 && !(await readFile(log, "utf8")).includes("fixture-output"); attempt++) await delay(10);
  assert.match(await readFile(log, "utf8"), /fixture-output/);
  assert.match(await readFile(log, "utf8"), /tcp:\/\/127\.0\.0\.1:12345/);
  assert.match(await readFile(log, "utf8"), /12345 127\.0\.0\.1 ""/);
  assert.equal((await runtimeCommands.run(process.execPath,
    ["-e", "console.log(process.env.USBMUXD_SOCKET_ADDRESS)"], 1000, undefined, false, undefined, environment)).trim(),
  environment.USBMUXD_SOCKET_ADDRESS);
  assert.deepEqual(JSON.parse(await runtimeCommands.run(process.execPath,
    ["-e", "console.log(JSON.stringify({host:process.env.GO_IOS_AGENT_HOST,agent:process.env.ENABLE_GO_IOS_AGENT}))"],
    1000, undefined, false, undefined, environment)), { host: "127.0.0.1", agent: "" });
  assert.equal((await runtimeCommands.run(process.execPath,
    ["-e", "console.error('fixture-stderr-evidence')"], 1000, undefined, false, undefined, environment, "stderr")).trim(),
  "fixture-stderr-evidence");
  assert.equal(process.env.USBMUXD_SOCKET_ADDRESS, inherited);
  assert.equal(process.env.GO_IOS_AGENT_HOST, inheritedHost);
  await child.stop();
  await child.exited;
  assert.throws(() => child.assertRunning(), { code: "IOS_RUNTIME_FAILED" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtimeCommands.run(process.execPath, ["-e", "process.exit(0)"], 1000, controller.signal),
    { code: "CANCELLED" });
  const failureLog = join(directory, "command-failure.log");
  await assert.rejects(runtimeCommands.run(process.execPath,
    ["-e", "console.error('fixture-private-diagnostic'); process.exit(1)"], 1000, undefined, true, failureLog),
  (error: unknown) => error instanceof MobileUseError && error.code === "IOS_RUNTIME_FAILED" &&
    error.actionMayHaveRun && !error.message.includes("fixture-private-diagnostic"));
  assert.match(await readFile(failureLog, "utf8"), /fixture-private-diagnostic/);
});

test("passive USB discovery lists unselectable UDIDs before MOBILE_USE_IOS_RUNNER_BUNDLE_ID is configured", async () => {
  let commandCalls = 0;
  const usb: UsbBackend = {
    async readBuid() { return "fixture-buid"; },
    async readPairRecord() { return Buffer.from("pair"); },
    async list() { return [{ udid: IOS_UDID, deviceId: 1 }, { udid: IOS_OTHER_UDID, deviceId: 2 }]; },
    async connect() { throw usbFailure("WDA_UNAVAILABLE"); },
  };
  const commands: RuntimeCommands = {
    async run() { commandCalls++; return JSON.stringify({ version: "v1.3.2" }); },
    async start() { throw runtimeFailure("IOS_RUNTIME_FAILED"); },
  };
  const pool = new ManagedIosRuntimePool(
    () => readRuntimeConfig({ MOBILE_USE_PLATFORM: "ios", MOBILE_USE_IOS_RUNTIME: "managed" }),
    usb,
    commands,
    { platform: "win32" },
  );
  const service = new IosMobileUseService(undefined, Date.now, pool);
  const devices = await service.listDevices();
  assert.equal(commandCalls, 0);
  assert.deepEqual(devices.map((entry) => ({ endpointId: entry.endpointId, selectable: entry.selectable })), [
    { endpointId: IOS_ENDPOINT, selectable: false },
    { endpointId: `ios:usb:${IOS_OTHER_UDID}`, selectable: false },
  ]);
  assert.ok(devices.every((entry) => entry.reason?.includes("MOBILE_USE_IOS_RUNNER_BUNDLE_ID")));
  await assert.rejects(service.doctor(), { code: "IOS_RUNTIME_CONFIG_INVALID" });
  assert.ok(service.iosRuntime);
  await assert.rejects(service.iosRuntime({ kind: "status" }), { code: "IOS_RUNTIME_CONFIG_INVALID" });
});

test("ManagedIosRuntimePool runs multiple USB UDIDs with ephemeral tunnel ports alongside external WDA and isolates concurrent sessions", async (t) => {
  const [wdaUsb1, wdaUsb2, wdaExt] = await Promise.all([
    createIosFixture(),
    createIosFixture(),
    createIosFixture(),
  ]);
  wdaUsb1.state.uuid = "11111111-1111-4111-8111-111111111111";
  wdaUsb1.state.buttonLabel = "USB One";
  wdaUsb2.state.uuid = "22222222-2222-4222-8222-222222222222";
  wdaUsb2.state.buttonLabel = "USB Two";
  wdaExt.state.uuid = "33333333-3333-4333-8333-333333333333";
  wdaExt.state.buttonLabel = "External Three";

  const directory = await mkdtemp(join(tmpdir(), "mobile-use-runtime-pool-"));
  const otherEndpoint = `ios:usb:${IOS_OTHER_UDID}`;
  const extEndpoint = `ios:${new URL(wdaExt.url).host}`;
  const connected = new Set([IOS_UDID, IOS_OTHER_UDID]);
  const running = new Set<string>();
  const mounted = new Set<string>();
  const tunnelPorts = new Map<string, number>();
  const wdaUrls = new Map<string, string>([
    [IOS_UDID, wdaUsb1.url],
    [IOS_OTHER_UDID, wdaUsb2.url],
  ]);

  const usb: UsbBackend = {
    async readBuid() { return "fixture-host-buid"; },
    async readPairRecord(udid) { return Buffer.from(`pair-${udid}`); },
    async list() {
      return [...connected].map((udid, index) => ({ udid, deviceId: index + 1 }));
    },
    async connect(udid, _port, signal) {
      if (!connected.has(udid)) throw usbFailure("DEVICE_NOT_FOUND");
      if (!running.has(udid)) throw usbFailure("WDA_UNAVAILABLE");
      const targetUrl = wdaUrls.get(udid);
      assert.ok(targetUrl);
      return new Promise((resolve, reject) => {
        const socket = createConnection({
          host: "127.0.0.1",
          port: Number(new URL(targetUrl).port),
          ...(signal ? { signal } : {}),
        });
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    },
  };

  const commands: RuntimeCommands = {
    async run(_file, args) {
      if (args[0] === "version") return JSON.stringify({ version: "v1.3.2" });
      const udid = args[1] ?? "";
      if (args.includes("info")) return JSON.stringify({ UniqueDeviceID: udid, ProductVersion: "18.5" });
      if (args.includes("image") && args.includes("list")) {
        return JSON.stringify(mounted.has(udid)
          ? { level: "INFO", msg: "image signature", signature: "aabbccdd" }
          : { level: "INFO", msg: "none" });
      }
      if (args.includes("image")) mounted.add(udid);
      return "";
    },
    async start(_file, args) {
      const udid = args[1] ?? "";
      const portIndex = args.indexOf("--tunnel-info-port");
      if (portIndex >= 0 && !args.includes("runwda")) {
        tunnelPorts.set(udid, Number(args[portIndex + 1]));
      }
      const isWda = args.includes("runwda");
      if (isWda) running.add(udid);
      let stopped = false;
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      const owned: OwnedProcess = {
        exited,
        assertRunning() { if (stopped) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
        async stop() {
          stopped = true;
          if (isWda) running.delete(udid);
          resolveExited?.();
        },
      };
      return owned;
    },
  };

  const pool = new ManagedIosRuntimePool({
    executable: "fixture-go-ios",
    bundleId: "example.runner.xctrunner",
    stateDirectory: directory,
    devicePort: 8100,
    tunnelPort: 0,
  }, usb, commands, { platform: "win32", tunnelCheck: async () => {}, readinessTimeoutMs: 1000, pollMs: 5, stopTimeoutMs: 50 });

  const service = new IosMobileUseService(wdaExt.url, Date.now, pool);
  t.after(async () => {
    await service.stop();
    await Promise.all([wdaUsb1.close(), wdaUsb2.close(), wdaExt.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  assert.ok(service.iosRuntime);
  const [prep1, prep2] = await Promise.all([
    service.iosRuntime({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false }),
    service.iosRuntime({ kind: "start", endpointId: otherEndpoint, installRunner: false }),
  ]);
  assert.ok(prep1.runtimeToken && prep2.runtimeToken);
  assert.notEqual(prep1.runtimeToken, prep2.runtimeToken);

  for (const endpointId of [IOS_ENDPOINT, otherEndpoint]) {
    for (let i = 0; i < 200; i++) {
      const current = await service.iosRuntime({ kind: "status", endpointId });
      if (current.state === "awaiting-developer-trust") break;
      await delay(5);
    }
  }
  assert.equal((await service.iosRuntime({ kind: "status", runtimeToken: prep1.runtimeToken })).udid, IOS_UDID);
  assert.equal((await service.iosRuntime({ kind: "status", runtimeToken: prep2.runtimeToken })).udid, IOS_OTHER_UDID);

  await Promise.all([
    service.iosRuntime({ kind: "confirm_trust", runtimeToken: prep1.runtimeToken }),
    service.iosRuntime({ kind: "confirm_trust", runtimeToken: prep2.runtimeToken }),
  ]);
  for (const endpointId of [IOS_ENDPOINT, otherEndpoint]) {
    for (let i = 0; i < 200; i++) {
      const current = await service.iosRuntime({ kind: "status", endpointId });
      if (current.state === "ready") break;
      await delay(5);
    }
  }

  const combinedStatus = await service.iosRuntime({ kind: "status" });
  assert.equal(combinedStatus.runtimes?.length, 2);
  assert.notEqual(tunnelPorts.get(IOS_UDID), tunnelPorts.get(IOS_OTHER_UDID));
  assert.ok(JSON.parse(await readFile(join(directory, "locks", `${IOS_UDID}.lock`), "utf8")).token === prep1.runtimeToken);
  assert.ok(JSON.parse(await readFile(join(directory, "locks", `${IOS_OTHER_UDID}.lock`), "utf8")).token === prep2.runtimeToken);

  const devices = await service.listDevices();
  assert.deepEqual(devices.map((entry) => ({ id: entry.endpointId, selectable: entry.selectable })), [
    { id: IOS_ENDPOINT, selectable: true },
    { id: otherEndpoint, selectable: true },
    { id: extEndpoint, selectable: true },
  ]);

  const sel1 = await service.selectDevice(IOS_ENDPOINT);
  const sel2 = await service.selectDevice(otherEndpoint);
  const selExt = await service.selectDevice(extEndpoint);
  assert.equal(new Set([sel1.targetToken, sel2.targetToken, selExt.targetToken]).size, 3);

  const [obs1, obs2, obsExt] = await Promise.all([
    service.observe(sel1.targetToken, undefined, false),
    service.observe(sel2.targetToken, undefined, false),
    service.observe(selExt.targetToken, undefined, false),
  ]);
  const usb1Button = obs1.observation.elements.find((element) => element.label === "USB One" || element.text === "USB One");
  assert.ok(usb1Button);
  assert.ok(obs2.observation.elements.some((element) => element.label === "USB Two" || element.text === "USB Two"));
  assert.ok(obsExt.observation.elements.some((element) => element.label === "External Three" || element.text === "External Three"));

  // Verify per-target queue concurrency: USB 2 and External WDA complete while USB 1 is blocked in dispatch.
  let releaseUsb1: (() => void) | undefined;
  let enteredUsb1: (() => void) | undefined;
  const usb1Entered = new Promise<void>((resolve) => { enteredUsb1 = resolve; });
  wdaUsb1.state.actionHook = () => new Promise<void>((resolve) => { releaseUsb1 = resolve; enteredUsb1?.(); });

  const order: string[] = [];
  const act1Promise = service.act(sel1.targetToken, obs1.observation.observationId, {
    kind: "tap",
    target: { elementRef: usb1Button.ref },
  }).then((res) => {
    order.push("usb1");
    return res;
  });
  await usb1Entered;

  const [act2, actExt] = await Promise.all([
    service.act(sel2.targetToken, obs2.observation.observationId, { kind: "type_text", text: "-two" }).then((res) => {
      order.push("usb2");
      return res;
    }),
    service.act(selExt.targetToken, obsExt.observation.observationId, { kind: "type_text", text: "-ext" }).then((res) => {
      order.push("ext");
      return res;
    }),
  ]);
  assert.equal(act2.dispatchStatus, "dispatched");
  assert.equal(actExt.dispatchStatus, "dispatched");
  assert.equal(wdaUsb2.state.value, "safe-two");
  assert.equal(wdaExt.state.value, "safe-ext");
  assert.equal(order.includes("usb1"), false);

  wdaUsb1.state.actionHook = undefined;
  releaseUsb1?.();
  assert.equal((await act1Promise).dispatchStatus, "dispatched");

  // Re-selecting USB 1 retires only USB 1's old token as STALE_TARGET without disturbing USB 2 or External WDA.
  const sel1Next = await service.selectDevice(IOS_ENDPOINT);
  await assert.rejects(service.observe(sel1.targetToken, undefined, false), { code: "STALE_TARGET" });
  assert.equal((await service.getForegroundApp(sel2.targetToken)).packageName, "example.demo");
  assert.equal((await service.getForegroundApp(selExt.targetToken)).packageName, "example.demo");

  // Explicit runtime stop on USB 1 deselects only USB 1 (TARGET_NOT_SELECTED) and closes only USB 1's WDA session.
  const stopped1 = await service.iosRuntime({ kind: "stop", runtimeToken: prep1.runtimeToken });
  assert.equal(stopped1.state, "stopped");
  assert.equal(wdaUsb1.state.sessionId, null);
  assert.notEqual(wdaUsb2.state.sessionId, null);
  assert.notEqual(wdaExt.state.sessionId, null);
  await assert.rejects(service.observe(sel1Next.targetToken, undefined, false), { code: "TARGET_NOT_SELECTED" });

  // Scoped USB disconnect on USB 2 retires USB 2 as lost while External WDA continues working.
  connected.delete(IOS_OTHER_UDID);
  const remainingDevices = await service.listDevices();
  assert.deepEqual(remainingDevices.map((entry) => entry.endpointId), [IOS_ENDPOINT, extEndpoint]);
  await assert.rejects(service.observe(sel2.targetToken, undefined, false), { code: "TRANSPORT_LOST" });
  assert.equal((await service.observe(selExt.targetToken, undefined, false)).observation.targetToken, selExt.targetToken);

  // Reconnect USB 2 so service.stop() can verify port closure cleanly, then assert all remaining sessions close.
  connected.add(IOS_OTHER_UDID);
  await service.stop();
  assert.equal(wdaExt.state.sessionId, null);
});

test("pool tunnel-port allocation is atomic across concurrent starts and retains claims until cleanup succeeds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-ios-port-claims-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const thirdUdid = "00008120-001C25D40C0A0099";
  const otherEndpoint = `ios:usb:${IOS_OTHER_UDID}`;
  const thirdEndpoint = `ios:usb:${thirdUdid}`;
  const [wda1, wda2, wda3] = await Promise.all([createIosFixture(), createIosFixture(), createIosFixture()]);
  t.after(async () => { await Promise.all([wda1.close(), wda2.close(), wda3.close()]); });

  const connected = new Set<string>([IOS_UDID, IOS_OTHER_UDID, thirdUdid]);
  const running = new Set<string>();
  const mounted = new Set<string>();
  const failTunnelStop = new Set<string>();
  const assignedPorts: Array<{ udid: string; port: number }> = [];
  const wdaUrls = new Map<string, string>([
    [IOS_UDID, wda1.url],
    [IOS_OTHER_UDID, wda2.url],
    [thirdUdid, wda3.url],
  ]);

  let notifyFirstProber: (() => void) | undefined;
  const firstProberEntered = new Promise<void>((resolve) => { notifyFirstProber = resolve; });

  const usb: UsbBackend = {
    async readBuid() { return "fixture-host-buid"; },
    async readPairRecord(udid) { return Buffer.from(`pair-${udid}`); },
    async list() { return [...connected].map((udid, index) => ({ udid, deviceId: index + 1 })); },
    async connect(udid, _port, signal) {
      if (!connected.has(udid)) throw usbFailure("DEVICE_NOT_FOUND");
      if (!running.has(udid)) {
        if (udid === IOS_OTHER_UDID) await firstProberEntered;
        throw usbFailure("WDA_UNAVAILABLE");
      }
      const targetUrl = wdaUrls.get(udid);
      assert.ok(targetUrl);
      return new Promise((resolve, reject) => {
        const socket = createConnection({
          host: "127.0.0.1",
          port: Number(new URL(targetUrl).port),
          ...(signal ? { signal } : {}),
        });
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    },
  };

  const commands: RuntimeCommands = {
    async run(_file, args) {
      if (args[0] === "version") return JSON.stringify({ version: "v1.3.2" });
      const udid = args[1] ?? "";
      if (args.includes("info")) return JSON.stringify({ UniqueDeviceID: udid, ProductVersion: "18.5" });
      if (args.includes("image") && args.includes("list")) {
        return JSON.stringify(mounted.has(udid)
          ? { level: "INFO", msg: "image signature", signature: "aabbccdd" }
          : { level: "INFO", msg: "none" });
      }
      if (args.includes("image")) mounted.add(udid);
      return "";
    },
    async start(_file, args) {
      const udid = args[1] ?? "";
      const portIndex = args.indexOf("--tunnel-info-port");
      if (portIndex >= 0 && !args.includes("runwda")) {
        assignedPorts.push({ udid, port: Number(args[portIndex + 1]) });
      }
      const isWda = args.includes("runwda");
      if (isWda) running.add(udid);
      let stopped = false;
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      return {
        exited,
        assertRunning() { if (stopped) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
        async stop() {
          if (!isWda && failTunnelStop.has(udid)) throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED");
          stopped = true;
          if (isWda) running.delete(udid);
          resolveExited?.();
        },
      };
    },
  };

  // Deliberately return colliding primary & adjacent candidate ports across concurrent starts and failed/cleanup-failed states.
  const probeSequence = [
    52000, // Runtime 1 gets [52000, 52001]
    52000, // Runtime 2 collides with Runtime 1 primary -> rejected
    52001, // Runtime 2 collides with Runtime 1 derived listener -> rejected
    51999, // Runtime 2 derived listener (52000) collides with Runtime 1 primary -> rejected
    52002, // Runtime 2 gets [52002, 52003]
    52000, // Runtime 3 while Runtime 1 is "failed" (unstopped) -> still rejected!
    52002, // Runtime 3 while Runtime 2 is "cleanup-failed" -> still rejected!
    52004, // Runtime 3 gets [52004, 52005]
    52002, // Restarting Runtime 1 while Runtime 2 is still "cleanup-failed" -> still rejected!
    52000, // Restarting Runtime 1 after its own clean stop -> now accepted!
  ];
  const pool = new ManagedIosRuntimePool(
    {
      executable: "fixture-go-ios",
      bundleId: "example.runner.xctrunner",
      stateDirectory: directory,
      devicePort: 8100,
      tunnelPort: 0,
    },
    usb,
    commands,
    {
      platform: "win32",
      tunnelCheck: async () => {},
      readinessTimeoutMs: 1000,
      pollMs: 5,
      stopTimeoutMs: 50,
      portProber: async () => {
        const isFirst = probeSequence.length === 10;
        const next = probeSequence.shift();
        assert.ok(next !== undefined, "unexpected extra port probe");
        if (isFirst) {
          notifyFirstProber?.();
          await delay(5);
        }
        return next;
      },
    },
  );
  t.after(async () => {
    failTunnelStop.clear();
    await pool.close().catch(() => {});
  });

  const [start1, start2] = await Promise.all([
    pool.control({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false }),
    pool.control({ kind: "start", endpointId: otherEndpoint, installRunner: false }),
  ]);
  assert.ok(start1.runtimeToken && start2.runtimeToken);

  for (const endpointId of [IOS_ENDPOINT, otherEndpoint]) {
    for (let i = 0; i < 200; i++) {
      if (pool.status({ endpointId }).state === "awaiting-developer-trust") break;
      await delay(5);
    }
  }
  assert.equal(assignedPorts.find((entry) => entry.udid === IOS_UDID)?.port, 52000);
  assert.equal(assignedPorts.find((entry) => entry.udid === IOS_OTHER_UDID)?.port, 52002);

  await pool.control({ kind: "confirm_trust", runtimeToken: start1.runtimeToken });
  for (let i = 0; i < 200; i++) {
    if (pool.status({ endpointId: IOS_ENDPOINT }).state === "ready") break;
    await delay(5);
  }

  // Transition Runtime 1 to "failed" via USB disconnect (before cleanup runs) and Runtime 2 to "cleanup-failed".
  connected.delete(IOS_UDID);
  await pool.devices();
  assert.equal(pool.status({ endpointId: IOS_ENDPOINT }).state, "failed");

  failTunnelStop.add(IOS_OTHER_UDID);
  await assert.rejects(pool.control({ kind: "stop", runtimeToken: start2.runtimeToken }), { code: "IOS_RUNTIME_CLEANUP_FAILED" });
  assert.equal(pool.status({ endpointId: otherEndpoint }).state, "cleanup-failed");

  // Starting Runtime 3 must still reject both [52000, 52001] (failed, not yet cleaned) and [52002, 52003] (cleanup-failed).
  const start3 = await pool.control({ kind: "start", endpointId: thirdEndpoint, installRunner: false });
  assert.ok(start3.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if (pool.status({ endpointId: thirdEndpoint }).state === "awaiting-developer-trust") break;
    await delay(5);
  }
  assert.equal(assignedPorts.find((entry) => entry.udid === thirdUdid)?.port, 52004);

  // Cleanly stop Runtime 1 (releasing [52000, 52001]), reconnect USB 1, and confirm [52000, 52001] can now be reused while [52002, 52003] stays claimed.
  connected.add(IOS_UDID);
  await pool.control({ kind: "stop", runtimeToken: start1.runtimeToken });
  assert.equal(pool.status({ endpointId: IOS_ENDPOINT }).state, "stopped");

  assignedPorts.length = 0;
  const restart1 = await pool.control({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false });
  assert.ok(restart1.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if (pool.status({ endpointId: IOS_ENDPOINT }).state === "awaiting-developer-trust") break;
    await delay(5);
  }
  assert.equal(assignedPorts.find((entry) => entry.udid === IOS_UDID)?.port, 52000);
  assert.equal(probeSequence.length, 0);

  failTunnelStop.clear();
  await pool.control({ kind: "stop", runtimeToken: restart1.runtimeToken });
  await pool.control({ kind: "stop", runtimeToken: start3.runtimeToken });
});

test("runtime stop aborts and drains active and newly published targets and leaves them TARGET_NOT_SELECTED", async (t) => {
  const f = await runtimeFixture(t);
  const readyStatus = await f.ready();
  assert.ok(readyStatus.runtimeToken);

  // Part 1: Drain an already in-flight target operation before DELETE /session runs.
  const activeSelected = await f.service.selectDevice(IOS_ENDPOINT);
  let notifySource: (() => void) | undefined;
  const sourceEntered = new Promise<void>((resolve) => { notifySource = resolve; });
  let releaseSource: (() => void) | undefined;
  const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
  f.http.state.sourceHook = async () => {
    notifySource?.();
    await sourceGate;
  };

  let deleteSentBeforeObserveSettled = true;
  const activeObserve = f.service.observe(activeSelected.targetToken, undefined, false).catch((error: unknown) => {
    deleteSentBeforeObserveSettled = f.http.calls.some((call) => call.method === "DELETE");
    throw error;
  });
  await sourceEntered;
  assert.ok(f.service.iosRuntime);
  const firstStop = f.service.iosRuntime({ kind: "stop", runtimeToken: readyStatus.runtimeToken });
  await assert.rejects(activeObserve, (error: unknown) =>
    error instanceof MobileUseError && ["CANCELLED", "TRANSPORT_LOST"].includes(error.code));
  assert.equal(deleteSentBeforeObserveSettled, false, "DELETE /session must wait for in-flight target work to settle");
  f.http.state.sourceHook = undefined;
  releaseSource?.();
  assert.equal((await firstStop).state, "stopped");
  assert.equal(f.http.calls.some((call) => call.method === "DELETE"), true);
  assert.equal(f.http.state.sessionId, null);
  await assert.rejects(f.service.observe(activeSelected.targetToken, undefined, false), { code: "TARGET_NOT_SELECTED" });

  // Part 2: Recollect and clean up a target published by an in-flight selectDevice queued ahead of stop on hostQueue.
  const restarted = await f.ready();
  assert.ok(restarted.runtimeToken);
  let notifyCreate: (() => void) | undefined;
  const createEntered = new Promise<void>((resolve) => { notifyCreate = resolve; });
  let releaseCreate: (() => void) | undefined;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  f.http.state.sessionCreateHook = async () => {
    notifyCreate?.();
    await createGate;
  };

  const selectPromise = f.service.selectDevice(IOS_ENDPOINT);
  await createEntered;

  // Queue stop while selectDevice is still in flight on hostQueue (before any target is in targets).
  const stopPromise = f.service.iosRuntime({ kind: "stop", runtimeToken: restarted.runtimeToken });

  let inFlightObserve: Promise<unknown> | undefined;
  const selectedPromise = selectPromise.then((selected) => {
    inFlightObserve = f.service.observe(selected.targetToken, undefined, false);
    return selected;
  });

  f.http.state.sessionCreateHook = undefined;
  releaseCreate?.();
  const selected = await selectedPromise;

  await assert.rejects(inFlightObserve!, (error: unknown) =>
    error instanceof MobileUseError && ["CANCELLED", "TRANSPORT_LOST", "TARGET_NOT_SELECTED"].includes(error.code));
  const stopped = await stopPromise;
  assert.equal(stopped.state, "stopped");
  assert.equal(f.http.state.sessionId, null);
  await assert.rejects(f.service.observe(selected.targetToken, undefined, false), { code: "TARGET_NOT_SELECTED" });
});

test("coexistence mode validates managed prerequisites in doctor, isolates listDevices failures, and scopes shutdown cleanup errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-ios-coexistence-isolation-"));
  const [wdaUsb, wdaExt] = await Promise.all([createIosFixture(), createIosFixture()]);
  wdaUsb.state.uuid = "11111111-1111-4111-8111-111111111111";
  wdaExt.state.uuid = "33333333-3333-4333-8333-333333333333";
  const extEndpoint = `ios:${new URL(wdaExt.url).host}`;

  t.after(async () => {
    await Promise.all([wdaUsb.close(), wdaExt.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  // 1. Coexistence doctor() still fails with IOS_RUNTIME_CONFIG_INVALID when Runner bundle ID is missing even if external WDA is reachable.
  const unconfiguredCoexisting = createMobileService({
    MOBILE_USE_PLATFORM: "ios",
    MOBILE_USE_IOS_RUNTIME: "managed",
    MOBILE_USE_WDA_URL: wdaExt.url,
  });
  await assert.rejects(unconfiguredCoexisting.doctor(), { code: "IOS_RUNTIME_CONFIG_INVALID" });

  let usbListFails = false;
  let goIosInvalid = false;
  const connected = new Set<string>([IOS_UDID]);
  const running = new Set<string>();
  const mounted = new Set<string>();

  const usb: UsbBackend = {
    async readBuid() { return "fixture-host-buid"; },
    async readPairRecord(udid) { return Buffer.from(`pair-${udid}`); },
    async list() {
      if (usbListFails) throw usbFailure("IOS_USB_UNAVAILABLE");
      return [...connected].map((udid, index) => ({ udid, deviceId: index + 1 }));
    },
    async connect(udid, _port, signal) {
      if (!connected.has(udid)) throw usbFailure("DEVICE_NOT_FOUND");
      if (!running.has(udid)) throw usbFailure("WDA_UNAVAILABLE");
      return new Promise((resolve, reject) => {
        const socket = createConnection({
          host: "127.0.0.1",
          port: Number(new URL(wdaUsb.url).port),
          ...(signal ? { signal } : {}),
        });
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    },
  };

  const commands: RuntimeCommands = {
    async run(_file, args) {
      if (args[0] === "version") {
        return JSON.stringify({ version: goIosInvalid ? "v1.0.0" : "v1.3.2" });
      }
      const udid = args[1] ?? "";
      if (args.includes("info")) return JSON.stringify({ UniqueDeviceID: udid, ProductVersion: "18.5" });
      if (args.includes("image") && args.includes("list")) {
        return JSON.stringify(mounted.has(udid)
          ? { level: "INFO", msg: "image signature", signature: "aabbccdd" }
          : { level: "INFO", msg: "none" });
      }
      if (args.includes("image")) mounted.add(udid);
      return "";
    },
    async start(_file, args) {
      const udid = args[1] ?? "";
      const isWda = args.includes("runwda");
      if (isWda) running.add(udid);
      let stopped = false;
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      return {
        exited,
        assertRunning() { if (stopped) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
        async stop() {
          stopped = true;
          if (isWda) running.delete(udid);
          resolveExited?.();
        },
      };
    },
  };

  const pool = new ManagedIosRuntimePool(
    {
      executable: "fixture-go-ios",
      bundleId: "example.runner.xctrunner",
      stateDirectory: directory,
      devicePort: 8100,
      tunnelPort: 0,
    },
    usb,
    commands,
    { platform: "win32", tunnelCheck: async () => {}, readinessTimeoutMs: 1000, pollMs: 5, stopTimeoutMs: 50 },
  );
  const service = new IosMobileUseService(wdaExt.url, Date.now, pool);

  // Unsupported go-ios fails doctor() even when external WDA is healthy.
  goIosInvalid = true;
  await assert.rejects(service.doctor(), { code: "IOS_RUNTIME_CONFIG_INVALID" });
  goIosInvalid = false;
  const healthyDoctor = await service.doctor();
  assert.equal(healthyDoctor.status, "ready");

  assert.ok(service.iosRuntime);
  const prep = await service.iosRuntime({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false });
  assert.ok(prep.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if ((await service.iosRuntime({ kind: "status", endpointId: IOS_ENDPOINT })).state === "awaiting-developer-trust") break;
    await delay(5);
  }
  await service.iosRuntime({ kind: "confirm_trust", runtimeToken: prep.runtimeToken });
  for (let i = 0; i < 200; i++) {
    if ((await service.iosRuntime({ kind: "status", endpointId: IOS_ENDPOINT })).state === "ready") break;
    await delay(5);
  }

  // 2a. External WDA probe failure does not discard healthy USB endpoints in listDevices().
  wdaExt.state.simulator = true;
  const withFailedExt = await service.listDevices();
  assert.deepEqual(
    withFailedExt.map((entry) => ({ id: entry.endpointId, selectable: entry.selectable, state: entry.state })),
    [
      { id: IOS_ENDPOINT, selectable: true, state: "device" },
      { id: extEndpoint, selectable: false, state: "offline" },
    ],
  );
  wdaExt.state.simulator = false;

  // 2b. Managed USB endpoint probe failure or USB enumeration failure does not block healthy external WDA discovery.
  wdaUsb.state.simulator = true;
  const withFailedUsbProbe = await service.listDevices();
  assert.deepEqual(
    withFailedUsbProbe.map((entry) => ({ id: entry.endpointId, selectable: entry.selectable, state: entry.state })),
    [
      { id: IOS_ENDPOINT, selectable: false, state: "offline" },
      { id: extEndpoint, selectable: true, state: "device" },
    ],
  );
  wdaUsb.state.simulator = false;

  usbListFails = true;
  const withFailedUsbList = await service.listDevices();
  assert.deepEqual(
    withFailedUsbList.map((entry) => ({ id: entry.endpointId, selectable: entry.selectable })),
    [{ id: extEndpoint, selectable: true }],
  );
  usbListFails = false;

  // 3. Selecting both USB and external WDA, then failing ONLY external WDA session DELETE on stop(), still cleanly stops USB and removes its UDID lock.
  await service.selectDevice(IOS_ENDPOINT);
  await service.selectDevice(extEndpoint);
  const lockFile = join(directory, "locks", `${IOS_UDID}.lock`);
  await stat(lockFile);

  wdaExt.state.failSessionDelete = true;
  await assert.rejects(service.stop(), { code: "WDA_COMMAND_FAILED" });
  assert.equal(pool.status({ endpointId: IOS_ENDPOINT }).state, "stopped");
  await assert.rejects(stat(lockFile), { code: "ENOENT" });
});

test("reselection drains target operations appended while waiting on existing.queue before replacing the WDA session", async (t) => {
  const f = await runtimeFixture(t);
  await f.ready();
  const selected1 = await f.service.selectDevice(IOS_ENDPOINT);

  let notifySource1: (() => void) | undefined;
  const sourceEntered1 = new Promise<void>((resolve) => { notifySource1 = resolve; });
  let releaseSource1: (() => void) | undefined;
  const sourceGate1 = new Promise<void>((resolve) => { releaseSource1 = resolve; });

  let notifySource2: (() => void) | undefined;
  const sourceEntered2 = new Promise<void>((resolve) => { notifySource2 = resolve; });
  let releaseSource2: (() => void) | undefined;
  const sourceGate2 = new Promise<void>((resolve) => { releaseSource2 = resolve; });

  let sourceCalls = 0;
  f.http.state.sourceHook = async () => {
    sourceCalls++;
    if (sourceCalls === 1) {
      notifySource1?.();
      await sourceGate1;
    } else if (sourceCalls === 2) {
      notifySource2?.();
      await sourceGate2;
    }
  };

  const obs1 = f.service.observe(selected1.targetToken, undefined, false);
  await sourceEntered1;

  // Start reselection while obs1 holds existing.queue, then append obs2 after reselection captured the first queue snapshot.
  const reselectPromise = f.service.selectDevice(IOS_ENDPOINT);
  await delay(10);
  const obs2 = f.service.observe(selected1.targetToken, undefined, false);

  releaseSource1?.();
  await obs1;
  await sourceEntered2;

  // While obs2 is still executing, reselection must not have retired selected1 or closed its WDA session yet.
  assert.equal(f.http.calls.some((call) => call.method === "DELETE"), false);

  f.http.state.sourceHook = undefined;
  releaseSource2?.();
  const obs2Result = await obs2;
  assert.equal(obs2Result.observation.targetToken, selected1.targetToken);

  const selected2 = await reselectPromise;
  assert.notEqual(selected2.targetToken, selected1.targetToken);
  assert.equal(f.http.calls.some((call) => call.method === "DELETE"), true);
  await assert.rejects(f.service.observe(selected1.targetToken, undefined, false), { code: "STALE_TARGET" });
});

test("managed doctor translates missing go-ios executable to IOS_RUNTIME_CONFIG_INVALID while preserving cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-ios-missing-exe-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const missingExecutable = join(directory, "nonexistent-go-ios-binary");
  const service = createMobileService({
    MOBILE_USE_PLATFORM: "ios",
    MOBILE_USE_IOS_RUNTIME: "managed",
    MOBILE_USE_IOS_RUNNER_BUNDLE_ID: "example.runner.xctrunner",
    MOBILE_USE_GO_IOS_PATH: missingExecutable,
  });

  await assert.rejects(service.doctor(), { code: "IOS_RUNTIME_CONFIG_INVALID" });

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(service.doctor(aborted.signal), { code: "CANCELLED" });

  // Also cover in-flight cancellation during version execution on ManagedIosRuntime directly.
  let notifyVersionRun: (() => void) | undefined;
  const versionEntered = new Promise<void>((resolve) => { notifyVersionRun = resolve; });
  const inFlightAbort = new AbortController();
  const runtime = new ManagedIosRuntime(
    {
      executable: missingExecutable,
      bundleId: "example.runner.xctrunner",
      stateDirectory: directory,
      devicePort: 8100,
      tunnelPort: 60105,
    },
    undefined,
    {
      async run(_file, _args, _timeout, signal) {
        notifyVersionRun?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new MobileUseError("CANCELLED", "Cancelled.", "Retry.")), { once: true });
        });
        return "";
      },
      async start() { throw new Error("unexpected start"); },
    },
    { platform: "win32" },
  );
  const prereqPromise = runtime.prerequisites(inFlightAbort.signal);
  await versionEntered;
  inFlightAbort.abort();
  await assert.rejects(prereqPromise, { code: "CANCELLED" });
});

test("selectDevice retires the newly created target on final ensure invalidation or cancellation without leaking active targets", async (t) => {
  const [wdaUsb, wdaExt] = await Promise.all([createIosFixture(), createIosFixture()]);
  wdaUsb.state.uuid = "11111111-1111-4111-8111-111111111111";
  wdaExt.state.uuid = "33333333-3333-4333-8333-333333333333";
  const extEndpoint = `ios:${new URL(wdaExt.url).host}`;
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-ensure-retire-"));

  const connected = new Set<string>([IOS_UDID]);
  const running = new Set<string>();
  const mounted = new Set<string>();

  const usb: UsbBackend = {
    async readBuid() { return "fixture-host-buid"; },
    async readPairRecord(udid) { return Buffer.from(`pair-${udid}`); },
    async list() { return [...connected].map((udid, index) => ({ udid, deviceId: index + 1 })); },
    async connect(udid, _port, signal) {
      if (!connected.has(udid)) throw usbFailure("DEVICE_NOT_FOUND");
      if (!running.has(udid)) throw usbFailure("WDA_UNAVAILABLE");
      return new Promise((resolve, reject) => {
        const socket = createConnection({
          host: "127.0.0.1",
          port: Number(new URL(wdaUsb.url).port),
          ...(signal ? { signal } : {}),
        });
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    },
  };

  const commands: RuntimeCommands = {
    async run(_file, args) {
      if (args[0] === "version") return JSON.stringify({ version: "v1.3.2" });
      const udid = args[1] ?? "";
      if (args.includes("info")) return JSON.stringify({ UniqueDeviceID: udid, ProductVersion: "18.5" });
      if (args.includes("image") && args.includes("list")) {
        return JSON.stringify(mounted.has(udid)
          ? { level: "INFO", msg: "image signature", signature: "aabbccdd" }
          : { level: "INFO", msg: "none" });
      }
      if (args.includes("image")) mounted.add(udid);
      return "";
    },
    async start(_file, args) {
      const udid = args[1] ?? "";
      const isWda = args.includes("runwda");
      if (isWda) running.add(udid);
      let stopped = false;
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      return {
        exited,
        assertRunning() { if (stopped) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
        async stop() {
          stopped = true;
          if (isWda) running.delete(udid);
          resolveExited?.();
        },
      };
    },
  };

  const pool = new ManagedIosRuntimePool(
    {
      executable: "fixture-go-ios",
      bundleId: "example.runner.xctrunner",
      stateDirectory: directory,
      devicePort: 8100,
      tunnelPort: 0,
    },
    usb,
    commands,
    { platform: "win32", tunnelCheck: async () => {}, readinessTimeoutMs: 1000, pollMs: 5, stopTimeoutMs: 50 },
  );
  const service = new IosMobileUseService(wdaExt.url, Date.now, pool);
  t.after(async () => {
    await service.stop();
    await Promise.all([wdaUsb.close(), wdaExt.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  assert.ok(service.iosRuntime);
  const prep = await service.iosRuntime({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false });
  assert.ok(prep.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if ((await service.iosRuntime({ kind: "status", endpointId: IOS_ENDPOINT })).state === "awaiting-developer-trust") break;
    await delay(5);
  }
  await service.iosRuntime({ kind: "confirm_trust", runtimeToken: prep.runtimeToken });
  for (let i = 0; i < 200; i++) {
    if ((await service.iosRuntime({ kind: "status", endpointId: IOS_ENDPOINT })).state === "ready") break;
    await delay(5);
  }

  // Keep USB selected so we also verify unrelated targets stay untouched.
  const usbSelected = await service.selectDevice(IOS_ENDPOINT);
  const internalTargets = (service as unknown as { targets: Map<string, unknown> }).targets;
  assert.equal(internalTargets.size, 1);

  // 1. Invalidating failure during final ensure() on external WDA retires the new target and drops ownership.
  wdaExt.state.sessionCreateHook = async () => {
    wdaExt.state.statusHook = () => {
      wdaExt.state.iosVersion = "16.7";
    };
  };
  await assert.rejects(service.selectDevice(extEndpoint), { code: "DEVICE_UNSUPPORTED" });
  wdaExt.state.sessionCreateHook = undefined;
  wdaExt.state.statusHook = undefined;
  wdaExt.state.iosVersion = "17.5";

  // Only the USB target remains active; ownership of the unverified external session was dropped.
  assert.equal(internalTargets.size, 1);
  assert.equal((await service.getForegroundApp(usbSelected.targetToken)).packageName, "example.demo");
  const afterInvalidEnsure = await service.listDevices();
  assert.equal(afterInvalidEnsure.find((entry) => entry.endpointId === extEndpoint)?.selectable, false);
  wdaExt.state.sessionId = null;

  // 2. Cancellation during final ensure() removes the unreturned target while keeping ownership so reselection closes the session cleanly.
  const cancelEnsure = new AbortController();
  wdaExt.state.sessionCreateHook = async () => {
    wdaExt.state.statusHook = () => {
      cancelEnsure.abort();
    };
  };
  await assert.rejects(service.selectDevice(extEndpoint, cancelEnsure.signal), { code: "CANCELLED" });
  wdaExt.state.sessionCreateHook = undefined;
  wdaExt.state.statusHook = undefined;
  assert.equal(internalTargets.size, 1);
  assert.ok(wdaExt.state.sessionId);

  const extSelected = await service.selectDevice(extEndpoint);
  assert.equal(internalTargets.size, 2);
  assert.equal(wdaExt.calls.some((call) => call.method === "DELETE"), true);
  assert.equal((await service.getForegroundApp(extSelected.targetToken)).packageName, "example.demo");
});

test("doctor probe failures retire sessions for the probed endpoint without disturbing unrelated targets", async (t) => {
  // 1. Managed-only mode: failing primary probe in doctor() retires that endpoint's session while keeping a second USB device intact.
  const [wdaUsb1, wdaUsb2, wdaExt] = await Promise.all([
    createIosFixture(),
    createIosFixture(),
    createIosFixture(),
  ]);
  wdaUsb1.state.uuid = "11111111-1111-4111-8111-111111111111";
  wdaUsb2.state.uuid = "22222222-2222-4222-8222-222222222222";
  wdaExt.state.uuid = "33333333-3333-4333-8333-333333333333";
  const otherEndpoint = `ios:usb:${IOS_OTHER_UDID}`;
  const extEndpoint = `ios:${new URL(wdaExt.url).host}`;
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-doctor-retire-"));

  const connected = new Set<string>([IOS_UDID, IOS_OTHER_UDID]);
  const running = new Set<string>();
  const mounted = new Set<string>();
  const wdaUrls = new Map<string, string>([
    [IOS_UDID, wdaUsb1.url],
    [IOS_OTHER_UDID, wdaUsb2.url],
  ]);

  const usb: UsbBackend = {
    async readBuid() { return "fixture-host-buid"; },
    async readPairRecord(udid) { return Buffer.from(`pair-${udid}`); },
    async list() { return [...connected].map((udid, index) => ({ udid, deviceId: index + 1 })); },
    async connect(udid, _port, signal) {
      if (!connected.has(udid)) throw usbFailure("DEVICE_NOT_FOUND");
      if (!running.has(udid)) throw usbFailure("WDA_UNAVAILABLE");
      const targetUrl = wdaUrls.get(udid);
      assert.ok(targetUrl);
      return new Promise((resolve, reject) => {
        const socket = createConnection({
          host: "127.0.0.1",
          port: Number(new URL(targetUrl).port),
          ...(signal ? { signal } : {}),
        });
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    },
  };

  const commands: RuntimeCommands = {
    async run(_file, args) {
      if (args[0] === "version") return JSON.stringify({ version: "v1.3.2" });
      const udid = args[1] ?? "";
      if (args.includes("info")) return JSON.stringify({ UniqueDeviceID: udid, ProductVersion: "18.5" });
      if (args.includes("image") && args.includes("list")) {
        return JSON.stringify(mounted.has(udid)
          ? { level: "INFO", msg: "image signature", signature: "aabbccdd" }
          : { level: "INFO", msg: "none" });
      }
      if (args.includes("image")) mounted.add(udid);
      return "";
    },
    async start(_file, args) {
      const udid = args[1] ?? "";
      const isWda = args.includes("runwda");
      if (isWda) running.add(udid);
      let stopped = false;
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      return {
        exited,
        assertRunning() { if (stopped) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
        async stop() {
          stopped = true;
          if (isWda) running.delete(udid);
          resolveExited?.();
        },
      };
    },
  };

  const managedDir = join(directory, "managed");
  const coexistingDir = join(directory, "coexisting");
  const managedPool = new ManagedIosRuntimePool(
    {
      executable: "fixture-go-ios",
      bundleId: "example.runner.xctrunner",
      stateDirectory: managedDir,
      devicePort: 8100,
      tunnelPort: 0,
    },
    usb,
    commands,
    { platform: "win32", tunnelCheck: async () => {}, readinessTimeoutMs: 1000, pollMs: 5, stopTimeoutMs: 50 },
  );
  const coexistingPool = new ManagedIosRuntimePool(
    {
      executable: "fixture-go-ios",
      bundleId: "example.runner.xctrunner",
      stateDirectory: coexistingDir,
      devicePort: 8100,
      tunnelPort: 0,
    },
    usb,
    commands,
    { platform: "win32", tunnelCheck: async () => {}, readinessTimeoutMs: 1000, pollMs: 5, stopTimeoutMs: 50 },
  );
  const managedService = new IosMobileUseService(undefined, Date.now, managedPool);
  const coexistingService = new IosMobileUseService(wdaExt.url, Date.now, coexistingPool);

  t.after(async () => {
    try {
      await coexistingService.stop().catch(() => {});
      await managedService.stop().catch(() => {});
    } finally {
      await Promise.all([wdaUsb1.close(), wdaUsb2.close(), wdaExt.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  assert.ok(managedService.iosRuntime);
  const [prep1, prep2] = await Promise.all([
    managedService.iosRuntime({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false }),
    managedService.iosRuntime({ kind: "start", endpointId: otherEndpoint, installRunner: false }),
  ]);
  assert.ok(prep1.runtimeToken && prep2.runtimeToken);
  for (const endpointId of [IOS_ENDPOINT, otherEndpoint]) {
    for (let i = 0; i < 200; i++) {
      if ((await managedService.iosRuntime({ kind: "status", endpointId })).state === "awaiting-developer-trust") break;
      await delay(5);
    }
  }
  await Promise.all([
    managedService.iosRuntime({ kind: "confirm_trust", runtimeToken: prep1.runtimeToken }),
    managedService.iosRuntime({ kind: "confirm_trust", runtimeToken: prep2.runtimeToken }),
  ]);
  for (const endpointId of [IOS_ENDPOINT, otherEndpoint]) {
    for (let i = 0; i < 200; i++) {
      if ((await managedService.iosRuntime({ kind: "status", endpointId })).state === "ready") break;
      await delay(5);
    }
  }

  const selUsb1 = await managedService.selectDevice(IOS_ENDPOINT);
  const selUsb2 = await managedService.selectDevice(otherEndpoint);
  await managedService.observe(selUsb1.targetToken, undefined, false);
  await managedService.observe(selUsb2.targetToken, undefined, false);

  wdaUsb1.state.simulator = true;
  await assert.rejects(managedService.doctor(), { code: "DEVICE_UNSUPPORTED" });
  wdaUsb1.state.simulator = false;

  // USB 1 was retired as lost (even after recovery), while USB 2 remains valid.
  await assert.rejects(managedService.observe(selUsb1.targetToken, undefined, false), { code: "TRANSPORT_LOST" });
  assert.equal((await managedService.getForegroundApp(selUsb2.targetToken)).packageName, "example.demo");
  await managedService.stop();

  // 2. Coexistence/external mode: failing external WDA probe in doctor() retires external session while keeping USB 2 intact.
  assert.ok(coexistingService.iosRuntime);
  const prepCoexisting = await coexistingService.iosRuntime({ kind: "start", endpointId: otherEndpoint, installRunner: false });
  assert.ok(prepCoexisting.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if ((await coexistingService.iosRuntime({ kind: "status", endpointId: otherEndpoint })).state === "awaiting-developer-trust") break;
    await delay(5);
  }
  await coexistingService.iosRuntime({ kind: "confirm_trust", runtimeToken: prepCoexisting.runtimeToken });
  for (let i = 0; i < 200; i++) {
    if ((await coexistingService.iosRuntime({ kind: "status", endpointId: otherEndpoint })).state === "ready") break;
    await delay(5);
  }

  const coexistingUsb2 = await coexistingService.selectDevice(otherEndpoint);
  const coexistingExt = await coexistingService.selectDevice(extEndpoint);
  await coexistingService.observe(coexistingExt.targetToken, undefined, false);

  wdaExt.state.simulator = true;
  await assert.rejects(coexistingService.doctor(), { code: "DEVICE_UNSUPPORTED" });
  wdaExt.state.simulator = false;

  await assert.rejects(coexistingService.observe(coexistingExt.targetToken, undefined, false), { code: "TRANSPORT_LOST" });
  assert.equal((await coexistingService.getForegroundApp(coexistingUsb2.targetToken)).packageName, "example.demo");
});

test("explicit nonzero tunnelPort allows other UDIDs after failed startup cleanup releases its port claim", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-use-explicit-tunnel-port-"));
  const otherEndpoint = `ios:usb:${IOS_OTHER_UDID}`;
  const thirdUdid = "00008110-001234563CC0801E";
  const thirdEndpoint = `ios:usb:${thirdUdid}`;
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const connected = new Set<string>([IOS_UDID, IOS_OTHER_UDID, thirdUdid]);
  const failMountFor = new Set<string>([IOS_UDID]);

  const usb: UsbBackend = {
    async readBuid() { return "fixture-host-buid"; },
    async readPairRecord(udid) { return Buffer.from(`pair-${udid}`); },
    async list() { return [...connected].map((udid, index) => ({ udid, deviceId: index + 1 })); },
    async connect(udid) {
      if (!connected.has(udid)) throw usbFailure("DEVICE_NOT_FOUND");
      throw usbFailure("WDA_UNAVAILABLE");
    },
  };

  const commands: RuntimeCommands = {
    async run(_file, args) {
      if (args[0] === "version") return JSON.stringify({ version: "v1.3.2" });
      const udid = args[1] ?? "";
      if (args.includes("info")) return JSON.stringify({ UniqueDeviceID: udid, ProductVersion: "18.5" });
      if (args.includes("image") && args.includes("list")) {
        return JSON.stringify(failMountFor.has(udid)
          ? { level: "INFO", msg: "none" }
          : { level: "INFO", msg: "image signature", signature: "aabbccdd" });
      }
      return "";
    },
    async start() {
      let stopped = false;
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      return {
        exited,
        assertRunning() { if (stopped) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
        async stop() {
          stopped = true;
          resolveExited?.();
        },
      };
    },
  };

  const pool = new ManagedIosRuntimePool(
    {
      executable: "fixture-go-ios",
      bundleId: "example.runner.xctrunner",
      stateDirectory: directory,
      devicePort: 8100,
      tunnelPort: 54100,
    },
    usb,
    commands,
    {
      platform: "win32",
      tunnelCheck: async () => {},
      readinessTimeoutMs: 1000,
      pollMs: 5,
      stopTimeoutMs: 50,
      portProber: async (port) => port,
    },
  );
  t.after(async () => {
    await pool.close().catch(() => {});
  });

  // 1. UDID 1 fails during preparation and cleanup() succeeds, releasing its port claim while leaving status in "failed".
  const start1 = await pool.control({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: false });
  assert.ok(start1.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if (pool.status({ endpointId: IOS_ENDPOINT }).state === "failed") break;
    await delay(5);
  }
  assert.equal(pool.status({ endpointId: IOS_ENDPOINT }).state, "failed");

  // 2. UDID 2 can now start on the explicitly configured tunnel port without requiring an explicit stop on UDID 1.
  const start2 = await pool.control({ kind: "start", endpointId: otherEndpoint, installRunner: false });
  assert.ok(start2.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if (pool.status({ endpointId: otherEndpoint }).state === "awaiting-developer-trust") break;
    await delay(5);
  }

  // 3. If UDID 2 transitions to "failed" while still holding its port claim (before cleanup), starting UDID 3 is still rejected.
  const runtime2 = (pool as unknown as { runtimes: Map<string, ManagedIosRuntime> }).runtimes.get(IOS_OTHER_UDID);
  assert.ok(runtime2);
  runtime2.handleUsbDisconnected();
  assert.equal(pool.status({ endpointId: otherEndpoint }).state, "failed");
  await assert.rejects(pool.control({ kind: "start", endpointId: thirdEndpoint, installRunner: false }), { code: "IOS_RUNTIME_CONFLICT" });

  await pool.control({ kind: "stop", runtimeToken: start2.runtimeToken });
  const start3 = await pool.control({ kind: "start", endpointId: thirdEndpoint, installRunner: false });
  assert.ok(start3.runtimeToken);
  for (let i = 0; i < 200; i++) {
    if (pool.status({ endpointId: thirdEndpoint }).state === "awaiting-developer-trust") break;
    await delay(5);
  }
  await pool.control({ kind: "stop", runtimeToken: start3.runtimeToken });
});


