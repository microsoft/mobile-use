import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { MobileUseService } from "../src/device-session.js";
import { FakeAdb, FakeMonitors, hasCode, hierarchy, node, pixelPng, USB, windowXml, windowsXml } from "./helpers.js";

function harness(t: TestContext) {
  const adb = new FakeAdb();
  const service = new MobileUseService(adb, new FakeMonitors(adb).factory);
  t.after(() => service.stop());
  return { adb, service };
}

const bounds = { x: 32, y: 72, width: 16, height: 16 };
const visual = { x: 40, y: 80, bounds };
const surface = (attributes: Record<string, string> = {}, children = "") => node({
  class: "android.widget.ScrollView", text: "", clickable: "false", scrollable: "true",
  "resource-id": "example.poc:id/surface", bounds: "[0,20][80,160]", ...attributes,
}, children);

test("video playback and independent timer changes do not veto metadata-backed taps, holds or pairs", async (t) => {
  for (const kind of ["tap", "long_press", "double_tap"] as const) {
    for (const target of [{ elementRef: "e1" }, { x: 24, y: 18 }]) {
      const { adb, service } = harness(t);
      const timer = (text: string) => node({
        class: "android.widget.TextView", text, clickable: "false", bounds: "[44,8][76,28]",
      });
      adb.xml = hierarchy(node() + timer("00:01"));
      const selected = await service.selectDevice(USB);
      if (kind === "double_tap") await service.prepareGestures(selected.targetToken);
      const observed = await service.observe(selected.targetToken);
      adb.image = pixelPng(80, 160, () => [240, 240, 240, 255]);
      adb.xml = hierarchy(node() + timer("00:02"));
      const result = await service.act(selected.targetToken, observed.observation.observationId, { kind, target });
      assert.equal(result.dispatchStatus, "dispatched");
      assert.equal(result.verificationStatus, "requires-observation-review");
      assert.deepEqual(adb.inputs[0]?.args.slice(kind === "double_tap" ? -3 : -2), kind === "double_tap" ? ["24", "18", "50"]
        : kind === "tap" ? ["24", "18"] : ["0", "2>&1"]);
    }
  }
});

test("coordinate metadata keeps the requested point instead of recentering on a button", async (t) => {
  const { adb, service } = harness(t);
  const selected = await service.selectDevice(USB);
  const observed = await service.observe(selected.targetToken);
  await service.act(selected.targetToken, observed.observation.observationId, { kind: "tap", target: { x: 5, y: 9 } });
  assert.deepEqual(adb.inputs[0]?.args.slice(-2), ["5", "9"]);
});

test("visual bounds cannot bypass disabled, changed, removed or ambiguous actionable metadata", async (t) => {
  for (const change of ["disabled", "label", "movement", "removed", "overlap", "ambiguous"] as const) {
    const { adb, service } = harness(t);
    if (change === "disabled") adb.xml = hierarchy(node({ enabled: "false" }));
    if (change === "ambiguous") adb.xml = hierarchy(node() + node({ "resource-id": "example.poc:id/other" }));
    const selected = await service.selectDevice(USB);
    const observed = await service.observe(selected.targetToken);
    if (change === "label") adb.xml = hierarchy(node({ text: "Purchase" }));
    if (change === "movement") adb.xml = hierarchy(node({ bounds: "[5,8][45,28]" }));
    if (change === "removed") adb.xml = hierarchy("");
    if (change === "overlap") adb.xml = hierarchy(node() + node({ "resource-id": "example.poc:id/overlay" }));
    await assert.rejects(service.act(selected.targetToken, observed.observation.observationId, {
      kind: "tap", target: { x: 10, y: 10, bounds: { x: 4, y: 8, width: 40, height: 20 } },
    }), hasCode("ELEMENT_CHANGED"));
    assert.equal(adb.inputs.length, 0, change);
  }
});

test("bare custom-drawn points require complete visual bounds, including on an identical screen", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy("");
  const selected = await service.selectDevice(USB);
  for (const target of [
    { x: 40, y: 80 },
    { x: 40, y: 80, bounds: { x: 40, y: 80, width: 41, height: 16 } },
    { x: 40, y: 80, bounds: { x: 0, y: 0, width: 10, height: 10 } },
  ]) {
    const observed = await service.observe(selected.targetToken);
    await assert.rejects(service.act(selected.targetToken, observed.observation.observationId, { kind: "tap", target }), hasCode("INVALID_INPUT"));
  }
  assert.equal(adb.inputs.length, 0);
});

test("a generic clickable video container is not semantic evidence for a custom-drawn control at a coordinate", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy(node({
    class: "android.widget.FrameLayout", text: "", bounds: "[0,0][80,160]", "resource-id": "example.poc:id/player",
  }));
  adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
  const selected = await service.selectDevice(USB);
  const observed = await service.observe(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, observed.observation.observationId, {
    kind: "tap", target: { x: 40, y: 80 },
  }), hasCode("INVALID_INPUT"));
  const fresh = await service.observe(selected.targetToken);
  adb.image = pixelPng(80, 160, (x, y) => [x === 32 && y === 80 ? 0 : 255, 255, 255, 255]);
  await assert.rejects(service.act(selected.targetToken, fresh.observation.observationId, {
    kind: "tap", target: visual,
  }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 0);
});

