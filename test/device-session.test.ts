import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { MonitorFactory } from "../src/adb.js";
import { MobileUseService } from "../src/device-session.js";
import { MobileUseError } from "../src/errors.js";
import { chunk, FakeAdb, FakeMonitors, displayDiagnostics, editField, hasCode, hierarchy, INVENTORY, node, pixelPng, png, USB, USB_LINE, WIFI, WIFI_LINE } from "./helpers.js";

function harness(t: TestContext, now?: () => number) {
  const adb = new FakeAdb();
  const monitors = new FakeMonitors(adb);
  const service = new MobileUseService(adb, monitors.factory, now);
  t.after(() => service.stop());
  return { adb, monitors, service };
}

async function ready(service: MobileUseService, endpoint = USB) {
  const selected = await service.selectDevice(endpoint);
  const screen = await service.observe(selected.targetToken);
  return { selected, screen };
}

test("startup is inert; failed discovery is not an empty device list", async (t) => {
  const { adb, monitors, service } = harness(t);
  assert.equal(adb.calls.length, 0);
  assert.equal(adb.startServerCalls, 0);
  assert.equal(monitors.sessions.length, 0);
  assert.deepEqual(await service.doctor(), {
    status: "ready", platform: "android",
    adbExecutable: "C:\\fixture-only\\adb.exe", platformToolsVersion: "36.0.0",
  });
  assert.deepEqual(adb.calls.map((call) => call.args), [["version"]]);
  assert.equal(adb.startServerCalls, 0, "doctor must never start the server");
  assert.equal(monitors.sessions.length, 0, "host checks must not start transport monitoring");
  adb.handler = (call) => {
    if (call.args[0] === "devices") throw new MobileUseError("ADB_FAILED", "Fixture discovery failed.", "Fix the fixture.");
    return undefined;
  };
  await assert.rejects(service.listDevices(), hasCode("ADB_FAILED"));
  adb.handler = undefined;
  adb.inventory = "List of devices attached\n";
  assert.deepEqual(await service.listDevices(), []);
  assert.equal(adb.inputs.length, 0, "onboarding must not perform setup or device input");
  assert.equal(monitors.sessions.length, 0, "inventory must not select or monitor a device");
  assert.equal(adb.startServerCalls, 0, "ordinary discovery must never start the server");
  await assert.rejects(service.selectDevice(USB), hasCode("DEVICE_NOT_FOUND"));
});

test("explicit server startup returns discovery without selecting, monitoring, or controlling a phone", async (t) => {
  const { adb, monitors, service } = harness(t);
  const result = await service.startAdbServer();
  assert.equal(result.status, "ready");
  assert.equal(result.startupAttempted, true);
  assert.equal(result.devices.length, 2);
  assert.equal(adb.startServerCalls, 1);
  assert.equal(adb.calls.length, 0, "startup must not invoke an ADB client that might restart a changed server");
  assert.equal(monitors.sessions.length, 0);
  assert.equal(adb.inputs.length, 0);
  await assert.rejects(service.observe("unselected"), hasCode("TRANSPORT_LOST"));
});

test("new or uncertain startup invalidates tokens while compatible server reuse preserves a current target", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.startupAttempted = false;
  assert.equal((await service.startAdbServer()).startupAttempted, false);
  await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
  adb.startupAttempted = true;
  await service.startAdbServer();
  await assert.rejects(service.observe(selected.targetToken), hasCode("TRANSPORT_LOST"));
  const newTarget = await service.selectDevice(USB);
  adb.startServerHandler = async () => {
    throw new MobileUseError("CANCELLED", "Fixture startup cancelled.", "Check the local server.", false, true);
  };
  await assert.rejects(service.startAdbServer(), hasCode("CANCELLED"));
  await assert.rejects(service.observe(newTarget.targetToken), hasCode("TRANSPORT_LOST"));
});

