import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { parseDeviceList } from "../src/adb.js";
import { AndroidBackend } from "../src/android.js";
import { localApkFile, parseAndroidUser, parseForegroundApp, parseInstalledApps, parsePackageStopped, validatePackageName } from "../src/apps.js";
import { MobileUseService } from "../src/device-session.js";
import { MobileUseError } from "../src/errors.js";
import { packageNameSchema } from "../src/types.js";
import { FakeAdb, FakeMonitors, hasCode, USB, WIFI } from "./helpers.js";

function backend(adb: FakeAdb, endpointId = USB): AndroidBackend {
  const endpoint = parseDeviceList(adb.inventory).find((entry) => entry.endpointId === endpointId);
  assert.ok(endpoint);
  return new AndroidBackend(adb, endpoint, new AbortController().signal, () => {});
}

function harness(t: TestContext) {
  const adb = new FakeAdb();
  const monitors = new FakeMonitors(adb);
  const service = new MobileUseService(adb, monitors.factory);
  t.after(() => service.stop());
  return { adb, monitors, service };
}

async function apkFixture(t: TestContext) {
  const base = path.resolve(".test-artifacts");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "local apk with spaces "));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filePath = path.join(directory, "demo app & sample.apk");
  await writeFile(filePath, "fixture-only, never sent to a real device");
  return { filePath, directory };
}

test("package names share one bounded validator and reject shell syntax and trailing newlines", () => {
  for (const name of ["android", "example.poc", "com.example.App_01"]) {
    validatePackageName(name);
    assert.equal(packageNameSchema.safeParse(name).success, true);
  }
  for (const name of ["", "single", "-example.app", "a.1", "a..b", "a.b;reboot", "a.b\n", "a.b\r\n", "a.$b", "a.b'c", "a.b c", `a.${"b".repeat(254)}`]) {
    assert.throws(() => validatePackageName(name), hasCode("INVALID_INPUT"));
    assert.equal(packageNameSchema.safeParse(name).success, false);
  }
});

test("app inventory includes system packages, is sorted, and rejects incomplete or excessive data", () => {
  assert.deepEqual(parseInstalledApps("package:example.z\r\npackage:android\r\npackage:example.a\r\n", 10), {
    userId: 10, apps: [{ packageName: "android" }, { packageName: "example.a" }, { packageName: "example.z" }],
  });
  assert.deepEqual(parseInstalledApps("", 0), { userId: 0, apps: [] });
  for (const output of [
    "Permission Denial", "package:example.app\nFailure [oops]", "package:a.b\npackage:a.b\n",
    "package:a.b;reboot\n", "package:a.b \n", " ".repeat(1024 * 1024 + 1),
    Array.from({ length: 10_001 }, (_item, i) => `package:example.app${i}`).join("\n"),
  ]) assert.throws(() => parseInstalledApps(output, 0), hasCode("APP_LIST_UNAVAILABLE"));
  const boundary = Array.from({ length: 10_000 }, (_item, i) => `package:example.app${i}`).join("\n");
  assert.equal(parseInstalledApps(boundary, 0).apps.length, 10_000);
});

test("current-user metadata never defaults malformed diagnostics to the owner user", () => {
  assert.equal(parseAndroidUser("10\r\n"), 10);
  assert.equal(parseAndroidUser("0\n"), 0);
  for (const value of ["", "unknown", "User 0", "-1", "00", "0\n10", "9007199254740992"]) {
    assert.throws(() => parseAndroidUser(value), hasCode("APP_STATE_UNAVAILABLE"));
  }
});

test("foreground lookup prefers top-resumed activity and isolates the primary display", () => {
  const primary = "Display #0 (activities from top to bottom):\n" +
    "  mResumedActivity: ActivityRecord{old u0 other.app/.Old t1}\n" +
    "  topResumedActivity=ActivityRecord{abc u10 example.app/.Main$Nested t2}\n";
  const secondary = "Display #2 (activities from top to bottom):\n" +
    "  topResumedActivity=ActivityRecord{def u0 secondary.app/.Main t3}\n";
  assert.deepEqual(parseForegroundApp(secondary + primary + secondary), {
    packageName: "example.app", activityName: ".Main$Nested", userId: 10,
  });
  assert.deepEqual(parseForegroundApp("  mResumedActivity: ActivityRecord{abc u0 example.app/example.app.Main t2}\n"), {
    packageName: "example.app", activityName: "example.app.Main", userId: 0,
  });
  assert.equal(parseForegroundApp("  topResumedActivity=null\n"), null);
});

