import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";
import { parseDeviceList } from "../src/adb.js";
import { AndroidBackend, parseHierarchy } from "../src/android.js";
import { MobileUseError } from "../src/errors.js";
import { textHelperBase64, textHelperSha256 } from "../src/text-helper-data.js";
import { FakeAdb, displayDiagnostics, editField, hasCode, hierarchy, textHash } from "./helpers.js";

function backend(adb: FakeAdb): AndroidBackend {
  const endpoint = parseDeviceList(adb.inventory)[0];
  assert.ok(endpoint);
  return new AndroidBackend(adb, endpoint, new AbortController().signal, () => {});
}
const foreground = { packageName: "example.poc", activityName: "example.poc.MainActivity", userId: 0 };
const parsedField = parseHierarchy(hierarchy(editField({ text: "existing" }))).elements[0];
assert.ok(parsedField);
const field = { ...parsedField, ref: "e1", textHash: textHash("existing"), windowIdentity: "abc:u0" };

test("the embedded text helper has DEX framing and matches its pinned digest", () => {
  const bytes = Buffer.from(textHelperBase64, "base64");
  assert.match(bytes.subarray(0, 8).toString("ascii"), /^dex\n0\d\d\0$/);
  assert.equal(bytes.readUInt32LE(32), bytes.length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), textHelperSha256);
});

test("Unicode requires preparation while original ASCII input stays helper-free", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await assert.rejects(android.typeText("你好", undefined, field, foreground), hasCode("TEXT_HELPER_NOT_PREPARED"));
  assert.equal(adb.calls.length, 0);
  await android.typeText("sample-01");
  assert.deepEqual(adb.inputs[0]?.args.slice(2), ["shell", "input", "text", "sample-01"]);
  await assert.rejects(android.typeText("你好"), hasCode("ELEMENT_CHANGED"));
});

test("Unicode requires a raw-text fingerprint from the prepared helper before any command", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await android.prepareTextInput();
  const calls = adb.calls.length;
  for (const invalidField of [{ ...parsedField, ref: "e1" }, { ...field, textHash: "invalid" }]) {
    await assert.rejects(android.typeText("中文", undefined, invalidField, foreground), hasCode("ELEMENT_CHANGED"));
  }
  assert.equal(adb.calls.length, calls);
});

test("Unicode requires the observed native window identity before any command", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await android.prepareTextInput();
  const calls = adb.calls.length;
  const { windowIdentity: _windowIdentity, ...missingWindow } = field;
  await assert.rejects(android.typeText("中文", undefined, missingWindow, foreground), hasCode("ELEMENT_CHANGED"));
  for (const windowIdentity of ["", "abc:u10", "abc:u01", "unknown", "abcdefabc:u0"]) {
    await assert.rejects(android.typeText("中文", undefined, { ...field, windowIdentity }, foreground), hasCode("ELEMENT_CHANGED"));
  }
  assert.equal(adb.calls.length, calls);
});

test("explicit preparation is pinned, private, read-only, screen-free, and cleans its local copy", async () => {
  const adb = new FakeAdb();
  const prepared = await backend(adb).prepareTextInput();
  const push = adb.calls.find((call) => call.args[2] === "push");
  assert.ok(push?.args[3]);
  assert.match(prepared.remotePath, /^\/data\/local\/tmp\/mobile-use-text-[0-9a-f-]{36}\/text\.dex$/);
  assert.equal(prepared.sha256, textHelperSha256);
  assert.deepEqual(adb.gestureFiles.get(prepared.remotePath), Buffer.from(textHelperBase64, "base64"));
  await assert.rejects(access(push.args[3]), { code: "ENOENT" });
  assert.ok(adb.calls.some((call) => call.args.includes("mkdir") && call.args.includes("700")));
  assert.ok(adb.calls.some((call) => call.args.includes("chmod") && call.args.includes("400")));
  assert.equal(adb.calls.some((call) => call.args.some((arg) => ["screencap", "uiautomator", "rm"].includes(arg))), false);
  assert.equal(adb.inputs.length, 0);
});