test("cancelled or stopped startup does not issue commands, and empty discovery remains explicit", async (t) => {
  const { adb, service } = harness(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.startAdbServer(controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.startServerCalls, 0);
  adb.inventory = "List of devices attached\n";
  assert.deepEqual((await service.startAdbServer()).devices, []);
  service.stop();
  await assert.rejects(service.startAdbServer(), hasCode("SERVER_STOPPED"));
  assert.equal(adb.startServerCalls, 1);
});

test("old or unrecognized Platform-Tools are not reported ready", async (t) => {
  const { adb, service } = harness(t);
  for (const output of ["Version 29.0.6\n", "not an ADB version"]) {
    adb.handler = () => Buffer.from(output);
    await assert.rejects(service.doctor(), hasCode("ADB_VERSION_UNSUPPORTED"));
  }
});

test("unauthorized, offline, and emulator endpoints are listed but not selected", async (t) => {
  const { adb, service } = harness(t);
  adb.inventory = "List of devices attached\nLOCKED unauthorized transport_id:1\nOFF offline transport_id:2\nemulator-5554 device transport_id:3\n";
  assert.deepEqual((await service.listDevices()).map((endpoint) => endpoint.state), ["unauthorized", "offline", "device"]);
  await assert.rejects(service.selectDevice("LOCKED"), hasCode("DEVICE_UNAUTHORIZED"));
  await assert.rejects(service.selectDevice("OFF"), hasCode("DEVICE_OFFLINE"));
  await assert.rejects(service.selectDevice("emulator-5554"), hasCode("DEVICE_UNSUPPORTED"));
  assert.equal(adb.inputs.length, 0);
});

test("selection is explicit and USB/Wi-Fi endpoints on the same phone get different tokens", async (t) => {
  const { adb, service } = harness(t);
  await service.listDevices();
  await assert.rejects(service.observe("not-selected"), hasCode("TARGET_NOT_SELECTED"));
  const usb = await service.selectDevice(USB);
  const old = await service.observe(usb.targetToken);
  const wifi = await service.selectDevice(WIFI);
  assert.equal(usb.identity.hardwareSerial, wifi.identity.hardwareSerial);
  assert.notEqual(usb.targetToken, wifi.targetToken);
  assert.equal(wifi.endpoint.kind, "paired-wireless");
  await assert.rejects(service.observe(usb.targetToken), hasCode("STALE_TARGET"));
  await assert.rejects(service.act(wifi.targetToken, old.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  const screen = await service.observe(wifi.targetToken);
  await service.act(wifi.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
  assert.deepEqual(adb.inputs.map((call) => call.args.slice(0, 2)), [["-t", "12"]]);
});

test("metadata resembling a transport ID cannot redirect selection or input", async (t) => {
  const { adb, service } = harness(t);
  adb.inventory = "List of devices attached\nPOC_PHONE device usb:1-2 product:transport_id:0 device:transport_id:81 transport_id:7\n";
  const { selected, screen } = await ready(service);
  assert.equal(selected.endpoint.transportId, "7");
  await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
  assert.ok(adb.calls.filter((call) => call.args[0] === "-t").every((call) => call.args[1] === "7"));
  assert.equal(adb.inputs.length, 1);
});

test("wake requires explicit selection but no observation and invalidates earlier observations", async (t) => {
  const { adb, service } = harness(t);
  await assert.rejects(service.wake("unselected"), hasCode("TARGET_NOT_SELECTED"));
  assert.equal(adb.calls.length, 0);
  const selected = await service.selectDevice(USB);
  Object.assign(adb.keyguard, { showing: true, inputRestricted: true, screenState: "SCREEN_STATE_OFF" });
  assert.deepEqual(await service.wake(selected.targetToken), { status: "awake-and-unlocked", keyguardDismissed: true });
  assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator")), false);
  const screen = await service.observe(selected.targetToken);
  await service.wake(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  const fresh = await service.observe(selected.targetToken);
  await service.act(selected.targetToken, fresh.observation.observationId, { kind: "key", key: "HOME" });
});

test("wake rejects stale selection, changed physical identity, and lost transport without fallback", async (t) => {
  const { adb, monitors, service } = harness(t);
  const usb = await service.selectDevice(USB);
  const wifi = await service.selectDevice(WIFI);
  await assert.rejects(service.wake(usb.targetToken), hasCode("STALE_TARGET"));
  adb.properties["ro.serialno"] = "ANOTHER_PHONE";
  await assert.rejects(service.wake(wifi.targetToken), hasCode("TRANSPORT_LOST"));
  adb.properties["ro.serialno"] = USB;
  const selected = await service.selectDevice(USB);
  monitors.disconnect();
  await assert.rejects(service.wake(selected.targetToken), hasCode("TRANSPORT_LOST"));
  assert.equal(adb.inputs.length, 0);
});

test("wake failure clears old observations and reports a post-wake disconnect as uncertain", async (t) => {
  const { adb, monitors, service } = harness(t);
  const { selected, screen } = await ready(service);
  Object.assign(adb.keyguard, { showing: true, secure: true, inputRestricted: true });
  await assert.rejects(service.wake(selected.targetToken), hasCode("MANUAL_UNLOCK_REQUIRED"));
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  Object.assign(adb.keyguard, { showing: false, inputRestricted: false });
  let inventories = 0;
  adb.handler = (call) => {
    if (call.args[0] === "devices" && ++inventories === 2) {
      monitors.disconnect();
      throw new MobileUseError("TRANSPORT_LOST", "Fixture disconnected.", "Reselect.");
    }
    return undefined;
  };
  await assert.rejects(service.wake(selected.targetToken), (error: unknown) => {
    hasCode("TRANSPORT_LOST")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
});

test("wake cancellation before dispatch performs no device commands", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  const count = adb.calls.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.wake(selected.targetToken, controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, count);
});

test("targeted doctor reports readiness without capture, implicit selection, or waking", async (t) => {
  const { adb, monitors, service } = harness(t);
  await assert.rejects(service.doctor(undefined, "unselected"), hasCode("TARGET_NOT_SELECTED"));
  const selected = await service.selectDevice(USB);
  Object.assign(adb.keyguard, { screenState: "SCREEN_STATE_OFF", showing: true, inputRestricted: true });
  const diagnosis = await service.doctor(undefined, selected.targetToken);
  assert.deepEqual(diagnosis.deviceStatus, {
    status: "ok", screenState: "asleep", lockState: "locked",
    secure: false, userId: 0, readyForInteraction: false, error: null,
  });
  assert.equal((await service.doctor()).deviceStatus, undefined, "host-only doctor must not implicitly target the selected phone");
  assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator") || call.args.includes("activities")), false);
  assert.equal(adb.inputs.length, 0);
  const replacement = await service.selectDevice(USB);
  await assert.rejects(service.doctor(undefined, selected.targetToken), hasCode("STALE_TARGET"));
  monitors.disconnect();
  await assert.rejects(service.doctor(undefined, replacement.targetToken), hasCode("TRANSPORT_LOST"));
});

test("not-ready observations return status without capturing lock-screen content in either screenshot mode", async (t) => {
  const { adb, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  for (const includeScreenshot of [true, false]) {
    for (const screenState of ["SCREEN_STATE_OFF", "SCREEN_STATE_TURNING_ON", "SCREEN_STATE_TURNING_OFF", "SCREEN_STATE_ON"]) {
      Object.assign(adb.keyguard, { screenState, showing: true, inputRestricted: true, secure: screenState === "SCREEN_STATE_ON" });
      adb.calls = [];
      const { observation, image } = await service.observe(targetToken, undefined, includeScreenshot);
      assert.equal(observation.deviceStatus?.readyForInteraction, false);
      assert.equal(observation.deviceStatus?.lockState, "locked");
      assert.equal(observation.screenshot.status, "skipped");
      assert.equal(observation.hierarchy.status, "unavailable");
      assert.equal(observation.hierarchy.error?.code, adb.keyguard.secure ? "MANUAL_UNLOCK_REQUIRED" : "DEVICE_NOT_READY");
      assert.equal(observation.display, null);
      assert.deepEqual(observation.elements, []);
      assert.deepEqual(observation.windows, []);
      assert.equal(image, null);
      assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator") || call.args.includes("activities")), false);
      assert.equal(adb.inputs.length, 0);
    }
  }
  adb.keyguard.secure = false;
  await service.wake(targetToken);
  assert.equal((await service.observe(targetToken)).observation.deviceStatus?.readyForInteraction, true);
});

test("unavailable readiness stays unknown and never captures or silently claims an unlocked phone", async (t) => {
  const { adb, monitors, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  for (const failure of ["malformed", "timeout"] as const) {
    adb.handler = (call) => {
      if (!call.args.includes("policy")) return undefined;
      if (failure === "timeout") throw new MobileUseError("ADB_TIMEOUT", "Read timed out.", "Check the phone manually.");
      return Buffer.from("private unrecognized OEM diagnostics");
    };
    const status = (await service.doctor(undefined, targetToken)).deviceStatus;
    assert.equal(status?.status, "unavailable");
    assert.equal(status?.screenState, "unknown");
    assert.equal(status?.lockState, "unknown");
    assert.equal(status?.secure, null);
    assert.equal(status?.readyForInteraction, false);
    assert.equal(status?.error?.code, failure === "timeout" ? "ADB_TIMEOUT" : "KEYGUARD_STATE_UNAVAILABLE");
    const screen = await service.observe(targetToken);
    assert.equal(screen.image, null);
    assert.deepEqual(screen.observation.deviceStatus, status);
    assert.doesNotMatch(JSON.stringify(screen), /private unrecognized OEM diagnostics/);
  }
  assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator")), false);
  assert.equal(adb.inputs.length, 0);
  const controller = new AbortController();
  adb.handler = (call) => {
    if (call.args.includes("policy")) controller.abort();
    return undefined;
  };
  await assert.rejects(service.doctor(controller.signal, targetToken), hasCode("CANCELLED"));
  adb.handler = (call) => {
    if (call.args.includes("policy")) {
      monitors.disconnect();
      throw new MobileUseError("ADB_TIMEOUT", "Interrupted status read.", "Recheck.");
    }
    return undefined;
  };
  await assert.rejects(service.observe(targetToken), hasCode("TRANSPORT_LOST"));
});

test("screen content is withheld when the phone locks or readiness becomes unknown during capture", async (t) => {
  const { adb, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  for (const change of ["locked", "unknown"]) {
    Object.assign(adb.keyguard, { showing: false, secure: false, screenState: "SCREEN_STATE_ON" });
    adb.handler = (call) => {
      if (call.args.includes("uiautomator")) {
        if (change === "locked") Object.assign(adb.keyguard, { showing: true, secure: true });
        else adb.keyguard.screenState = "OEM_UNKNOWN";
      }
      return undefined;
    };
    const screen = await service.observe(targetToken);
    assert.equal(screen.observation.deviceStatus?.lockState, change === "locked" ? "locked" : "unknown");
    assert.equal(screen.observation.hierarchy.error?.code, change === "locked" ? "MANUAL_UNLOCK_REQUIRED" : "KEYGUARD_STATE_UNAVAILABLE");
    assert.equal(screen.observation.screenshot.status, "unavailable", "a captured but withheld image must not be reported as skipped");
    assert.equal(screen.image, null);
    assert.deepEqual(screen.observation.elements, []);
    assert.deepEqual(screen.observation.windows, []);
  }
});

test("user changes during capture or immediately before input reject the interaction", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  let checks = 0;
  adb.handler = (call) => {
    if (call.args.includes("policy") && ++checks === 3) adb.keyguard.userId = 10;
    return undefined;
  };
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 0);
  adb.keyguard.userId = 0;
  adb.handler = (call) => {
    if (call.args.includes("uiautomator")) adb.keyguard.userId = 10;
    return undefined;
  };
  await assert.rejects(service.observe(selected.targetToken), hasCode("STALE_OBSERVATION"));
});

test("navigation rechecks readiness immediately before dispatch without implicitly waking", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  let checks = 0;
  adb.handler = (call) => {
    if (call.args.includes("policy") && ++checks === 3) adb.keyguard.screenState = "SCREEN_STATE_OFF";
    return undefined;
  };
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("DEVICE_NOT_READY"));
  assert.equal(checks, 3);
  assert.equal(adb.inputs.length, 0);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
});

for (const helper of ["gestures", "text"] as const) {
  test(`${helper} input rechecks readiness and user after helper verification`, async (t) => {
    const { adb, service } = harness(t);
    const { targetToken } = await service.selectDevice(USB);
    if (helper === "gestures") await service.prepareGestures(targetToken);
    else {
      adb.xml = hierarchy(editField());
      await service.prepareTextInput(targetToken);
    }
    const changes = [
      { code: "DEVICE_NOT_READY", apply: () => { adb.keyguard.screenState = "SCREEN_STATE_OFF"; } },
      { code: "MANUAL_UNLOCK_REQUIRED", apply: () => {
        Object.assign(adb.keyguard, { showing: true, inputRestricted: true, secure: true });
      } },
      { code: "STALE_OBSERVATION", apply: () => { adb.keyguard.userId = 10; } },
      { code: "KEYGUARD_STATE_UNAVAILABLE", apply: () => { adb.keyguard.screenState = "OEM_UNKNOWN"; } },
    ] as const;
    for (const change of changes) {
      Object.assign(adb.keyguard, {
        showing: false, secure: false, simSecure: false, inputRestricted: false,
        screenState: "SCREEN_STATE_ON", userId: 0,
      });
      adb.handler = undefined;
      const screen = await service.observe(targetToken, undefined, false);
      assert.equal(screen.observation.deviceStatus?.userId, 0);
      let checksumReads = 0;
      const expectedReads = helper === "text" ? 2 : 1;
      adb.handler = (call) => {
        if (call.args[3] === "sha256sum" && call.args[4]?.endsWith(`/${helper}.dex`)) {
          if (++checksumReads === expectedReads) change.apply();
        }
        return undefined;
      };
      const action = helper === "gestures"
        ? { kind: "double_tap", target: { elementRef: "e1" } }
        : { kind: "type_text", text: "中文" };
      await assert.rejects(service.act(targetToken, screen.observation.observationId, action), (error: unknown) => {
        assert.ok(error instanceof MobileUseError);
        assert.equal(error.code, change.code);
        assert.equal(error.actionMayHaveRun, false);
        return true;
      });
      assert.equal(checksumReads, expectedReads);
      assert.equal(adb.inputs.length, 0);
      await assert.rejects(service.act(targetToken, screen.observation.observationId, action), hasCode("STALE_OBSERVATION"));
    }
  });
}

test("readiness changes after input are returned without exposing lock-screen content", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.handler = (call) => {
    if (call.options.mutating) Object.assign(adb.keyguard, { showing: true, secure: true });
    return undefined;
  };
  const result = await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.after?.observation.deviceStatus?.lockState, "locked");
  assert.equal(result.after?.image, null);
  assert.deepEqual(result.after?.observation.elements, []);
  assert.equal(adb.inputs.length, 1);
});

test("a semantic tap is revalidated, returns a new observation, and never claims semantic success", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  assert.equal(screen.observation.nonAtomic, true);
  assert.equal(screen.observation.screenshot.status, "ok");
  assert.equal(screen.observation.hierarchy.status, "ok");
  const result = await service.act(selected.targetToken, screen.observation.observationId, { kind: "tap", target: { elementRef: "e1" } });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.verificationStatus, "requires-observation-review");
  assert.notEqual(result.after?.observation.observationId, screen.observation.observationId);
  assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "input", "tap", "24", "18"]);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 1);
});

