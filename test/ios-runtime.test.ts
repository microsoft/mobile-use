import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { MobileUseError } from "../src/errors.js";
import { createMobileService } from "../src/service-factory.js";
import { runtimeCommands } from "../src/ios/runtime-process.js";
import { availableTunnelPort } from "../src/ios/runtime.js";
import { MuxConnection } from "../src/ios/usb.js";
import { IOS_ENDPOINT, IOS_UDID, runtimeFixture, waitRuntimeState } from "./ios-runtime-fixture.js";

test("managed mode is explicit, rejects ambiguous endpoint/configuration and leaves external mode unchanged", async () => {
  assert.equal(createMobileService({ MOBILE_USE_PLATFORM: "ios" }).iosRuntime, undefined);
  const config = { MOBILE_USE_PLATFORM: "ios", MOBILE_USE_IOS_RUNTIME: "managed",
    MOBILE_USE_IOS_RUNNER_BUNDLE_ID: "example.runner.xctrunner" };
  assert.equal(typeof createMobileService(config).iosRuntime, "function");
  for (const environment of [
    { ...config, MOBILE_USE_WDA_URL: "http://127.0.0.1:8100" },
    { ...config, MOBILE_USE_IOS_RUNTIME: "automatic" },
    { ...config, MOBILE_USE_IOS_RUNNER_BUNDLE_ID: "example.runner" },
    { ...config, MOBILE_USE_IOS_RUNNER_IPA: "relative.ipa" },
    { ...config, MOBILE_USE_IOS_TUNNEL_PORT: "65535" },
    { ...config, MOBILE_USE_IOS_TUNNEL_PORT: "65536" },
  ]) assert.throws(() => createMobileService(environment), { code: "IOS_RUNTIME_CONFIG_INVALID" });
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
  await f.service.stop();
  assert.equal(f.calls.some((entry) => entry.args.includes("uninstall")), false);
  assert.deepEqual(f.events, ["start-tunnel", "image", "install", "start-wda", "stop-wda", "stop-tunnel"]);
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
  const environment = { USBMUXD_SOCKET_ADDRESS: "tcp://127.0.0.1:12345" };
  const child = await runtimeCommands.start(process.execPath, [
    "-e", "console.log('fixture-output', process.env.USBMUXD_SOCKET_ADDRESS); setInterval(() => {}, 1000)",
  ], log, environment);
  t.after(async () => { await child.stop(); await rm(directory, { recursive: true, force: true }); });
  child.assertRunning();
  for (let attempt = 0; attempt < 100 && !(await readFile(log, "utf8")).includes("fixture-output"); attempt++) await delay(10);
  assert.match(await readFile(log, "utf8"), /fixture-output/);
  assert.match(await readFile(log, "utf8"), /tcp:\/\/127\.0\.0\.1:12345/);
  assert.equal((await runtimeCommands.run(process.execPath,
    ["-e", "console.log(process.env.USBMUXD_SOCKET_ADDRESS)"], 1000, undefined, false, undefined, environment)).trim(),
  environment.USBMUXD_SOCKET_ADDRESS);
  assert.equal(process.env.USBMUXD_SOCKET_ADDRESS, inherited);
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