test("all extended text is carried as length-prefixed UTF-8 data, never shell syntax", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await android.prepareTextInput();
  for (const text of ["中文", "日本語", "한국어", "العربية", "русский", "e\u0301", "👩‍💻😀", "'\"$HOME;%s&|`\\\n\t", "line\n", "line\r", "line\r\n"]) {
    await android.typeText(text, undefined, field, foreground);
    const args = adb.inputs.at(-1)?.args;
    assert.ok(args);
    assert.equal(args[6], "dev.mobileuse.text.TextMain");
    const encoded = args[7] ?? "";
    assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
    const data = Buffer.from(encoded, "base64");
    assert.deepEqual(Array.from({ length: 6 }, (_, index) => data.readInt32BE(index * 4)), [4, 0, 4, 32, 72, 24]);
    let offset = 24;
    const strings = [];
    for (let i = 0; i < 6; i++) {
      const length = data.readInt32BE(offset);
      offset += 4;
      strings.push(data.subarray(offset, offset + length).toString("utf8"));
      offset += length;
    }
    assert.deepEqual(strings, [field.windowIdentity, foreground.packageName, field.className, field.resourceId, field.textHash, text]);
    assert.equal(offset, data.length);
  }
  assert.equal(adb.calls.some((call) => call.args.includes("input")), false);
});

test("prepared observations preserve Unicode through the pinned helper, with geometry guards and no lossy-dump fallback", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  const prepared = await android.prepareTextInput();
  const text = "  中文 👩‍💻😀 e\u0301\r\n\t&#10;  ";
  adb.xml = hierarchy(editField({ text }));
  const start = adb.calls.length;
  const observed = (await android.hierarchy()).elements[0];
  assert.equal(observed?.text, text);
  assert.equal(observed?.windowIdentity, "abc:u0");
  assert.equal(adb.calls.slice(start).some((call) => call.args.includes("uiautomator")), false);
  assert.ok(adb.calls.slice(start).some((call) => call.args[7] === "--dump" && !call.options.mutating));
  adb.handler = (call) => {
    if (call.args[7] === "--dump") adb.display = displayDiagnostics(1, 160, 80);
    return undefined;
  };
  await assert.rejects(android.hierarchy(), hasCode("STALE_OBSERVATION"));
  adb.handler = undefined;
  adb.gestureFiles.delete(prepared.remotePath);
  await assert.rejects(android.hierarchy(), hasCode("ADB_FAILED"));
  assert.equal(adb.calls.slice(start).some((call) => call.args.includes("uiautomator")), false);
});