test("hierarchy-only observations and chained actions never invoke screen capture", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy(editField({ text: "Fixture headline" }));
  const selected = await service.selectDevice(USB);
  await service.prepareGestures(selected.targetToken);
  let screen = await service.observe(selected.targetToken, undefined, false);
  assert.equal(screen.observation.elements[0]?.text, "Fixture headline");
  assert.deepEqual(screen.observation.display, { width: 80, height: 160, rotation: 0 });
  assert.deepEqual(screen.observation.hierarchy, { status: "ok", error: null });
  for (const action of [
    { kind: "tap", target: { elementRef: "e1" } },
    { kind: "double_tap", target: { elementRef: "e1" } },
    { kind: "type_text", text: "POC" },
    { kind: "key", key: "BACK" },
    { kind: "launch_app", packageName: "example.poc" },
  ]) {
    assert.equal(screen.image, null);
    assert.deepEqual(screen.observation.screenshot, { status: "skipped", error: null });
    assert.equal(screen.observation.captureTiming.screenshotDurationMs, null);
    assert.ok(screen.observation.captureTiming.hierarchyDurationMs >= 0);
    const result = await service.act(selected.targetToken, screen.observation.observationId, action);
    assert.equal(result.dispatchStatus, "dispatched");
    assert.equal(result.verificationStatus, "requires-observation-review");
    assert.ok(result.after);
    screen = result.after;
  }
  assert.equal(screen.image, null);
  assert.deepEqual(screen.observation.screenshot, { status: "skipped", error: null });
  assert.equal(adb.inputs.length, 5);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
});

test("hierarchy-only coordinate taps and swipes fail without input or screen capture", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const action of [
    { kind: "tap", target: { x: 10, y: 10 } },
    { kind: "double_tap", target: { x: 10, y: 10 } },
    { kind: "swipe", from: { x: 10, y: 100 }, to: { x: 10, y: 50 } },
  ]) {
    const screen = await service.observe(selected.targetToken, undefined, false);
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, action), hasCode("CAPTURE_UNAVAILABLE"));
  }
  assert.equal(adb.inputs.length, 0);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
});

test("double-taps revalidate a single target, consume one observation, and return a fresh screen", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  const prepared = await service.prepareGestures(selected.targetToken);
  for (const action of [
    { kind: "double_tap", target: { elementRef: "e1" } },
    { kind: "double_tap", target: { x: 24, y: 18 }, delayMs: 125 },
  ]) {
    const screen = await service.observe(selected.targetToken);
    const before = adb.calls.length;
    const result = await service.act(selected.targetToken, screen.observation.observationId, action);
    assert.equal(result.dispatchStatus, "dispatched");
    assert.equal(result.verificationStatus, "requires-observation-review");
    assert.notEqual(result.after?.observation.observationId, screen.observation.observationId);
    assert.deepEqual(adb.inputs.at(-1)?.args, [
      "-t", "7", "shell", `CLASSPATH=${prepared.remotePath}`, "app_process", "/",
      "dev.mobileuse.gestures.GestureMain", "24", "18", String(action.delayMs ?? 50),
    ]);
    assert.deepEqual(result.gestureTiming, {
      requestedDelayMs: action.delayMs ?? 50, actualGapMs: action.delayMs ?? 50,
    });
    assert.equal(adb.calls.slice(before).filter((call) => call.args.includes("screencap")).length, 2,
      "capture only before and after the pair, never between taps");
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, action), hasCode("STALE_OBSERVATION"));
  }
  assert.equal(adb.inputs.length, 2);
});

