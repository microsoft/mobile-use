import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MobileUseService } from "../src/device-session.js";
import { MobileUseError } from "../src/errors.js";
import { createMobileUseServer } from "../src/tools.js";
import { chunk, editField, FakeAdb, FakeMonitors, hierarchy, node, pixelPng, recorderHelp, windowXml, windowsXml } from "./helpers.js";

const adb = new FakeAdb();
const monitors = new FakeMonitors(adb);
const setupScenario = process.env.MOBILE_USE_FIXTURE_SCENARIO ?? "";
const setupInventories: Record<string, string> = {
  "no-devices": "List of devices attached\n",
  unauthorized: "List of devices attached\nLOCKED unauthorized transport_id:1\n",
  offline: "List of devices attached\nOFF offline transport_id:2\n",
  unsupported: "List of devices attached\nemulator-5554 device transport_id:3\n",
};
if (setupInventories[setupScenario] !== undefined) adb.inventory = setupInventories[setupScenario];
if (Object.hasOwn(setupInventories, setupScenario) || ["missing-adb", "old-adb", "server-unavailable", "discovery-failed"].includes(setupScenario)) {
  adb.handler = (call) => {
    const command = call.args.join(" ");
    if (command !== "version" && command !== "devices -l") {
      throw new Error("Setup must not issue device commands.");
    }
    if (setupScenario === "missing-adb") {
      throw new MobileUseError("ADB_NOT_FOUND", "Fixture ADB is missing.", "Install Platform-Tools.");
    }
    if (setupScenario === "old-adb" && command === "version") return Buffer.from("Version 29.0.6\n");
    if (setupScenario === "server-unavailable" && command === "devices -l" && adb.startServerCalls === 0) {
      throw new MobileUseError("ADB_SERVER_UNAVAILABLE", "Fixture local server is unavailable.", "Ask for permission to start the local ADB server.", true);
    }
    if (setupScenario === "discovery-failed" && command === "devices -l") {
      throw new Error("private fixture-only discovery details");
    }
    return undefined;
  };
}
if (setupScenario === "server-reused") adb.startupAttempted = false;
if (setupScenario === "recording-legacy") adb.recordingHelp = recorderHelp(false);
if (setupScenario === "recording-help-unknown") adb.recordingHelp = "private unrecognized recorder help";
if (setupScenario === "server-start-empty") adb.inventory = "List of devices attached\n";
if (setupScenario === "hierarchy-unavailable") adb.xml = "ERROR: null root node";
if (setupScenario === "display-unavailable") adb.display = "Unrecognized display diagnostics";
if (setupScenario === "unicode-text") adb.xml = hierarchy(editField());
if (setupScenario === "no-screenshots" || setupScenario === "unicode-text") {
  adb.handler = (call) => {
    if (call.args.includes("screencap")) throw new Error("Screen capture is forbidden in this fixture.");
    return undefined;
  };
}
if (setupScenario === "floating-recorder") {
  let recording = false, capture = 0;
  adb.handler = (call) => {
    if (call.args.includes("screencap")) throw new Error("Floating recorder fixture forbids screenshots.");
    if (call.args.includes("uiautomator") || call.args.includes("--dump-windows")) {
      adb.xml = windowsXml(windowXml(node()) + windowXml(node({
        class: "android.widget.ImageButton", package: "example.recorder", text: "",
        "content-desc": recording ? "Stop recording" : "Start recording",
        "resource-id": "example.recorder:id/switch", clickable: "false", bounds: "[44,64][76,86]",
      }) + (recording ? node({
        text: `00:${++capture}`, clickable: "false", bounds: "[30,64][43,86]",
      }) : ""), {
        id: String(100 + ++capture), layer: "1", active: "false", focused: "false", bounds: "[30,60][80,96]",
      }));
    }
    if (call.args.includes("input")) {
      const expected = recording
        ? "input touchscreen -d 0 draganddrop 60 75 60 75 0 2>&1"
        : "input tap 60 75";
      if (call.args.slice(3).join(" ") !== expected) throw new Error("Unexpected floating recorder input.");
      recording = !recording;
    }
    if (call.args[6] === "dev.mobileuse.gestures.GestureMain" && call.args[7] !== "--check") {
      if (!recording || call.args.slice(7).join(" ") !== "60 75 50") throw new Error("Unexpected floating recorder gesture.");
      recording = false;
    }
    return undefined;
  };
}
if (setupScenario === "floating-editors" || setupScenario === "inactive-editor") {
  const foreground = setupScenario === "floating-editors" ? editField({ package: "example.poc" }) : node();
  adb.xml = windowsXml(windowXml(foreground) + windowXml(editField({
    package: "example.recorder", "resource-id": "example.recorder:id/text", bounds: "[34,64][76,86]",
  }), { id: "2", layer: "1", bounds: "[30,60][80,96]", active: "false", focused: "false" }));
  adb.handler = (call) => {
    if (call.args.includes("screencap")) throw new Error("Floating editor fixtures forbid screenshots.");
    return undefined;
  };
}
if (["coordinate-animation", "coordinate-target-change", "video-metadata", "video-swipe"].includes(setupScenario)) {
  adb.xml = hierarchy(node({
    class: "android.widget.FrameLayout", text: "", clickable: "false",
    "resource-id": "example.poc:id/container", bounds: "[0,0][80,160]",
  }));
  if (setupScenario === "video-metadata") adb.xml = hierarchy(node({ bounds: "[32,112][48,128]" }));
  if (setupScenario === "video-swipe") adb.xml = hierarchy(node({
    class: "android.widget.ScrollView", text: "", clickable: "false", scrollable: "true", bounds: "[0,20][80,160]",
  }));
  let captures = 0;
  adb.handler = (call) => {
    if (!call.args.includes("screencap")) return undefined;
    const changed = ++captures > 1;
    if (changed && setupScenario.startsWith("video-")) return pixelPng(80, 160, () => [240, 240, 240, 255]);
    const changedY = setupScenario === "coordinate-animation" ? 0 : 120;
    return pixelPng(80, 160, (x, y) => changed && x === 40 && y === changedY
      ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  };
}
if (setupScenario === "server-conflict" || setupScenario === "server-start-uncertain") {
  adb.startServerHandler = async () => {
    const uncertain = setupScenario === "server-start-uncertain";
    throw new MobileUseError(
      uncertain ? "ADB_SERVER_START_FAILED" : "ADB_SERVER_CONFLICT",
      "Fixture server startup did not complete.", "Leave the local server alone.", false, uncertain,
    );
  };
}
if (process.env.MOBILE_USE_FIXTURE_SCENARIO === "secure-keyguard") {
  Object.assign(adb.keyguard, { showing: true, secure: true, inputRestricted: true });
}
if (setupScenario === "asleep-keyguard") {
  Object.assign(adb.keyguard, { showing: true, inputRestricted: true, screenState: "SCREEN_STATE_OFF" });
}
if (setupScenario === "unknown-keyguard") {
  adb.keyguard.screenState = "OEM_UNKNOWN";
}
if (process.env.MOBILE_USE_FIXTURE_SCENARIO === "uncertain-input") {
  adb.handler = (call) => {
    if (call.options.mutating) throw new Error("private fixture-only dispatch details");
    return undefined;
  };
}
if (process.env.MOBILE_USE_FIXTURE_SCENARIO === "large-observation") {
  const padding = Buffer.alloc(5 * 1024 * 1024 - adb.image.length - 12, 65);
  Buffer.from("fixture\0").copy(padding);
  adb.image = Buffer.concat([adb.image.subarray(0, -12), chunk("tEXt", padding), adb.image.subarray(-12)]);
  adb.xml = hierarchy(node({ text: "A".repeat(1600) }).repeat(280));
}
if (setupScenario.startsWith("app-")) {
  adb.handler = (call) => {
    if (setupScenario === "app-miui-package-users" && call.args.includes("dumpsys") && call.args.includes("package")) {
      return Buffer.from(`Packages:\n  User 0: installed=true stopped=${adb.stoppedApps.has("example.poc")}\n` +
        "Preferred activities:\n  User 0:\nOther diagnostics:\n  User 0:\n");
    }
    if (setupScenario === "app-android11-resumed" && call.args.includes("activities")) {
      return Buffer.from("Display #0 (activities from top to bottom):\n  ResumedActivity: ActivityRecord{abc u0 example.poc/.MainActivity t1}\n");
    }
    if (setupScenario === "app-foreground-unavailable" && call.args.includes("activities")) {
      return Buffer.from("private fixture-only app diagnostics");
    }
    if (call.options.mutating) {
      if (setupScenario === "app-uncertain-mutation") throw new Error("private fixture-only app diagnostics");
      if (setupScenario === "app-install-rejected" || setupScenario === "app-uninstall-rejected") {
        return Buffer.from("Failure [private fixture-only app diagnostics]\n");
      }
    }
    return undefined;
  };
}
const service = new MobileUseService(adb, monitors.factory);
const server = serveStdio(() => createMobileUseServer(service));
const stop = (): void => {
  service.stop();
  void server.close().catch(() => {
    process.stderr.write("mobile-use fixture: shutdown failed.\n");
    process.exitCode = 1;
  });
};
process.stdin.once("end", () => service.stop());
process.stdin.once("close", () => service.stop());
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
