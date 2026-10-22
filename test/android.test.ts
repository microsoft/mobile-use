import assert from "node:assert/strict";
import test from "node:test";
import { parseDeviceList } from "../src/adb.js";
import { AndroidBackend, parseHierarchy, validatePng, validateText } from "../src/android.js";
import { actionSchema } from "../src/types.js";
import { FakeAdb, editField, hasCode, hierarchy, node, png, USB, WIFI } from "./helpers.js";

test("PNG validation preserves binary data and handles rotated dimensions", () => {
  assert.deepEqual(validatePng(png()), { width: 80, height: 160 });
  assert.deepEqual(validatePng(png(160, 80)), { width: 160, height: 80 });
});

test("PNG validation rejects truncated, corrupt, trailing, unsupported, and oversized capture", () => {
  const valid = png();
  const corrupt = Buffer.from(valid);
  corrupt[40] = (corrupt[40] ?? 0) ^ 1;
  for (const invalid of [
    Buffer.from("capture denied"), valid.subarray(0, -5), corrupt,
    Buffer.concat([valid, Buffer.from("extra")]), png(80, 160, 8, 5),
  ]) assert.throws(() => validatePng(invalid), hasCode("INVALID_IMAGE"));
  assert.throws(() => validatePng(Buffer.alloc(5 * 1024 * 1024 + 1)), hasCode("CAPTURE_UNAVAILABLE"));
});

test("hierarchies retain Unicode labels, nullable unknowns, and native field status", () => {
  const parsed = parseHierarchy(hierarchy(node({ text: "試験", "content-desc": "Demo & label" }) + editField(), 1));
  assert.equal(parsed.rotation, 1);
  assert.equal(parsed.elements[0]?.text, "試験");
  assert.equal(parsed.elements[0]?.label, "Demo & label");
  assert.equal(parsed.elements[1]?.editable, true);
  assert.equal(parsed.elements[1]?.focused, true);
  assert.deepEqual(parsed.elements[0]?.bounds, { x: 4, y: 8, width: 40, height: 20 });
  const noFlags = hierarchy('<node class="android.widget.EditText" bounds="[0,0][10,10]"/>');
  assert.equal(parseHierarchy(noFlags).elements[0]?.password, null);
  assert.equal(parseHierarchy(noFlags).elements[0]?.enabled, null);
});

test("password text is redacted and empty/custom hierarchies stay honest", () => {
  assert.equal(parseHierarchy(hierarchy(editField({ password: "true", text: "private" }))).elements[0]?.text, "[redacted]");
  assert.deepEqual(parseHierarchy('<hierarchy rotation="0"/>').elements, []);
  assert.deepEqual(parseHierarchy(hierarchy("")).elements, []);
});

test("malformed, external-entity, excessive, and invalid-attribute XML is rejected", () => {
  const bad = [
    "", "ERROR: null root node", '<hierarchy rotation="0"><node></hierarchy>',
    '<!DOCTYPE hierarchy [<!ENTITY secret SYSTEM "file:///private">]>' + hierarchy(),
    hierarchy(node({ enabled: "yes" })), hierarchy(node({ bounds: "[0,0][oops,10]" })),
    hierarchy(node().repeat(501)), hierarchy(node({ text: "a".repeat(4097) })),
    `<hierarchy rotation="4">${node()}</hierarchy>`,
    hierarchy(node({}, node({}, node().repeat(2100)))),
  ];
  for (const value of bad) assert.throws(() => parseHierarchy(value), hasCode("HIERARCHY_UNAVAILABLE"));
  let deep = node();
  for (let i = 0; i < 70; i++) deep = node({}, deep);
  assert.throws(() => parseHierarchy(hierarchy(deep)), hasCode("HIERARCHY_UNAVAILABLE"));
  const excessiveOutput = hierarchy(node({ text: "a".repeat(4000) }).repeat(140));
  assert.throws(() => parseHierarchy(excessiveOutput), hasCode("HIERARCHY_UNAVAILABLE"));
  assert.throws(() => parseHierarchy(" ".repeat(2 * 1024 * 1024 + 1)), hasCode("HIERARCHY_UNAVAILABLE"));
});