test("invalid double-tap pauses fail before device I/O and do not consume the observation", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  await service.prepareGestures(selected.targetToken);
  const screen = await service.observe(selected.targetToken);
  const calls = adb.calls.length;
  for (const delayMs of [-1, 251, 1.5, "50", "0;reboot", null]) {
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
      kind: "double_tap", target: { elementRef: "e1" }, delayMs,
    }), hasCode("INVALID_INPUT"));
  }
  assert.equal(adb.calls.length, calls);
  const result = await service.act(selected.targetToken, screen.observation.observationId, {
    kind: "double_tap", target: { elementRef: "e1" }, delayMs: 0,
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(adb.inputs.length, 1);
  assert.equal(adb.inputs[0]?.args.at(-1), "0");
});

test("an uncertain double-tap is not retried and consumes its observation", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  await service.prepareGestures(selected.targetToken);
  const screen = await service.observe(selected.targetToken);
  adb.handler = (call) => {
    if (call.options.mutating) {
      throw new MobileUseError("ADB_TIMEOUT", "Fixture double-tap may be partial.", "Observe before continuing.", false, true);
    }
    return undefined;
  };
  const result = await service.act(selected.targetToken, screen.observation.observationId, {
    kind: "double_tap", target: { elementRef: "e1" },
  });
  assert.equal(result.dispatchStatus, "outcome-unknown");
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.after, null);
  assert.equal(result.error?.code, "ADB_TIMEOUT");
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(result.error?.retryable, false);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "double_tap", target: { elementRef: "e1" },
  }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 1);
});

test("gesture preparation invalidates observations and is scoped to the selected transport", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  await service.prepareGestures(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "double_tap", target: { elementRef: "e1" },
  }), hasCode("STALE_OBSERVATION"));
  const wireless = await service.selectDevice(WIFI);
  const fresh = await service.observe(wireless.targetToken);
  await assert.rejects(service.act(wireless.targetToken, fresh.observation.observationId, {
    kind: "double_tap", target: { elementRef: "e1" },
  }), hasCode("GESTURE_HELPER_NOT_PREPARED"));
  await assert.rejects(service.prepareGestures(selected.targetToken), hasCode("STALE_TARGET"));
  assert.equal(adb.inputs.length, 0);
  assert.equal(adb.calls.filter((call) => call.args[2] === "push").length, 1);
});

test("expired observations and cancellation block double-taps before input", async (t) => {
  let time = 100_000;
  const { adb, service } = harness(t, () => time);
  const { selected, screen } = await ready(service);
  time += 30_001;
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "double_tap", target: { elementRef: "e1" },
  }), hasCode("STALE_OBSERVATION"));
  const fresh = await service.observe(selected.targetToken);
  const calls = adb.calls.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.act(selected.targetToken, fresh.observation.observationId, {
    kind: "double_tap", target: { x: 10, y: 10 },
  }, controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, calls);
  assert.equal(adb.inputs.length, 0);
});

test("hierarchy-only capture failure and empty content never fall back to screenshots", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  adb.xml = "ERROR: null root node";
  await assert.rejects(service.observe(selected.targetToken, undefined, false), hasCode("OBSERVATION_UNAVAILABLE"));
  adb.xml = hierarchy("");
  const empty = await service.observe(selected.targetToken, undefined, false);
  assert.equal(empty.image, null);
  assert.deepEqual(empty.observation.elements, []);
  assert.match(empty.observation.warnings.join(" "), /No semantic elements/);
  await assert.rejects(service.act(selected.targetToken, empty.observation.observationId, {
    kind: "tap", target: { elementRef: "e1" },
  }), hasCode("ELEMENT_CHANGED"));
  assert.equal(adb.inputs.length, 0);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
});

test("hierarchy-only input retains element, rotation, hierarchy, and display-state guards", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const change of ["element", "rotation", "hierarchy", "display"] as const) {
    adb.xml = hierarchy();
    adb.display = displayDiagnostics();
    const screen = await service.observe(selected.targetToken, undefined, false);
    if (change === "element") adb.xml = hierarchy(node({ text: "Changed" }));
    if (change === "rotation") {
      adb.xml = hierarchy(node(), 2);
      adb.display = displayDiagnostics(2);
    }
    if (change === "hierarchy") adb.xml = "ERROR: null root node";
    if (change === "display") adb.display = "Unrecognized display diagnostics";
    const code = change === "element" ? "ELEMENT_CHANGED" : change === "rotation" ? "STALE_OBSERVATION"
      : change === "hierarchy" ? "OBSERVATION_UNAVAILABLE" : "DISPLAY_STATE_UNAVAILABLE";
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
      kind: "tap", target: { elementRef: "e1" },
    }), hasCode(code));
  }
  const unverified = await service.observe(selected.targetToken, undefined, false);
  assert.equal(unverified.observation.display, null);
  assert.equal(unverified.observation.displayState.status, "unavailable");
  assert.equal(unverified.observation.displayState.error?.code, "DISPLAY_STATE_UNAVAILABLE");
  assert.equal(adb.inputs.length, 0);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
});

test("failed hierarchy-only post-action observation remains unverified without a screenshot fallback", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  const screen = await service.observe(selected.targetToken, undefined, false);
  adb.handler = (call) => {
    if (call.options.mutating) adb.xml = "";
    return undefined;
  };
  const result = await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "BACK" });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.after, null);
  assert.equal(result.error?.code, "OBSERVATION_UNAVAILABLE");
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(adb.inputs.length, 1);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
});

test("a new default observation explicitly returns to screenshot-plus-hierarchy capture", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  const textOnly = await service.observe(selected.targetToken, undefined, false);
  assert.equal(textOnly.image, null);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
  const full = await service.observe(selected.targetToken);
  assert.deepEqual(full.observation.screenshot, { status: "ok", error: null });
  assert.ok(full.image);
  await assert.rejects(service.act(selected.targetToken, textOnly.observation.observationId, {
    kind: "tap", target: { elementRef: "e1" },
  }), hasCode("STALE_OBSERVATION"));
  const fresh = await service.observe(selected.targetToken);
  const result = await service.act(selected.targetToken, fresh.observation.observationId, {
    kind: "tap", target: { x: 10, y: 10 },
  });
  assert.ok(result.after?.image);
  assert.equal(result.after.observation.screenshot.status, "ok");
});

test("element revalidation is independent of freshly assigned reference numbers", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.xml = hierarchy(node({ text: "Other", "resource-id": "example.poc:id/other", bounds: "[0,0][2,2]" }) + node());
  await service.act(selected.targetToken, screen.observation.observationId, { kind: "tap", target: { elementRef: "e1" } });
  assert.deepEqual(adb.inputs[0]?.args.slice(-2), ["24", "18"]);
});