test("unknown, missing, conflicting, and oversized foreground diagnostics are explicit errors", () => {
  const resumed = "  mResumedActivity: ActivityRecord{abc u0 example.app/.Main t1}\n";
  for (const value of [
    "", "Permission Denial", "ActivityRecord{abc u0 example.app/.Main t1}", "  topResumedActivity=unknown\n",
    "Display #2\n" + resumed, "Display #0\n" + resumed + "Display #0\n" + resumed,
    resumed + resumed.replace("example.app", "other.app"),
    resumed + "  mResumedActivity: null\n",
    resumed.replace("u0 ", "u9007199254740992 "),
    resumed.replace("example.app", "example.app;reboot"),
    " ".repeat(2 * 1024 * 1024 + 1),
  ]) assert.throws(() => parseForegroundApp(value), hasCode("APP_FOREGROUND_UNAVAILABLE"));
});

test("Android 11 ResumedActivity fields identify the primary display without accepting ambiguity", () => {
  const primary = "Display #0 (activities from top to bottom):\n" +
    "  ResumedActivity: ActivityRecord{abc u0 example.app/.Main t1}\n";
  const secondary = "Display #2 (activities from top to bottom):\n" +
    "  ResumedActivity: ActivityRecord{def u10 other.app/.Other t2}\n";
  assert.deepEqual(parseForegroundApp(secondary + primary), {
    packageName: "example.app", activityName: ".Main", userId: 0,
  });
  assert.deepEqual(parseForegroundApp(primary + secondary), {
    packageName: "example.app", activityName: ".Main", userId: 0,
  });
  assert.equal(parseForegroundApp("Display #0\n  ResumedActivity: null\n" + secondary), null);
  for (const output of [
    "Display #0\n  ResumedActivity: unknown\n",
    primary + "  ResumedActivity: ActivityRecord{def u0 other.app/.Main t2}\n",
    primary + "  mResumedActivity: ActivityRecord{def u10 other.app/.Main t2}\n",
    primary + "  ResumedActivity: null\n",
    secondary,
  ]) assert.throws(() => parseForegroundApp(output), hasCode("APP_FOREGROUND_UNAVAILABLE"));
});

test("force-stop verification reads only one installed user's stopped flag", () => {
  assert.equal(parsePackageStopped("  User 0: installed=true stopped=false\n  User 10: installed=true stopped=true\n", 10), true);
  assert.equal(parsePackageStopped("  User 0: installed=true stopped=false\n", 0), false);
  for (const value of [
    "", "User 10: installed=true stopped=true", "User 0: installed=false stopped=true",
    "User 0: installed=true stopped=unknown", "User 0: installed=true stopped=true stopped=false",
    "User 0: installed=true stopped=true stopped=unknown", "User 0: installed=true installed=false stopped=true",
    "User 0: installed=true stopped=trueish",
    "User 0: installed=true stopped=true\nUser 0: installed=true stopped=true", " ".repeat(1024 * 1024 + 1),
  ]) assert.throws(() => parsePackageStopped(value, 0), hasCode("APP_STATE_UNAVAILABLE"));
});

test("package-state verification ignores unrelated user headings but rejects duplicate state records", () => {
  const state = "Packages:\n  Package [example.app] (abc):\n" +
    "    User 0: ceDataInode=0 installed=true hidden=false stopped=true notLaunched=false\n";
  const unrelated = "Preferred Activities User 0:\n  User 0:\n" +
    "Cross Profile Intent Filters:\n  User 0:\n" +
    "Other diagnostics:\n  User 0: unrelated=true\n";
  assert.equal(parsePackageStopped(state + unrelated, 0), true);
  assert.equal(parsePackageStopped(unrelated + state, 0), true);
  assert.equal(parsePackageStopped(state.replace("stopped=true", "stopped=false") + unrelated, 0), false);
  for (const output of [
    unrelated,
    state + unrelated + "  User 0: installed=true stopped=false\n",
    state + unrelated + "  User 0: installed=unknown stopped=true\n",
    state + unrelated + "  User 0: stopped=true\n",
    state + unrelated + "  User 0: installed=true\n",
  ]) assert.throws(() => parsePackageStopped(output, 0), hasCode("APP_STATE_UNAVAILABLE"));
});