test("the explicit text alphabet and action union reject unsupported input", () => {
  validateText("ABC xyz 0123.,_-");
  validateText("a".repeat(256));
  for (const value of ["", "a".repeat(257), "é", "中文", "line\nbreak", "tab\t", "quote'", "$HOME", "%s", "&", ";", "\\", "😀"]) {
    assert.throws(() => validateText(value), hasCode("UNSUPPORTED_TEXT"));
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,_-";
  for (let code = 0; code < 128; code++) {
    const character = String.fromCharCode(code);
    if (alphabet.includes(character)) validateText(character);
    else assert.throws(() => validateText(character), hasCode("UNSUPPORTED_TEXT"));
  }
  assert.equal(actionSchema.parse({ kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }).kind, "swipe");
  for (const value of [
    { kind: "shell", command: "reboot" },
    { kind: "key", key: "POWER" },
    { kind: "tap", target: { x: 1, y: 1, elementRef: "e1" } },
    { kind: "tap", target: { x: -1, y: 0 } },
    { kind: "tap", target: { x: 1.5, y: 0 } },
    { kind: "launch_app", packageName: "example.app;reboot" },
    { kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 2001 },
  ]) assert.equal(actionSchema.safeParse(value).success, false);
});

test("ordered hierarchy traversal preserves parent/child/sibling references without recursive collection", () => {
  const xml = hierarchy(
    node({ text: "Parent" }, node({ text: "Child 1" }) + node({ text: "Child 2" })) +
    node({ text: "Sibling" }),
  );
  assert.deepEqual(parseHierarchy(xml).elements.map((element) => element.text), [
    "Parent", "Child 1", "Child 2", "Sibling",
  ]);
  const negative = parseHierarchy(hierarchy(node({ bounds: "[-10,-20][30,40]" })));
  assert.deepEqual(negative.elements[0]?.bounds, { x: -10, y: -20, width: 40, height: 60 });
  for (const invalid of [
    hierarchy(node({ bounds: "[-9007199254740991,0][9007199254740991,10]" })),
    hierarchy() + hierarchy(),
    '<hierarchy rotation="0"><unexpected/></hierarchy>',
  ]) assert.throws(() => parseHierarchy(invalid), hasCode("HIERARCHY_UNAVAILABLE"));
});

function backend(adb: FakeAdb, endpointId = USB): AndroidBackend {
  const endpoint = parseDeviceList(adb.inventory).find((entry) => entry.endpointId === endpointId);
  assert.ok(endpoint);
  return new AndroidBackend(adb, endpoint, new AbortController().signal, () => {});
}

test("hierarchy capture forces a remote terminal while PNG capture remains binary-safe raw output", async () => {
  const adb = new FakeAdb();
  adb.xml = hierarchy().replaceAll("\n", "\r\n");
  const android = backend(adb);
  assert.equal((await android.hierarchy()).elements[0]?.text, "Demo");
  const capture = await android.screenshot();
  assert.deepEqual(capture.image, adb.image);
  assert.deepEqual(adb.calls.map((call) => call.args), [
    ["-t", "7", "shell", "-tt", "uiautomator", "dump", "/dev/tty"],
    ["-t", "7", "exec-out", "screencap", "-p"],
  ]);
});

test("physical identity and modern wireless evidence are checked on the selected transport", async () => {
  const adb = new FakeAdb();
  assert.equal((await backend(adb).identity()).hardwareSerial, USB);
  const wireless = await backend(adb, WIFI).identity();
  assert.equal(wireless.wirelessEvidence, "device-tls-port");
  assert.ok(adb.calls.filter((call) => call.args[1] === "12").every((call) => call.args[0] === "-t"));
  adb.properties["service.adb.tls.port"] = "5555";
  await assert.rejects(backend(adb, WIFI).identity(), hasCode("TRANSPORT_UNVERIFIED"));
  adb.properties["service.adb.tls.port"] = "37891";
  adb.properties["persist.adb.tls_server.enable"] = "0";
  await assert.rejects(backend(adb, WIFI).identity(), hasCode("TRANSPORT_UNVERIFIED"));
});

test("Android version/emulator/unknown metadata are explicit errors, not usable defaults", async () => {
  const adb = new FakeAdb();
  adb.properties["ro.build.version.sdk"] = "29";
  await assert.rejects(backend(adb).identity(), hasCode("DEVICE_UNSUPPORTED"));
  adb.properties["ro.build.version.sdk"] = "30";
  adb.properties["ro.kernel.qemu"] = "1";
  await assert.rejects(backend(adb).identity(), hasCode("DEVICE_UNSUPPORTED"));
  adb.properties["ro.kernel.qemu"] = "0";
  adb.properties["ro.build.version.sdk"] = "";
  await assert.rejects(backend(adb).identity(), hasCode("DEVICE_METADATA_UNAVAILABLE"));
  adb.properties["ro.build.version.sdk"] = "30";
  adb.properties["ro.serialno"] = "unknown";
  assert.equal((await backend(adb).identity()).hardwareSerial, null);
});

test("TLS-connect service endpoints still require device-side Wireless debugging evidence", async () => {
  const adb = new FakeAdb();
  const service = "adb-poc-service._adb-tls-connect._tcp";
  adb.inventory = `List of devices attached\n${service} device transport_id:21\n`;
  assert.equal((await backend(adb, service).identity()).wirelessEvidence, "adb-tls-connect-service");
  adb.properties["service.adb.tls.port"] = "";
  await assert.rejects(backend(adb, service).identity(), hasCode("TRANSPORT_UNVERIFIED"));
});

test("identity properties stay bounded and cannot produce an unbounded tool result", async () => {
  const adb = new FakeAdb();
  adb.properties["ro.serialno"] = "A".repeat(513);
  await assert.rejects(backend(adb).identity(), hasCode("DEVICE_METADATA_UNAVAILABLE"));
  adb.properties["ro.serialno"] = USB;
  adb.properties["ro.build.version.sdk"] = "9".repeat(32);
  await assert.rejects(backend(adb).identity(), hasCode("DEVICE_METADATA_UNAVAILABLE"));
});

test("input commands preserve supported spaces without a host shell or Unicode helper", async () => {
  const adb = new FakeAdb();
  await backend(adb).typeText("POC sample-01,._");
  assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "input", "text", "POC%ssample-01,._"]);
  await assert.rejects(backend(adb).typeText("你好"), hasCode("UNSUPPORTED_TEXT"));
  assert.equal(adb.inputs.length, 1);
  await backend(adb).typeText("  A  B ");
  assert.equal(adb.inputs[1]?.args.at(-1), "%s%sA%s%sB%s");
});