test("changed, ambiguous, disabled, or absent elements reject input and consume the attempt", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const kind of ["tap", "long_press", "double_tap"] as const) {
    for (const changed of [node({ text: "Changed" }), node() + node(), node({ enabled: "false" }), ""]) {
      adb.xml = hierarchy();
      const screen = await service.observe(selected.targetToken);
      adb.xml = hierarchy(changed);
      await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind, target: { elementRef: "e1" } }), hasCode("ELEMENT_CHANGED"));
      await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
    }
  }
  assert.equal(adb.inputs.length, 0);
});

test("only the latest observation is usable", async (t) => {
  const { service } = harness(t);
  const { selected, screen } = await ready(service);
  await service.observe(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
});

test("the exact 30-second age boundary is enforced, including clock rollback", async (t) => {
  let time = 100_000;
  const { adb, service } = harness(t, () => time);
  const { selected, screen } = await ready(service);
  time += 30_000;
  await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
  const old = await service.observe(selected.targetToken);
  time += 30_001;
  await assert.rejects(service.act(selected.targetToken, old.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  const rollback = await service.observe(selected.targetToken);
  time -= 1;
  await assert.rejects(service.act(selected.targetToken, rollback.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 1);
});

test("metadata-backed coordinate gestures ignore visual animation and require exact in-bounds endpoints", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  await service.prepareGestures(selected.targetToken);
  for (const kind of ["tap", "long_press", "double_tap"] as const) {
    adb.image = png();
    const screen = await service.observe(selected.targetToken);
    adb.image = png(80, 160, 9);
    assert.equal((await service.act(selected.targetToken, screen.observation.observationId, { kind, target: { x: 10, y: 10 } })).dispatchStatus, "dispatched");
    const outside = await service.observe(selected.targetToken);
    await assert.rejects(service.act(selected.targetToken, outside.observation.observationId, { kind, target: { x: 80, y: 159 } }), hasCode("INVALID_INPUT"));
  }
  const swipe = await service.observe(selected.targetToken);
  await service.act(selected.targetToken, swipe.observation.observationId, {
    kind: "swipe", from: { x: 79, y: 159 }, to: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 80, height: 160 },
  });
  assert.deepEqual(adb.inputs.at(-1)?.args, ["-t", "7", "shell", "input", "swipe", "79", "159", "0", "0", "400"]);
});

for (const kind of ["tap", "long_press", "double_tap"] as const) {
  test(`visual ${kind} on custom-drawn pages tolerates changes outside the control and margin`, async (t) => {
    const { adb, service } = harness(t);
    adb.display = displayDiagnostics(0, 720, 1600);
    adb.xml = hierarchy(node({
      class: "android.widget.FrameLayout", text: "", clickable: "false",
      "resource-id": "example.poc:id/container", bounds: "[0,0][720,1600]",
    }));
    adb.image = pixelPng(720, 1600, () => [255, 255, 255, 255]);
    const selected = await service.selectDevice(USB);
    if (kind === "double_tap") await service.prepareGestures(selected.targetToken);
    const screen = await service.observe(selected.targetToken);
    adb.image = pixelPng(720, 1600, (_x, y) => y < 48 || (y >= 500 && y < 650)
      ? [80, 80, 80, 255] : [255, 255, 255, 255]);
    const result = await service.act(selected.targetToken, screen.observation.observationId, {
      kind, target: { x: 630, y: 171, bounds: { x: 600, y: 160, width: 60, height: 24 } },
    });
    assert.equal(result.dispatchStatus, "dispatched");
    assert.equal(result.verificationStatus, "requires-observation-review");
    assert.ok(result.after?.image);
    if (kind === "tap") {
      assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "input", "tap", "630", "171"]);
    } else if (kind === "long_press") {
      assert.deepEqual(adb.inputs[0]?.args, [
        "-t", "7", "shell", "input", "touchscreen", "-d", "0", "draganddrop", "630", "171", "630", "171", "0", "2>&1",
      ]);
    } else {
      assert.deepEqual(result.gestureTiming, { requestedDelayMs: 50, actualGapMs: 50 });
      assert.deepEqual(adb.inputs[0]?.args.slice(-3), ["630", "171", "50"]);
    }
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
      kind, target: { x: 630, y: 171 },
    }), hasCode("STALE_OBSERVATION"));
    assert.equal(adb.inputs.length, 1);
  });
}

test("PNG metadata changes do not make unchanged visible pixels stale", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.image = Buffer.concat([adb.image.subarray(0, -12), chunk("tEXt", Buffer.from("fixture\0metadata")), adb.image.subarray(-12)]);
  await service.act(selected.targetToken, screen.observation.observationId, { kind: "tap", target: { x: 10, y: 10 } });
  assert.equal(adb.inputs.length, 1);
});

test("large video changes outside visual target bounds and margin no longer veto input", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const metadata of [false, true]) {
    adb.xml = metadata
      ? hierarchy(node({ bounds: "[30,110][50,130]" }))
      : hierarchy("");
    adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
    const screen = await service.observe(selected.targetToken);
    adb.image = pixelPng(80, 160, (x, y) => x < 22 || x >= 58 || y < 102 || y >= 138
      ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const result = await service.act(selected.targetToken, screen.observation.observationId, {
      kind: "tap", target: { x: 40, y: 120, bounds: { x: 30, y: 110, width: 20, height: 20 } },
    });
    assert.equal(result.dispatchStatus, "dispatched");
  }
  assert.equal(adb.inputs.length, 2);
});

test("a single changed pixel in the visual margin blocks input with structured diagnostics and consumes the observation", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy("");
  adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
  const { selected, screen } = await ready(service);
  adb.image = pixelPng(80, 160, (x, y) => x === 24 && y === 64 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "tap", target: { x: 40, y: 80, bounds: { x: 32, y: 72, width: 16, height: 16 } },
  }), (error: unknown) => {
    hasCode("STALE_OBSERVATION")(error);
    assert.ok(error instanceof MobileUseError && /Pixels.*protected region/.test(error.message));
    assert.equal(error.actionMayHaveRun, false);
    const details = error.toJSON().visualGuard;
    assert.ok(details);
    assert.equal(details.changedPixels, 1);
    assert.equal(details.regionChangedPixels, 1);
    assert.equal(details.totalPixels, 12_800);
    assert.deepEqual(details.protectedRegion, { x: 24, y: 64, width: 32, height: 32 });
    assert.deepEqual(details.changedBounds, { x: 24, y: 64, width: 1, height: 1 });
    assert.deepEqual(details.regionChangedBounds, details.changedBounds);
    assert.deepEqual(details.previousCapture, screen.observation.captureTiming);
    assert.ok(details.currentCapture.durationMs >= 0);
    assert.ok(details.currentCapture.screenshotDurationMs !== null);
    return true;
  });
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "key", key: "HOME",
  }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 0);
});

test("swipes protect their whole path, not just the start and end points", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const changedY of [10, 80]) {
    adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
    const screen = await service.observe(selected.targetToken);
    adb.image = pixelPng(80, 160, (x, y) => x === 40 && y === changedY ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const action = service.act(selected.targetToken, screen.observation.observationId, {
      kind: "swipe", from: { x: 40, y: 120 }, to: { x: 40, y: 40 },
      bounds: { x: 32, y: 40, width: 16, height: 81 },
    });
    if (changedY === 80) await assert.rejects(action, hasCode("STALE_OBSERVATION"));
    else assert.equal((await action).dispatchStatus, "dispatched");
  }
  assert.equal(adb.inputs.length, 1);
});