test("cancellation after an app mutation remains uncertain and does not repeat dispatch", async (t) => {
  const { filePath } = await apkFixture(t);
  const adb = new FakeAdb();
  const controller = new AbortController();
  adb.handler = (call) => {
    if (call.options.mutating) {
      controller.abort();
      return Buffer.from("Success\n");
    }
    return undefined;
  };
  await assert.rejects(backend(adb).installApp(filePath, controller.signal), (error: unknown) => {
    hasCode("CANCELLED")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
  assert.equal(adb.inputs.length, 1);
});

test("local APK validation handles spaces and rejects unsupported formats, locations, and sizes", async (t) => {
  const { filePath, directory } = await apkFixture(t);
  assert.equal(await localApkFile(filePath), filePath);
  for (const invalid of [
    ".\\demo.apk", "C:demo.apk", "https://example.invalid/demo.apk", "\\\\server\\share\\demo.apk",
    "\\\\?\\C:\\demo.apk", "C:\\file:stream.apk", filePath + "\n",
    path.join(directory, "missing.apk"), directory,
  ]) await assert.rejects(localApkFile(invalid), hasCode("INVALID_APP_FILE"));
  for (const extension of [".ipa", ".app", ".zip", ".apks"]) {
    const unsupported = path.join(directory, `demo${extension}`);
    await writeFile(unsupported, "fixture");
    await assert.rejects(localApkFile(unsupported), hasCode("INVALID_APP_FILE"));
  }
  const empty = path.join(directory, "empty.apk");
  await writeFile(empty, "");
  await assert.rejects(localApkFile(empty), hasCode("INVALID_APP_FILE"));
  const folder = path.join(directory, "directory.apk");
  await mkdir(folder);
  await assert.rejects(localApkFile(folder), hasCode("INVALID_APP_FILE"));
  await truncate(empty, 512 * 1024 * 1024);
  assert.equal(await localApkFile(empty), empty);
  await truncate(empty, 512 * 1024 * 1024 + 1);
  await assert.rejects(localApkFile(empty), hasCode("INVALID_APP_FILE"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(localApkFile(filePath, controller.signal), hasCode("CANCELLED"));
});

test("app reads and mutations pin the exact wireless transport and current Android user", async () => {
  const adb = new FakeAdb();
  adb.userId = 10;
  adb.keyguard.userId = 10;
  const android = backend(adb, WIFI);
  assert.deepEqual(await android.listApps(), { userId: 10, apps: [{ packageName: "android" }, { packageName: "example.poc" }] });
  assert.equal((await android.getForegroundApp())?.userId, 10);
  assert.equal(await android.launchApp("example.poc"), 10);
  assert.deepEqual(await android.terminateApp("example.poc"), { status: "terminated", packageName: "example.poc", userId: 10 });
  assert.deepEqual(await android.uninstallApp("example.poc"), { status: "uninstalled", packageName: "example.poc", userId: 10 });
  assert.equal((await android.listApps()).apps.some((app) => app.packageName === "example.poc"), false);
  assert.ok(adb.calls.every((call) => call.args[0] === "-t" && call.args[1] === "12"));
  assert.deepEqual(adb.inputs.map((call) => call.args.slice(2)), [
    ["shell", "am", "start", "-W", "--user", "10", "-n", "'example.poc/.MainActivity'"],
    ["shell", "am", "force-stop", "--user", "10", "example.poc"],
    ["shell", "pm", "uninstall", "--user", "10", "example.poc"],
  ]);
});

test("APK installation passes a literal local path with a bounded deadline and no permission or downgrade flags", async (t) => {
  const { filePath } = await apkFixture(t);
  const adb = new FakeAdb();
  const android = backend(adb);
  assert.deepEqual(await android.installApp(filePath), { status: "installed", packageName: null, userId: 0 });
  assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "install", "--streaming", "--user", "0", filePath]);
  assert.equal(adb.inputs[0]?.options.timeoutMs, 120_000);
  await assert.rejects(android.installApp(path.join(path.dirname(filePath), "missing.apk")), hasCode("INVALID_APP_FILE"));
  assert.equal(adb.inputs.length, 1);
});

test("invalid or missing packages fail before force-stop, uninstall, or launch dispatch", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  for (const operation of [
    () => android.terminateApp("bad.app\n"), () => android.uninstallApp("bad.app;reboot"),
    () => android.launchApp("bad.app\n"),
  ]) await assert.rejects(operation(), hasCode("INVALID_INPUT"));
  assert.equal(adb.calls.length, 0);
  await assert.rejects(android.terminateApp("missing.app"), hasCode("APP_NOT_FOUND"));
  await assert.rejects(android.uninstallApp("missing.app"), hasCode("APP_NOT_FOUND"));
  assert.equal(adb.inputs.length, 0);
});

test("Android command failures and failed verification never become app-management success", async (t) => {
  const { filePath } = await apkFixture(t);
  for (const operation of ["install", "terminate", "uninstall"] as const) {
    const adb = new FakeAdb();
    const android = backend(adb);
    adb.handler = (call) => call.options.mutating ? Buffer.from("Failure [not permitted]\n") : undefined;
    const invoke = () => operation === "install" ? android.installApp(filePath)
      : operation === "terminate" ? android.terminateApp("example.poc") : android.uninstallApp("example.poc");
    await assert.rejects(invoke(), (error: unknown) => {
      hasCode(operation === "install" ? "APP_INSTALL_FAILED" : operation === "terminate" ? "APP_TERMINATE_FAILED" : "APP_UNINSTALL_FAILED")(error);
      assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
      return true;
    });
    assert.equal(adb.inputs.length, 1, "failed mutations are not replayed");
  }
  const adb = new FakeAdb();
  adb.handler = (call) => call.args.includes("force-stop") ? Buffer.alloc(0) : undefined;
  await assert.rejects(backend(adb).terminateApp("example.poc"), hasCode("APP_TERMINATE_FAILED"));
  adb.handler = (call) => call.args.includes("uninstall") ? Buffer.from("Success\n") : undefined;
  await assert.rejects(backend(adb).uninstallApp("example.poc"), hasCode("APP_UNINSTALL_FAILED"));
});

test("app verification errors preserve uncertain delivery and never retry the mutation", async () => {
  for (const code of ["TRANSPORT_LOST", "CANCELLED", "ADB_TIMEOUT"] as const) {
    const adb = new FakeAdb();
    adb.handler = (call) => {
      if (call.args.includes("dumpsys") && call.args.includes("package")) {
        throw new MobileUseError(code, "Fixture verification failure.", "Check the phone.");
      }
      return undefined;
    };
    await assert.rejects(backend(adb).terminateApp("example.poc"), (error: unknown) => {
      hasCode(code)(error);
      assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
      return true;
    });
    assert.equal(adb.inputs.length, 1);
  }
});

test("app operations require selection and reject stale tokens, changed phones, and transport loss", async (t) => {
  const { adb, monitors, service } = harness(t);
  const operations = (token: string) => [
    () => service.listApps(token), () => service.getForegroundApp(token),
    () => service.launchApp(token, "example.poc"), () => service.terminateApp(token, "example.poc"),
    () => service.installApp(token, "C:\\not-read.apk"), () => service.uninstallApp(token, "example.poc"),
  ];
  for (const operation of operations("not-selected")) await assert.rejects(operation(), hasCode("TARGET_NOT_SELECTED"));
  assert.equal(adb.calls.length, 0);
  const old = await service.selectDevice(USB);
  const selected = await service.selectDevice(WIFI);
  for (const operation of operations(old.targetToken)) await assert.rejects(operation(), hasCode("STALE_TARGET"));
  adb.properties["ro.serialno"] = "OTHER_PHONE";
  await assert.rejects(service.listApps(selected.targetToken), hasCode("TRANSPORT_LOST"));
  adb.properties["ro.serialno"] = USB;
  const fresh = await service.selectDevice(USB);
  monitors.disconnect();
  for (const operation of operations(fresh.targetToken)) await assert.rejects(operation(), hasCode("TRANSPORT_LOST"));
  assert.equal(adb.inputs.length, 0);
});

test("all app tools work without screen capture and mutations consume earlier observations", async (t) => {
  const { filePath } = await apkFixture(t);
  const { adb, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  await service.listApps(targetToken);
  await service.getForegroundApp(targetToken);
  await service.launchApp(targetToken, "example.poc");
  await service.terminateApp(targetToken, "example.poc");
  await service.installApp(targetToken, filePath);
  await service.uninstallApp(targetToken, "example.poc");
  assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator")), false);
  adb.apps.add("example.poc");
  for (const operation of [
    () => service.launchApp(targetToken, "example.poc"), () => service.terminateApp(targetToken, "example.poc"),
    () => service.installApp(targetToken, filePath), () => service.uninstallApp(targetToken, "example.poc"),
  ]) {
    const screen = await service.observe(targetToken);
    await operation();
    await assert.rejects(service.act(targetToken, screen.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  }
});

test("read-only app tools and readiness checks preserve an existing screen observation", async (t) => {
  const { service } = harness(t);
  const selected = await service.selectDevice(USB);
  const screen = await service.observe(selected.targetToken);
  await service.listApps(selected.targetToken);
  await service.getForegroundApp(selected.targetToken);
  await service.doctor(undefined, selected.targetToken);
  await service.act(selected.targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
});

test("standalone launch verifies the foreground app and reports failed verification as uncertain", async (t) => {
  const { adb, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  assert.deepEqual(await service.launchApp(targetToken, "example.poc"), { status: "launched", packageName: "example.poc", userId: 0 });
  adb.handler = (call) => call.args.includes("activities")
    ? Buffer.from("  topResumedActivity=ActivityRecord{abc u0 other.app/.Main t1}\n") : undefined;
  await assert.rejects(service.launchApp(targetToken, "example.poc"), (error: unknown) => {
    hasCode("APP_LAUNCH_FAILED")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
  assert.equal(adb.inputs.length, 2);
});

test("app launch checks readiness before mutation while read-only app tools remain usable", async (t) => {
  const { adb, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  for (const [screenState, locked, secure, code] of [
    ["SCREEN_STATE_OFF", false, false, "DEVICE_NOT_READY"],
    ["SCREEN_STATE_ON", true, false, "DEVICE_NOT_READY"],
    ["SCREEN_STATE_ON", true, true, "MANUAL_UNLOCK_REQUIRED"],
    ["OEM_UNKNOWN", false, false, "KEYGUARD_STATE_UNAVAILABLE"],
  ] as const) {
    Object.assign(adb.keyguard, { screenState, showing: locked, secure });
    await assert.rejects(service.launchApp(targetToken, "example.poc"), (error: unknown) => {
      hasCode(code)(error);
      assert.ok(error instanceof MobileUseError && !error.actionMayHaveRun);
      return true;
    });
    await service.listApps(targetToken);
    assert.equal(adb.inputs.length, 0);
  }
  Object.assign(adb.keyguard, { screenState: "SCREEN_STATE_ON", showing: false, secure: true });
  assert.equal((await service.launchApp(targetToken, "example.poc")).status, "launched", "configured credentials do not mean the phone is currently locked");
  assert.equal(adb.inputs.length, 1);
  assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator")), false);
  adb.keyguard.userId = 10;
  await assert.rejects(service.launchApp(targetToken, "example.poc"), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 1, "user changes must be rejected before app launch");
});

test("post-mutation transport loss invalidates selection and reports the possible completed operation", async (t) => {
  const { adb, monitors, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  let inventories = 0;
  adb.handler = (call) => {
    if (call.args[0] === "devices" && ++inventories === 2) {
      monitors.disconnect();
      throw new MobileUseError("TRANSPORT_LOST", "Fixture disconnect after mutation.", "Reselect.");
    }
    return undefined;
  };
  await assert.rejects(service.terminateApp(targetToken, "example.poc"), (error: unknown) => {
    hasCode("TRANSPORT_LOST")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
  await assert.rejects(service.listApps(targetToken), hasCode("TRANSPORT_LOST"));
  assert.equal(adb.inputs.length, 1);
});

test("cancelled and stopped app operations dispatch no commands", async (t) => {
  const { adb, service } = harness(t);
  const { targetToken } = await service.selectDevice(USB);
  const count = adb.calls.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.listApps(targetToken, controller.signal), hasCode("CANCELLED"));
  await assert.rejects(service.installApp(targetToken, "C:\\never-read.apk", controller.signal), hasCode("CANCELLED"));
  await assert.rejects(service.terminateApp(targetToken, "example.poc", controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, count);
  service.stop();
  await assert.rejects(service.getForegroundApp(targetToken), hasCode("SERVER_STOPPED"));
  assert.equal(adb.calls.length, count);
});