test("input dispatch shares an exact transport and fixed Android key codes", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await android.tap(10, 20);
  await android.swipe({ x: 1, y: 2 }, { x: 30, y: 40 }, 250);
  await android.key("HOME");
  await android.key("BACK");
  await android.key("ENTER");
  assert.deepEqual(adb.inputs.map((call) => call.args), [
    ["-t", "7", "shell", "input", "tap", "10", "20"],
    ["-t", "7", "shell", "input", "swipe", "1", "2", "30", "40", "250"],
    ["-t", "7", "shell", "input", "keyevent", "3"],
    ["-t", "7", "shell", "input", "keyevent", "4"],
    ["-t", "7", "shell", "input", "keyevent", "66"],
  ]);
});

test("app launch is limited to one resolved installed launcher and confirms only dispatch", async () => {
  const adb = new FakeAdb();
  await backend(adb).launchApp("example.poc");
  assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "am", "start", "-W", "-n", "'example.poc/.MainActivity'"]);
  adb.handler = (call) => call.args.includes("resolve-activity") ? Buffer.from("No activity found\n") : undefined;
  await assert.rejects(backend(adb).launchApp("example.poc"), hasCode("APP_NOT_FOUND"));
  await assert.rejects(backend(adb).launchApp("example.poc;other"), hasCode("INVALID_INPUT"));
  assert.equal(adb.inputs.length, 1);
  adb.handler = (call) => call.args.includes("start") ? Buffer.from("Error: not permitted\n") : undefined;
  await assert.rejects(backend(adb).launchApp("example.poc"), (error: unknown) => {
    hasCode("APP_LAUNCH_FAILED")(error);
    assert.ok(error instanceof Error && "actionMayHaveRun" in error && error.actionMayHaveRun === true);
    return true;
  });
});

test("resolved launcher names are single-quoted and cannot introduce remote shell syntax", async () => {
  const adb = new FakeAdb();
  adb.handler = (call) => call.args.includes("resolve-activity")
    ? Buffer.from("example.poc/.Main$Nested\n") : undefined;
  await backend(adb).launchApp("example.poc");
  assert.equal(adb.inputs[0]?.args.at(-1), "'example.poc/.Main$Nested'");
  for (const output of [
    "example.poc/.Main'Activity\n",
    "example.poc/.Main;reboot\n",
    "other.app/.Main\n",
    "example.poc/.One\nexample.poc/.Two\n",
  ]) {
    adb.handler = (call) => call.args.includes("resolve-activity") ? Buffer.from(output) : undefined;
    await assert.rejects(backend(adb).launchApp("example.poc"), hasCode("APP_NOT_FOUND"));
  }
  assert.equal(adb.inputs.length, 1);
});