test("changed or overlaid hierarchy controls block coordinate input even when the image is identical", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const nodes of [node({ enabled: "false" }), node({ text: "Changed label" }), node() + node({ text: "Overlay" })]) {
    adb.xml = hierarchy();
    const screen = await service.observe(selected.targetToken);
    adb.xml = hierarchy(nodes);
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
      kind: "tap", target: { x: 24, y: 18 },
    }), hasCode("ELEMENT_CHANGED"));
  }
  assert.equal(adb.inputs.length, 0);
});

test("app, activity, and Android user switches block coordinate input even with identical images", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const change of ["app", "activity", "user"]) {
    adb.foreground = "example.poc/.MainActivity";
    adb.userId = 0;
    const screen = await service.observe(selected.targetToken);
    if (change === "app") adb.foreground = "example.other/.MainActivity";
    if (change === "activity") adb.foreground = "example.poc/.OtherActivity";
    if (change === "user") adb.userId = 10;
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
      kind: "tap", target: { x: 24, y: 18 },
    }), hasCode("STALE_OBSERVATION"));
  }
  assert.equal(adb.inputs.length, 0);
});

test("unverifiable foreground context blocks pointer input even with identical images", async (t) => {
  const { adb, service } = harness(t);
  adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
  adb.handler = (call) => call.args.includes("activities") ? Buffer.from("Unrecognized activity diagnostics") : undefined;
  const { selected, screen } = await ready(service);
  assert.match(screen.observation.warnings.join(" "), /Foreground activity.*APP_FOREGROUND_UNAVAILABLE/);
  adb.image = pixelPng(80, 160, (x, y) => x === 0 && y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "tap", target: { x: 40, y: 120, bounds: { x: 30, y: 110, width: 20, height: 20 } },
  }), hasCode("STALE_OBSERVATION"));
  const unchanged = await service.observe(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, unchanged.observation.observationId, {
    kind: "tap", target: { x: 40, y: 120, bounds: { x: 30, y: 110, width: 20, height: 20 } },
  }), hasCode("STALE_OBSERVATION"));
  const semantic = await service.observe(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, semantic.observation.observationId, {
    kind: "tap", target: { elementRef: "e1" },
  }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 0);
});

test("changed images cannot use relaxed comparison across hierarchy loss or a missing foreground activity", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  for (const change of ["hierarchy", "foreground"]) {
    adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
    adb.xml = hierarchy();
    adb.foreground = "example.poc/.MainActivity";
    const screen = await service.observe(selected.targetToken);
    adb.image = pixelPng(80, 160, (x, y) => x === 0 && y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    if (change === "hierarchy") adb.xml = "ERROR: null root node";
    else adb.foreground = null;
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
      kind: "tap", target: { x: 40, y: 120, bounds: { x: 30, y: 110, width: 20, height: 20 } },
    }), hasCode("STALE_OBSERVATION"));
  }
  assert.equal(adb.inputs.length, 0);
});

test("display rotation is mapped and a later geometry change blocks input", async (t) => {
  const { adb, service } = harness(t);
  adb.image = png(160, 80);
  adb.xml = hierarchy(node(), 1);
  adb.display = displayDiagnostics(1, 160, 80);
  const { selected, screen } = await ready(service);
  assert.deepEqual(screen.observation.display, { width: 160, height: 80, rotation: 1 });
  await service.act(selected.targetToken, screen.observation.observationId, {
    kind: "tap", target: { x: 159, y: 79, bounds: { x: 140, y: 60, width: 20, height: 20 } },
  });
  const before = await service.observe(selected.targetToken);
  adb.image = png();
  adb.xml = hierarchy();
  adb.display = displayDiagnostics();
  await assert.rejects(service.act(selected.targetToken, before.observation.observationId, { kind: "key", key: "BACK" }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 1);
});

test("inconsistent capture geometry is not accepted as a fresh observation", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy(node(), 1);
  const selected = await service.selectDevice(USB);
  await assert.rejects(service.observe(selected.targetToken), hasCode("STALE_OBSERVATION"));
});

test("typing appends supported text only to one unchanged focused native non-password field", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy(editField());
  const { selected, screen } = await ready(service);
  await service.act(selected.targetToken, screen.observation.observationId, { kind: "type_text", text: "POC sample-01" });
  assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "input", "text", "POC%ssample-01"]);
  for (const fields of [
    editField({ password: "true" }), editField({ focused: "false" }), editField() + editField(),
    node({ class: "android.view.View", focused: "true" }),
  ]) {
    adb.xml = hierarchy(fields);
    const observation = await service.observe(selected.targetToken);
    await assert.rejects(service.act(selected.targetToken, observation.observation.observationId, { kind: "type_text", text: "POC" }), hasCode("ELEMENT_CHANGED"));
  }
  assert.equal(adb.inputs.length, 1);
});

test("Unicode preparation invalidates observations and preserves hierarchy-only input without screenshots", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy(editField());
  const { selected, screen } = await ready(service);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "type_text", text: "中文",
  }), hasCode("TEXT_HELPER_NOT_PREPARED"));
  assert.equal(adb.calls.some((call) => call.args[2] === "push"), false);
  const before = await service.observe(selected.targetToken);
  await service.prepareTextInput(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, before.observation.observationId, {
    kind: "type_text", text: "中文",
  }), hasCode("STALE_OBSERVATION"));
  const noImage = await service.observe(selected.targetToken, undefined, false);
  const start = adb.calls.length;
  const result = await service.act(selected.targetToken, noImage.observation.observationId, { kind: "type_text", text: "中文😀" });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.after?.observation.screenshot.status, "skipped");
  assert.equal(adb.calls.slice(start).some((call) => call.args.includes("screencap")), false);
  const reselected = await service.selectDevice(USB);
  const fresh = await service.observe(reselected.targetToken);
  await assert.rejects(service.act(reselected.targetToken, fresh.observation.observationId, {
    kind: "type_text", text: "中文",
  }), hasCode("TEXT_HELPER_NOT_PREPARED"));
});

test("Unicode append observations retain exact multilingual values when the original field grows", async (t) => {
  const { adb, service } = harness(t);
  const previous = "  existing\r\n中文😀\t&#10;  ";
  const text = "\n日本語 | 한국어 | العربية | Русский | e\u0301 | 👩‍💻";
  adb.xml = hierarchy(editField({ text: previous }));
  const selected = await service.selectDevice(USB);
  await service.prepareTextInput(selected.targetToken);
  const screen = await service.observe(selected.targetToken, undefined, false);
  assert.equal(screen.observation.elements[0]?.text, previous);
  adb.handler = (call) => {
    if (call.options.mutating && call.args[6] === "dev.mobileuse.text.TextMain") {
      adb.xml = hierarchy(editField({ text: previous + text, bounds: "[4,32][76,100]" }));
    }
    return undefined;
  };
  const result = await service.act(selected.targetToken, screen.observation.observationId, { kind: "type_text", text });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.error, null);
  assert.equal(result.verificationStatus, "requires-observation-review");
  assert.equal(result.after?.observation.elements[0]?.text, previous + text);
  assert.equal(result.after?.observation.elements[0]?.bounds.height, 68);
  const persisted = await service.observe(selected.targetToken, undefined, false);
  assert.equal(persisted.observation.elements[0]?.text, previous + text);
  assert.equal(adb.inputs.length, 1);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
});