test("visual fallback protects the complete control, not just its touch point, and ignores unrelated pixels in the same row", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy("");
  const selected = await service.selectDevice(USB);
  for (const x of [0, 32, 47, 55]) {
    adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
    const observed = await service.observe(selected.targetToken);
    adb.image = pixelPng(80, 160, (px, y) => [px === x && y === 80 ? 0 : 255, 255, 255, 255]);
    const action = service.act(selected.targetToken, observed.observation.observationId, { kind: "tap", target: visual });
    if (x === 0) assert.equal((await action).dispatchStatus, "dispatched");
    else await assert.rejects(action, hasCode("STALE_OBSERVATION"));
  }
  assert.equal(adb.inputs.length, 1);
});

test("visual fallback revalidates nearby element/window metadata even with identical pixels", async (t) => {
  for (const change of ["element", "window", "coverage"] as const) {
    const { adb, service } = harness(t);
    adb.xml = windowsXml(windowXml(node({ class: "android.widget.TextView", clickable: "false", bounds: "[36,72][44,88]" })));
    const selected = await service.selectDevice(USB);
    const observed = await service.observe(selected.targetToken);
    if (change === "element") adb.xml = windowsXml(windowXml(node({
      class: "android.widget.TextView", clickable: "false", text: "Changed", bounds: "[36,72][44,88]",
    })));
    if (change === "window") adb.xml = windowsXml(windowXml(node({
      class: "android.widget.TextView", clickable: "false", bounds: "[36,72][44,88]",
    }), { layer: "1" }));
    if (change === "coverage") adb.xml = hierarchy("");
    await assert.rejects(service.act(selected.targetToken, observed.observation.observationId, { kind: "tap", target: visual }), hasCode("STALE_OBSERVATION"));
    assert.equal(adb.inputs.length, 0);
  }
});

test("scrollable metadata survives video and child-content changes without a pixel veto", async (t) => {
  for (const explicit of [false, true]) {
    const { adb, service } = harness(t);
    adb.xml = hierarchy(surface({}, node({ text: "Before", bounds: "[4,40][44,60]" })));
    const selected = await service.selectDevice(USB);
    const observed = await service.observe(selected.targetToken);
    adb.xml = hierarchy(surface({}, node({ text: "After", bounds: "[4,40][44,60]" })));
    adb.image = pixelPng(80, 160, () => [240, 240, 240, 255]);
    const result = await service.act(selected.targetToken, observed.observation.observationId, {
      kind: "swipe", from: { x: 20, y: 120 }, to: { x: 20, y: 50 },
      ...(explicit ? { elementRef: "e1" } : {}),
    });
    assert.equal(result.dispatchStatus, "dispatched");
    assert.deepEqual(adb.inputs[0]?.args.slice(-5), ["20", "120", "20", "50", "400"]);
  }
});

test("missing or ambiguous swipe metadata cannot silently fall back to a visual gesture", async (t) => {
  for (const change of ["disabled", "removed", "ambiguous", "invalid-ref", "outside", "outside-inferred", "occluded"] as const) {
    const { adb, service } = harness(t);
    adb.xml = change === "occluded" ? windowsXml(windowXml(surface())) : hierarchy(surface());
    if (change === "disabled") adb.xml = hierarchy(surface({ enabled: "false" }));
    if (change === "ambiguous") adb.xml = hierarchy(surface() + surface({ "resource-id": "example.poc:id/other" }));
    const selected = await service.selectDevice(USB);
    const observed = await service.observe(selected.targetToken);
    if (change === "removed") adb.xml = hierarchy("");
    if (change === "occluded") adb.xml = windowsXml(windowXml(surface()) + windowXml(null, {
      id: "2", layer: "1", bounds: "[8,70][30,90]",
    }));
    await assert.rejects(service.act(selected.targetToken, observed.observation.observationId, {
      kind: "swipe", from: { x: 20, y: 120 }, to: { x: 20, y: change.startsWith("outside") ? 10 : 50 },
      ...(change === "invalid-ref" ? { elementRef: "e99" } : change === "outside" ? { elementRef: "e1" } : {}),
      bounds: { x: 0, y: 0, width: 80, height: 160 },
    }), hasCode(change.startsWith("outside") ? "INVALID_INPUT" : "ELEMENT_CHANGED"));
    assert.equal(adb.inputs.length, 0);
  }
});

test("a newly exposed actionable child at swipe start cannot redirect a metadata-backed gesture", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy(surface());
  const selected = await service.selectDevice(USB);
  const observed = await service.observe(selected.targetToken);
  adb.xml = hierarchy(surface({}, node({ text: "Delete", bounds: "[4,110][44,130]" })));
  await assert.rejects(service.act(selected.targetToken, observed.observation.observationId, {
    kind: "swipe", from: { x: 20, y: 120 }, to: { x: 20, y: 50 }, elementRef: "e1",
  }), hasCode("ELEMENT_CHANGED"));
  assert.equal(adb.inputs.length, 0);
});

test("visual swipes require surface bounds and guard the complete path and surrounding margin", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = hierarchy("");
  const selected = await service.selectDevice(USB);
  const swipe = { kind: "swipe", from: { x: 40, y: 120 }, to: { x: 40, y: 40 } };
  const observed = await service.observe(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, observed.observation.observationId, swipe), hasCode("INVALID_INPUT"));
  const fresh = await service.observe(selected.targetToken);
  await assert.rejects(service.act(selected.targetToken, fresh.observation.observationId, { ...swipe, bounds }), hasCode("INVALID_INPUT"));
  assert.equal(adb.inputs.length, 0);
});
