import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";
import { parseDeviceList } from "../src/adb.js";
import { AndroidBackend } from "../src/android.js";
import { MobileUseError } from "../src/errors.js";
import { gestureHelperBase64, gestureHelperSha256 } from "../src/gesture-helper-data.js";
import { FakeAdb, hasCode } from "./helpers.js";

function backend(adb: FakeAdb): AndroidBackend {
  const endpoint = parseDeviceList(adb.inventory)[0];
  assert.ok(endpoint);
  return new AndroidBackend(adb, endpoint, new AbortController().signal, () => {});
}

test("the embedded gesture helper has DEX framing and matches its pinned digest", () => {
  const bytes = Buffer.from(gestureHelperBase64, "base64");
  assert.match(bytes.subarray(0, 8).toString("ascii"), /^dex\n0\d\d\0$/);
  assert.equal(bytes.readUInt32LE(32), bytes.length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), gestureHelperSha256);
});

test("approved preparation uploads pinned bytes, uses read-only private storage, and removes only its local temporary copy", async () => {
  const adb = new FakeAdb();
  const prepared = await backend(adb).prepareGestures();
  const push = adb.calls.find((call) => call.args[2] === "push");
  assert.ok(push?.args[3]);
  assert.match(prepared.remotePath, /^\/data\/local\/tmp\/mobile-use-gestures-[0-9a-f-]{36}\/gestures\.dex$/);
  assert.equal(prepared.sha256, gestureHelperSha256);
  assert.deepEqual(adb.gestureFiles.get(prepared.remotePath), Buffer.from(gestureHelperBase64, "base64"));
  await assert.rejects(access(push.args[3]), { code: "ENOENT" });
  assert.ok(adb.calls.some((call) => call.args.includes("mkdir") && call.args.includes("700")));
  assert.ok(adb.calls.some((call) => call.args.includes("chmod") && call.args.includes("400")));
  assert.equal(adb.inputs.length, 0);
});

test("cancelled preparation never deploys; partial push failure is uncertain and is never retried", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(android.prepareGestures(controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, 0);
  adb.handler = (call) => {
    if (call.args[2] === "push") {
      throw new MobileUseError("ADB_FAILED", "Fixture push interrupted.", "Do not replay automatically.", false, true);
    }
    return undefined;
  };
  await assert.rejects(android.prepareGestures(), (error: unknown) => {
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return hasCode("ADB_FAILED")(error);
  });
  const pushes = adb.calls.filter((call) => call.args[2] === "push");
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0]?.args[3]);
  await assert.rejects(access(pushes[0].args[3]), { code: "ENOENT" });
  await assert.rejects(android.doubleTap(10, 20, 50), hasCode("GESTURE_HELPER_NOT_PREPARED"));
  assert.equal(adb.inputs.length, 0);
});