test("Unicode blocks app changes, preserves focused-field guards, and reports uncertain writes without replay", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  await service.prepareTextInput(selected.targetToken);
  for (const fields of [editField({ password: "true" }), editField({ enabled: "false" }), editField() + editField()]) {
    adb.xml = hierarchy(fields);
    const screen = await service.observe(selected.targetToken);
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
      kind: "type_text", text: "中文",
    }), hasCode("ELEMENT_CHANGED"));
  }
  adb.xml = hierarchy(editField());
  const oldApp = await service.observe(selected.targetToken);
  adb.foreground = "other.app/.MainActivity";
  await assert.rejects(service.act(selected.targetToken, oldApp.observation.observationId, {
    kind: "type_text", text: "中文",
  }), hasCode("ELEMENT_CHANGED"));
  assert.equal(adb.inputs.length, 0);
  adb.foreground = "example.poc/.MainActivity";
  const screen = await service.observe(selected.targetToken);
  adb.handler = (call) => call.options.mutating && call.args[6] === "dev.mobileuse.text.TextMain"
    ? Buffer.from("MOBILE_USE_TEXT_V1_FAILED\n") : undefined;
  const result = await service.act(selected.targetToken, screen.observation.observationId, { kind: "type_text", text: "中文" });
  assert.equal(result.dispatchStatus, "outcome-unknown");
  assert.equal(result.error?.code, "TEXT_INPUT_FAILED");
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(adb.inputs.length, 1);
});

test("Unicode blocks an identical focused editor in a replacement window within the same activity", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  await service.prepareTextInput(selected.targetToken);
  adb.xml = hierarchy(editField({ text: "same text", "window-identity": "abc:u0" }));
  const screen = await service.observe(selected.targetToken, undefined, false);
  assert.equal(screen.observation.elements[0]?.windowIdentity, "abc:u0");
  adb.xml = hierarchy(editField({ text: "same text", "window-identity": "def:u0" }));
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "type_text", text: "中文",
  }), hasCode("ELEMENT_CHANGED"));
  assert.equal(adb.inputs.length, 0);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
});

test("cold-root failures during Unicode preflight remain pre-input errors with sanitized diagnostic stages", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  await service.prepareTextInput(selected.targetToken);
  adb.xml = hierarchy(editField());
  const screen = await service.observe(selected.targetToken, undefined, false);
  adb.handler = (call) => call.args[7] === "--dump-windows"
    ? Buffer.from("MOBILE_USE_TEXT_V1_ERROR_ROOT\n") : undefined;
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "type_text", text: "中文",
  }), (error: unknown) => {
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.code, "OBSERVATION_UNAVAILABLE");
    assert.equal(error.actionMayHaveRun, false);
    assert.match(error.remediation, /Unicode hierarchy helper failed during ROOT/);
    return true;
  });
  assert.equal(adb.inputs.length, 0);
  adb.handler = undefined;
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "type_text", text: "中文",
  }), hasCode("STALE_OBSERVATION"));
  const recovered = await service.observe(selected.targetToken, undefined, false);
  const result = await service.act(selected.targetToken, recovered.observation.observationId, {
    kind: "type_text", text: "中文",
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(adb.inputs.length, 1);
});

test("root loss during Unicode append remains a confirmed pre-write failure without replay", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  await service.prepareTextInput(selected.targetToken);
  adb.xml = hierarchy(editField());
  const screen = await service.observe(selected.targetToken, undefined, false);
  adb.handler = (call) => call.options.mutating && call.args[6] === "dev.mobileuse.text.TextMain"
    ? Buffer.from("MOBILE_USE_TEXT_V1_ERROR_ROOT\n") : undefined;
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "type_text", text: "中文",
  }), (error: unknown) => {
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.code, "TEXT_INPUT_FAILED");
    assert.equal(error.message, "The Unicode text helper failed during ROOT.");
    assert.equal(error.actionMayHaveRun, false);
    assert.equal(error.retryable, false);
    assert.match(error.remediation, /No text was written/);
    return true;
  });
  assert.equal(adb.inputs.length, 1);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap")), false);
  adb.handler = undefined;
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "type_text", text: "中文",
  }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 1);
  const recovered = await service.observe(selected.targetToken, undefined, false);
  const result = await service.act(selected.targetToken, recovered.observation.observationId, {
    kind: "type_text", text: "中文",
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(adb.inputs.length, 2);
});

test("unsupported text and raw/invalid actions fail before device I/O", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  const calls = adb.calls.length;
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "type_text", text: "\ud800" }), hasCode("UNSUPPORTED_TEXT"));
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "shell", command: "reboot" }), hasCode("INVALID_INPUT"));
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "double_tap", target: { x: "10;reboot", y: 10 },
  }), hasCode("INVALID_INPUT"));
  assert.equal(adb.calls.length, calls);
});

test("unavailable hierarchy is explicit, while image-only coordinate input remains possible", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = "ERROR: null root node";
  const { selected, screen } = await ready(service);
  assert.equal(screen.observation.hierarchy.status, "unavailable");
  assert.equal(screen.observation.screenshot.status, "ok");
  assert.deepEqual(screen.observation.displayState, { status: "ok", error: null });
  assert.deepEqual(screen.observation.display, { width: 80, height: 160, rotation: 0 });
  assert.deepEqual(screen.observation.elements, []);
  assert.match(screen.observation.warnings.join(" "), /no semantic element/);
  await service.act(selected.targetToken, screen.observation.observationId, {
    kind: "tap", target: { x: 10, y: 10, bounds: { x: 4, y: 8, width: 40, height: 20 } },
  });
  assert.equal(adb.inputs.length, 1);
});

test("hierarchy loss and recovery preserve verified rotation but require a new observation before pointer input", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.handler = (call) => {
    if (call.args.includes("uiautomator")) throw new MobileUseError("ADB_FAILED", "Fixture hierarchy failure.", "Observe again.");
    return undefined;
  };
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "tap", target: { x: 10, y: 10, bounds: { x: 4, y: 8, width: 40, height: 20 } },
  }), hasCode("ELEMENT_CHANGED"));
  const imageOnly = await service.observe(selected.targetToken);
  assert.equal(imageOnly.observation.hierarchy.status, "unavailable");
  assert.equal(imageOnly.observation.display?.rotation, 0);
  adb.handler = undefined;
  await assert.rejects(service.act(selected.targetToken, imageOnly.observation.observationId, {
    kind: "swipe", from: { x: 10, y: 100 }, to: { x: 10, y: 50 },
    bounds: { x: 4, y: 40, width: 30, height: 80 },
  }), hasCode("STALE_OBSERVATION"));
  const fresh = await service.observe(selected.targetToken);
  const recovered = await service.act(selected.targetToken, fresh.observation.observationId, { kind: "tap", target: { elementRef: "e1" } });
  assert.equal(recovered.after?.observation.hierarchy.status, "ok");
  assert.equal(recovered.after?.observation.display?.rotation, 0);
  assert.equal(adb.inputs.length, 1);
});

test("a real 180-degree rotation blocks input even with identical pixels and no hierarchy", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = "ERROR: null root node";
  const { selected, screen } = await ready(service);
  adb.display = displayDiagnostics(2);
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "double_tap", target: { x: 10, y: 10 },
  }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 0);
  const rotated = await service.observe(selected.targetToken);
  assert.deepEqual(rotated.observation.display, { width: 80, height: 160, rotation: 2 });
});