test("helper failures expose only allowlisted phases and never turn a failed read into input", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await android.prepareTextInput();
  for (const phase of ["ROOT", "WINDOW", "WINDOW_FOCUS", "WINDOW_OWNER", "WINDOW_READ", "HIERARCHY", "CONNECT", "CONFIGURE", "DISCONNECT"]) {
    adb.handler = (call) => call.args[7] === "--dump"
      ? Buffer.from(`MOBILE_USE_TEXT_V1_ERROR_${phase}\n`) : undefined;
    await assert.rejects(android.hierarchy(), (error: unknown) => {
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.code, "HIERARCHY_UNAVAILABLE");
      assert.equal(error.message, `The Unicode hierarchy helper failed during ${phase}.`);
      assert.equal(error.actionMayHaveRun, false);
      return true;
    });
  }
  assert.equal(adb.inputs.length, 0);
  adb.handler = (call) => call.args[7] === "--dump"
    ? Buffer.from("MOBILE_USE_TEXT_V1_ERROR_private-device-content\n") : undefined;
  await assert.rejects(android.hierarchy(), (error: unknown) => {
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.code, "HIERARCHY_UNAVAILABLE");
    assert.doesNotMatch(error.message, /private-device-content/);
    return true;
  });
  for (const [phase, uncertain] of [
    ["REQUEST", false], ["CONNECT", false], ["CONFIGURE", false], ["ROOT", false],
    ["WINDOW", false], ["HIERARCHY", false], ["TARGET", false],
    ["TARGET_OWNER", false], ["TARGET_READ", false], ["WINDOW_LIMIT", false], ["VERIFY_READ", true],
    ["WRITE", true], ["VERIFY", true], ["DISCONNECT", true], ["private-device-content", true],
  ] as const) {
    adb.handler = (call) => call.options.mutating && call.args[6] === "dev.mobileuse.text.TextMain"
      ? Buffer.from(`MOBILE_USE_TEXT_V1_ERROR_${phase}\n`) : undefined;
    const before: number = adb.inputs.length;
    await assert.rejects(android.typeText("中文", undefined, field, foreground), (error: unknown) => {
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.code, "TEXT_INPUT_FAILED");
      assert.equal(error.message, phase === "private-device-content"
        ? "Android did not confirm the requested text in the original focused field."
        : `The Unicode text helper failed during ${phase}.`);
      assert.equal(error.actionMayHaveRun, uncertain);
      assert.equal(error.retryable, false);
      assert.match(error.remediation, uncertain ? /Text may have changed/ : /No text was written/);
      assert.doesNotMatch(JSON.stringify(error), /private-device-content/);
      return true;
    });
    assert.equal(adb.inputs.length, before + 1);
  }
});

test("modified helpers block input and rejected writes never fall back or replay", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  const prepared = await android.prepareTextInput();
  adb.gestureFiles.set(prepared.remotePath, Buffer.from("modified"));
  await assert.rejects(android.typeText("中文", undefined, field, foreground), hasCode("TEXT_HELPER_UNAVAILABLE"));
  assert.equal(adb.inputs.length, 0);
  adb.gestureFiles.set(prepared.remotePath, Buffer.from(textHelperBase64, "base64"));
  for (const [status, code, uncertain] of [
    ["ELEMENT_CHANGED", "ELEMENT_CHANGED", false], ["ELEMENT_CHANGED_FIELD_TEXT", "ELEMENT_CHANGED", false],
    ["ELEMENT_CHANGED_WINDOW_ID", "ELEMENT_CHANGED", false], ["ELEMENT_CHANGED_FIELD_WINDOW", "ELEMENT_CHANGED", false],
    ["UNSUPPORTED", "TEXT_INPUT_UNSUPPORTED", false],
    ["FAILED", "TEXT_INPUT_FAILED", true], ["UNKNOWN", "TEXT_INPUT_FAILED", true],
  ] as const) {
    adb.handler = (call) => call.args[6] === "dev.mobileuse.text.TextMain"
      ? Buffer.from(`MOBILE_USE_TEXT_V1_${status}\n`) : undefined;
    const before: number = adb.inputs.length;
    await assert.rejects(android.typeText("中文", undefined, field, foreground), (error: unknown) => {
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.actionMayHaveRun, uncertain);
      assert.equal(error.retryable, false);
      return hasCode(code)(error);
    });
    assert.equal(adb.inputs.length, before + 1);
  }
});

test("cancelled or partial preparation cannot enable Unicode input", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(android.prepareTextInput(controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, 0);
  adb.handler = (call) => {
    if (call.args[2] === "push") throw new MobileUseError("ADB_TIMEOUT", "Fixture timeout.", "Do not replay.", false, true);
    return undefined;
  };
  await assert.rejects(android.prepareTextInput(), (error: unknown) => {
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun);
    return hasCode("ADB_TIMEOUT")(error);
  });
  assert.equal(adb.calls.filter((call) => call.args[2] === "push").length, 1);
  await assert.rejects(android.typeText("中文", undefined, field, foreground), hasCode("TEXT_HELPER_NOT_PREPARED"));
});