test("unverified display state is explicit and blocks every action instead of treating unknown as zero", async (t) => {
  const { adb, service } = harness(t);
  adb.display = "Unrecognized display diagnostics";
  const selected = await service.selectDevice(USB);
  for (const action of [
    { kind: "tap", target: { x: 10, y: 10 } },
    { kind: "tap", target: { elementRef: "e1" } },
    { kind: "double_tap", target: { x: 10, y: 10 } },
    { kind: "double_tap", target: { elementRef: "e1" } },
    { kind: "swipe", from: { x: 10, y: 100 }, to: { x: 10, y: 50 } },
    { kind: "key", key: "HOME" },
    { kind: "launch_app", packageName: "example.poc" },
    { kind: "type_text", text: "POC" },
  ]) {
    const screen = await service.observe(selected.targetToken);
    assert.equal(screen.observation.display?.rotation, null);
    assert.equal(screen.observation.displayState.status, "unavailable");
    assert.equal(screen.observation.displayState.error?.code, "DISPLAY_STATE_UNAVAILABLE");
    assert.match(screen.observation.warnings.join(" "), /input is blocked/);
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, action), hasCode("DISPLAY_STATE_UNAVAILABLE"));
  }
  assert.equal(adb.inputs.length, 0);
});

test("display-state loss and recovery require fresh observations and never reuse cached rotation", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.display = "";
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, {
    kind: "key", key: "HOME",
  }), hasCode("DISPLAY_STATE_UNAVAILABLE"));
  const unknown = await service.observe(selected.targetToken);
  assert.equal(unknown.observation.display?.rotation, null);
  adb.display = displayDiagnostics();
  await assert.rejects(service.act(selected.targetToken, unknown.observation.observationId, {
    kind: "key", key: "HOME",
  }), hasCode("DISPLAY_STATE_UNAVAILABLE"));
  const fresh = await service.observe(selected.targetToken);
  await service.act(selected.targetToken, fresh.observation.observationId, { kind: "key", key: "HOME" });
  assert.equal(adb.inputs.length, 1);
});

test("unavailable capture is not a black-image success or permission to use coordinates", async (t) => {
  const { adb, service } = harness(t);
  adb.image = Buffer.from("capture unavailable");
  const { selected, screen } = await ready(service);
  assert.equal(screen.image, null);
  assert.equal(screen.observation.screenshot.status, "unavailable");
  assert.deepEqual(screen.observation.display, { width: 80, height: 160, rotation: 0 });
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "tap", target: { x: 10, y: 10 } }), hasCode("CAPTURE_UNAVAILABLE"));
  const semantic = await service.observe(selected.targetToken);
  await service.act(selected.targetToken, semantic.observation.observationId, { kind: "tap", target: { elementRef: "e1" } });
  adb.xml = "";
  await assert.rejects(service.observe(selected.targetToken), hasCode("OBSERVATION_UNAVAILABLE"));
  assert.equal(adb.inputs.length, 1);
});

test("transport loss does not fall back to another endpoint, even after transient restoration", async (t) => {
  const { adb, monitors, service } = harness(t);
  const { selected, screen } = await ready(service);
  monitors.emit(`List of devices attached\n${WIFI_LINE}\n`);
  monitors.emit(INVENTORY);
  await assert.rejects(service.observe(selected.targetToken), hasCode("TRANSPORT_LOST"));
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("TRANSPORT_LOST"));
  assert.equal(adb.inputs.length, 0);
  const fresh = await service.selectDevice(USB);
  assert.notEqual(fresh.targetToken, selected.targetToken);
});

test("ADB server closure invalidates selection even if the inventory looks identical", async (t) => {
  const { monitors, service } = harness(t);
  const { selected } = await ready(service);
  monitors.disconnect();
  await service.listDevices();
  await assert.rejects(service.observe(selected.targetToken), hasCode("TRANSPORT_LOST"));
});

test("changed transport ID or physical identity blocks dispatch", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.inventory = `List of devices attached\n${USB_LINE.replace("transport_id:7", "transport_id:27")}\n${WIFI_LINE}\n`;
  await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("TRANSPORT_LOST"));
  adb.inventory = INVENTORY;
  const fresh = await ready(service);
  adb.properties["ro.serialno"] = "DIFFERENT_PHYSICAL_DEVICE";
  await assert.rejects(service.act(fresh.selected.targetToken, fresh.screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("TRANSPORT_LOST"));
  assert.equal(adb.inputs.length, 0);
});

test("concurrent requests cannot replay one observation", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  const operations = await Promise.allSettled([
    service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }),
    service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }),
  ]);
  assert.equal(operations[0]?.status, "fulfilled");
  const rejected = operations[1];
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") hasCode("STALE_OBSERVATION")(rejected.reason);
  assert.equal(adb.inputs.length, 1);
});

test("uncertain delivery and unexpected dispatch failures are never automatically replayed", async (t) => {
  for (const cause of [
    new MobileUseError("ADB_TIMEOUT", "Input delivery is uncertain.", "Observe, do not replay.", false, true),
    new MobileUseError("TRANSPORT_LOST", "Input was interrupted.", "Reselect, do not replay.", false, true),
    new MobileUseError("CANCELLED", "Input was cancelled.", "Observe, do not replay.", false, true),
    new Error("sensitive raw fixture details"),
  ]) {
    const { adb, service } = harness(t);
    const { selected, screen } = await ready(service);
    adb.handler = (call) => {
      if (call.options.mutating) throw cause;
      return undefined;
    };
    const result = await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
    assert.equal(result.dispatchStatus, "outcome-unknown");
    assert.equal(result.verificationStatus, "unverified");
    assert.equal(result.error?.actionMayHaveRun, true);
    assert.equal(result.error?.retryable, false);
    assert.doesNotMatch(JSON.stringify(result), /sensitive raw fixture details/);
    await assert.rejects(service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }));
    assert.equal(adb.inputs.length, 1);
  }
});

test("failed post-action observation does not turn dispatch into verified success", async (t) => {
  const { adb, service } = harness(t);
  const { selected, screen } = await ready(service);
  adb.handler = (call) => {
    if (call.options.mutating) {
      adb.xml = "";
      adb.image = Buffer.alloc(0);
    }
    return undefined;
  };
  const result = await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.after, null);
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(adb.inputs.length, 1);
});

test("cancellation, EOF-style stop, and pending selection release this service's resources only", async (t) => {
  const { adb, monitors, service } = harness(t);
  const { selected } = await ready(service);
  const controller = new AbortController();
  controller.abort();
  const count = adb.calls.length;
  await assert.rejects(service.observe(selected.targetToken, controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, count);
  service.stop();
  assert.equal(adb.stopped, true);
  assert.ok(monitors.sessions.every((monitor) => monitor.closed));
  await assert.rejects(service.listDevices(), hasCode("SERVER_STOPPED"));
  assert.equal(adb.calls.some((call) => call.args.includes("kill-server")), false);

  const waitingAdb = new FakeAdb();
  let started: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const monitor: MonitorFactory = (_inventory, _lost, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new MobileUseError("CANCELLED", "Stopped.", "Restart.")), { once: true });
    started?.();
  });
  const waiting = new MobileUseService(waitingAdb, monitor);
  const selection = waiting.selectDevice(USB);
  await pending;
  waiting.stop();
  await assert.rejects(selection, hasCode("CANCELLED"));
});

test("selection cancellation during discovery never opens a monitor or touches a device", async (t) => {
  const { adb, monitors, service } = harness(t);
  const controller = new AbortController();
  adb.handler = (call) => {
    if (call.args[0] === "devices") {
      controller.abort();
      return Buffer.from(INVENTORY);
    }
    return undefined;
  };
  await assert.rejects(service.selectDevice(USB, controller.signal), hasCode("CANCELLED"));
  assert.equal(monitors.sessions.length, 0);
  assert.equal(adb.calls.length, 1);
});
