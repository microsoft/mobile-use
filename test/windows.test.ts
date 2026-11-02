import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { parseHierarchy } from "../src/android.js";
import { MobileUseService } from "../src/device-session.js";
import { editField, FakeAdb, FakeMonitors, hasCode, hierarchy, node, pixelPng, USB, windowXml, windowsXml } from "./helpers.js";

const button = (attributes: Record<string, string> = {}) => node({
  class: "android.widget.ImageButton", package: "example.recorder", text: "",
  "content-desc": "Stop recording", "resource-id": "example.recorder:id/stop",
  bounds: "[44,64][76,86]", clickable: "false", ...attributes,
});
const overlay = (nodes = button(), attributes: Record<string, string> = {}) => windowXml(nodes, {
  id: "2", layer: "1", bounds: "[30,60][80,96]", active: "false", focused: "false", ...attributes,
});
const screen = (floating = overlay()) => windowsXml(windowXml(node()) + floating);
const editor = (attributes: Record<string, string> = {}) => editField({ package: "example.poc", ...attributes });
const backgroundEditor = () => overlay(editor({
  package: "example.recorder", "resource-id": "example.recorder:id/text", bounds: "[34,64][76,86]",
}));

function harness(t: TestContext) {
  const adb = new FakeAdb();
  adb.xml = screen();
  const service = new MobileUseService(adb, new FakeMonitors(adb).factory);
  t.after(() => service.stop());
  return { adb, service };
}

test("multi-window parsing exposes non-focused controls and preserves package and owning-window metadata", () => {
  const parsed = parseHierarchy(screen());
  assert.equal(parsed.scope, "interactive-windows");
  assert.equal(parsed.rotation, 0);
  assert.deepEqual(parsed.windows.map((window) => [window.id, window.layer, window.active, window.focused]), [
    [2, 1, false, false], [1, 0, true, true],
  ]);
  const stop = parsed.elements.find((element) => element.resourceId === "example.recorder:id/stop");
  assert.equal(stop?.packageName, "example.recorder");
  assert.equal(stop?.windowId, 2);
  assert.equal(stop?.clickable, false, "do not misrepresent native clickability");
});

test("only primary-display content is exposed, and window titles are not returned", () => {
  const parsed = parseHierarchy(windowsXml(windowXml(node(), { title: "private title" }),
    `<display id="7">${windowXml(node({ text: "private secondary screen" }), {}, "", 3)}</display>`));
  assert.equal(parsed.elements.length, 1);
  assert.doesNotMatch(JSON.stringify(parsed), /private title|private secondary/);
  assert.equal(parsed.rotation, 0);
});

test("nested windows are traversed and consistent repeated window records are deduplicated", () => {
  const nested = overlay();
  const parsed = parseHierarchy(windowsXml(windowXml(node(), {}, nested) + nested));
  assert.equal(parsed.windows.length, 2);
  assert.equal(parsed.elements.length, 2);
  assert.throws(() => parseHierarchy(windowsXml(nested + overlay(button({ text: "changed" })))), hasCode("HIERARCHY_UNAVAILABLE"));
});

test("unavailable roots remain explicit without guessing rotation or losing other windows", () => {
  const parsed = parseHierarchy(windowsXml(windowXml(null)));
  assert.equal(parsed.rotation, null);
  assert.deepEqual(parsed.elements, []);
  assert.equal(parsed.windows[0]?.hierarchy, "unavailable");
  assert.equal(parseHierarchy(windowsXml(windowXml(null) + overlay())).elements.length, 1);
});

test("multi-window parsing rejects malformed, ambiguous, inconsistent, and oversized structures", () => {
  const invalid = [
    "<displays/>", "<displays><display id=\"1\"/></displays>",
    "<displays><display id=\"0\"/><display id=\"0\"/></displays>",
    windowsXml("<unexpected/>"), windowsXml(windowXml(node(), { id: "-1" })),
    windowsXml(windowXml(node(), { layer: "1.5" })), windowsXml(windowXml(node(), { active: "yes" })),
    windowsXml(windowXml(node(), { bounds: "[0,0][-1,20]" })),
    windowsXml(windowXml(node(), { type: "application" })),
    windowsXml(windowXml(node(), {}, "", 0) + overlay().replace('rotation="0"', 'rotation="1"')),
    windowsXml(Array.from({ length: 129 }, (_, index) => windowXml(null, { id: String(index) })).join("")),
    windowsXml(windowXml(node().repeat(501))),
  ];
  let deep = windowXml();
  for (let index = 0; index < 17; index++) deep = windowXml(null, { id: String(index + 2) }, deep);
  invalid.push(windowsXml(deep));
  for (const xml of invalid) assert.throws(() => parseHierarchy(xml), hasCode("HIERARCHY_UNAVAILABLE"));
});

test("an observed pointer button can receive a tap despite a changing timer, without screenshots", async (t) => {
  const { adb, service } = harness(t);
  adb.handler = (call) => {
    if (call.args.includes("screencap")) throw new Error("No screenshots allowed");
    return undefined;
  };
  const target = await service.selectDevice(USB);
  const timer = (text: string) => node({ text, clickable: "false", bounds: "[30,64][43,86]" });
  adb.xml = screen(overlay(button() + timer("00:01")));
  const observed = await service.observe(target.targetToken, undefined, false);
  const stop = observed.observation.elements.find((element) => element.resourceId === "example.recorder:id/stop");
  assert.ok(stop?.pointerTarget);
  adb.xml = screen(overlay(button() + timer("00:02")));
  const result = await service.act(target.targetToken, observed.observation.observationId, {
    kind: "tap", target: { elementRef: stop.ref },
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "input", "tap", "60", "75"]);
  assert.equal(result.after?.observation.screenshot.status, "skipped");
  await assert.rejects(service.act(target.targetToken, observed.observation.observationId, {
    kind: "tap", target: { elementRef: stop.ref },
  }), hasCode("STALE_OBSERVATION"));
  assert.equal(adb.inputs.length, 1);
});

test("coordinate pointer gestures still reject changed pixels beside an exposed recorder button", async (t) => {
  for (const kind of ["tap", "long_press", "double_tap"] as const) {
    const { adb, service } = harness(t);
    adb.image = pixelPng(80, 160, () => [255, 255, 255, 255]);
    const target = await service.selectDevice(USB);
    const observed = await service.observe(target.targetToken);
    adb.image = pixelPng(80, 160, (x, y) => [x === 32 && y === 75 ? 0 : 255, 255, 255, 255]);
    await assert.rejects(service.act(target.targetToken, observed.observation.observationId, {
      kind, target: { x: 60, y: 75 },
    }), hasCode("STALE_OBSERVATION"));
    assert.equal(adb.inputs.length, 0);
  }
});

test("native long press uses one stationary primary-display gesture with no helper", async (t) => {
  const { adb, service } = harness(t);
  const target = await service.selectDevice(USB);
  const observed = await service.observe(target.targetToken, undefined, false);
  const stop = observed.observation.elements.find((element) => element.pointerTarget);
  assert.ok(stop);
  const result = await service.act(target.targetToken, observed.observation.observationId, {
    kind: "long_press", target: { elementRef: stop.ref },
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.after?.observation.screenshot.status, "skipped");
  assert.deepEqual(adb.inputs[0]?.args, [
    "-t", "7", "shell", "input", "touchscreen", "-d", "0", "draganddrop", "60", "75", "60", "75", "0", "2>&1",
  ]);
  assert.ok(adb.calls.every((call) => !call.args.includes("push") && !call.args.includes("app_process")));
});

test("changed buttons, window context, foreground app/user, and occluding windows block pointer input", async (t) => {
  for (const kind of ["tap", "long_press", "double_tap"] as const) {
    for (const change of [
      "label", "disabled", "class", "package", "resource", "bounds", "layer", "type", "focus",
      "occluded", "app", "user", "missing",
    ]) {
      await t.test(`${kind}/${change}`, async (t) => {
        const { adb, service } = harness(t);
        const target = await service.selectDevice(USB);
        const observed = await service.observe(target.targetToken, undefined, false);
        const stop = observed.observation.elements.find((element) => element.pointerTarget);
        assert.ok(stop);
        switch (change) {
          case "label": adb.xml = screen(overlay(button({ "content-desc": "Delete recording" }))); break;
          case "disabled": adb.xml = screen(overlay(button({ enabled: "false" }))); break;
          case "class": adb.xml = screen(overlay(button({ class: "android.widget.TextView" }))); break;
          case "package": adb.xml = screen(overlay(button({ package: "example.other" }))); break;
          case "resource": adb.xml = screen(overlay(button({ "resource-id": "" }))); break;
          case "bounds": adb.xml = screen(overlay(button(), { bounds: "[29,60][80,96]" })); break;
          case "layer": adb.xml = screen(overlay(button(), { layer: "2" })); break;
          case "type": adb.xml = screen(overlay(button(), { type: "TYPE_SYSTEM" })); break;
          case "focus": adb.xml = screen(overlay(button(), { focused: "true" })); break;
          case "occluded":
            adb.xml = screen().replace("</display>", windowXml(null, { id: "3", layer: "2" }) + "</display>");
            break;
          case "app": adb.foreground = "example.other/.MainActivity"; break;
          case "user": adb.userId = 10; break;
          case "missing": adb.xml = screen(""); break;
        }
        await assert.rejects(service.act(target.targetToken, observed.observation.observationId, {
          kind, target: { elementRef: stop.ref },
        }), hasCode("ELEMENT_CHANGED"));
        assert.equal(adb.inputs.length, 0);
      });
    }
  }
});

test("native long-press coordinate results preserve screenshot mode", async (t) => {
  const { adb, service } = harness(t);
  const target = await service.selectDevice(USB);
  const observed = await service.observe(target.targetToken);
  const result = await service.act(target.targetToken, observed.observation.observationId, {
    kind: "long_press", target: { x: 60, y: 75 },
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.after?.observation.screenshot.status, "ok");
  assert.ok(result.after?.image);
  assert.equal(adb.inputs.length, 1);
});

test("native long-press diagnostics are sanitized, uncertain, and never replayed", async (t) => {
  for (const includeScreenshot of [false, true]) {
    const { adb, service } = harness(t);
    const target = await service.selectDevice(USB);
    const observed = await service.observe(target.targetToken, undefined, includeScreenshot);
    const stop = observed.observation.elements.find((element) => element.pointerTarget);
    assert.ok(stop);
    adb.handler = (call) => call.args.includes("draganddrop") ? Buffer.from("private native input diagnostics\n") : undefined;
    const result = await service.act(target.targetToken, observed.observation.observationId, {
      kind: "long_press", target: { elementRef: stop.ref },
    });
    assert.equal(result.dispatchStatus, "outcome-unknown");
    assert.equal(result.error?.code, "ADB_FAILED");
    assert.equal(result.error?.actionMayHaveRun, true);
    assert.equal(result.error?.retryable, false);
    assert.doesNotMatch(JSON.stringify(result), /private native input diagnostics/);
    assert.equal(result.verificationStatus, "unverified");
    assert.equal(result.after, null);
    if (!includeScreenshot) assert.ok(adb.calls.every((call) => !call.args.includes("screencap")));
    await assert.rejects(service.act(target.targetToken, observed.observation.observationId, {
      kind: "long_press", target: { elementRef: stop.ref },
    }), hasCode("STALE_OBSERVATION"));
    assert.equal(adb.inputs.length, 1);
  }
});

test("window registration IDs may change while the unique button and owning-window context stay unchanged", async (t) => {
  const { adb, service } = harness(t);
  const target = await service.selectDevice(USB);
  const observed = await service.observe(target.targetToken, undefined, false);
  const stop = observed.observation.elements.find((element) => element.pointerTarget);
  assert.ok(stop);
  adb.xml = screen(overlay(button(), { id: "99" })).replace('id="1"', 'id="98"');
  const result = await service.act(target.targetToken, observed.observation.observationId, {
    kind: "tap", target: { elementRef: stop.ref },
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(adb.inputs.length, 1);
});

test("identical buttons in different window contexts do not redirect references, and ambiguous owners fail closed", async (t) => {
  const { adb, service } = harness(t);
  adb.xml = screen(overlay() + overlay(button(), { id: "3", layer: "2" }));
  const target = await service.selectDevice(USB);
  const observed = await service.observe(target.targetToken, undefined, false);
  const top = observed.observation.elements.find((element) => element.windowId === 3);
  assert.ok(top);
  adb.xml = screen(overlay() + overlay(button(), { id: "4", layer: "2" }));
  assert.equal((await service.act(target.targetToken, observed.observation.observationId, {
    kind: "tap", target: { elementRef: top.ref },
  })).dispatchStatus, "dispatched");
  const fresh = await service.observe(target.targetToken, undefined, false);
  const stop = fresh.observation.elements.find((element) => element.windowId === 4);
  assert.ok(stop);
  adb.xml = screen(overlay() + overlay(button(), { id: "4", layer: "2" }) + overlay(button(), { id: "5", layer: "2" }));
  await assert.rejects(service.act(target.targetToken, fresh.observation.observationId, {
    kind: "tap", target: { elementRef: stop.ref },
  }), hasCode("ELEMENT_CHANGED"));
  assert.equal(adb.inputs.length, 1);
});

test("pointer eligibility requires window ownership, native button class, package, and resource ID", async (t) => {
  for (const xml of [
    hierarchy(button()), screen(overlay(button({ class: "android.view.View" }))),
    screen(overlay(button({ package: "" }))), screen(overlay(button({ "resource-id": "" }))),
  ]) {
    const { adb, service } = harness(t);
    adb.xml = xml;
    const target = await service.selectDevice(USB);
    const observed = await service.observe(target.targetToken, undefined, false);
    assert.ok(observed.observation.elements.every((element) => !element.pointerTarget));
  }
});

test("pointer-button double-tap requires explicit preparation and remains one guarded helper action", async (t) => {
  const { adb, service } = harness(t);
  const target = await service.selectDevice(USB);
  const observed = await service.observe(target.targetToken, undefined, false);
  const stop = observed.observation.elements.find((element) => element.pointerTarget);
  assert.ok(stop);
  await assert.rejects(service.act(target.targetToken, observed.observation.observationId, {
    kind: "double_tap", target: { elementRef: stop.ref }, delayMs: 50,
  }), hasCode("GESTURE_HELPER_NOT_PREPARED"));
  assert.equal(adb.inputs.length, 0);
  assert.ok(adb.calls.every((call) => !call.args.includes("push")));
  const prepared = await service.prepareGestures(target.targetToken);
  const fresh = await service.observe(target.targetToken, undefined, false);
  const current = fresh.observation.elements.find((element) => element.pointerTarget);
  assert.ok(current);
  assert.equal(current.clickable, false);
  const result = await service.act(target.targetToken, fresh.observation.observationId, {
    kind: "double_tap", target: { elementRef: current.ref }, delayMs: 50,
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.after?.observation.screenshot.status, "skipped");
  assert.deepEqual(result.gestureTiming, { requestedDelayMs: 50, actualGapMs: 50 });
  assert.equal(adb.inputs.length, 1);
  assert.deepEqual(adb.inputs[0]?.args, [
    "-t", "7", "shell", `CLASSPATH=${prepared.remotePath}`, "app_process", "/",
    "dev.mobileuse.gestures.GestureMain", "60", "75", "50",
  ]);
});

test("active-only OEM responses and rootless windows produce explicit observation warnings", async (t) => {
  const { adb, service } = harness(t);
  const target = await service.selectDevice(USB);
  adb.xml = hierarchy();
  const legacy = await service.observe(target.targetToken, undefined, false);
  assert.equal(legacy.observation.hierarchyScope, "active-window");
  assert.ok(legacy.observation.warnings.some((warning) => /Only the active window/.test(warning)));
  adb.xml = windowsXml(windowXml(null));
  const rootless = await service.observe(target.targetToken, undefined, false);
  assert.equal(rootless.observation.hierarchyScope, "interactive-windows");
  assert.equal(rootless.observation.display?.rotation, 0);
  assert.ok(rootless.observation.warnings.some((warning) => /no accessible root/.test(warning)));
});

test("windowed text input never targets a focused editor in an inactive floating window", async (t) => {
  for (const [prepared, includeScreenshot] of [[false, false], [false, true], [true, false], [true, true]] as const) {
    const { adb, service } = harness(t);
    adb.xml = screen(backgroundEditor());
    const target = await service.selectDevice(USB);
    if (prepared) await service.prepareTextInput(target.targetToken);
    const observed = await service.observe(target.targetToken, undefined, includeScreenshot);
    assert.equal(observed.observation.elements.filter((element) => element.editable && element.focused).length, 1);
    await assert.rejects(service.act(target.targetToken, observed.observation.observationId, {
      kind: "type_text", text: "safe-01",
    }), hasCode("ELEMENT_CHANGED"));
    assert.equal(adb.inputs.length, 0);
  }
});

test("windowed text input selects the active app editor even when another window retains node focus", async (t) => {
  for (const [prepared, includeScreenshot] of [[false, false], [false, true], [true, false], [true, true]] as const) {
    const { adb, service } = harness(t);
    adb.xml = windowsXml(windowXml(editor()) + backgroundEditor());
    const target = await service.selectDevice(USB);
    if (prepared) await service.prepareTextInput(target.targetToken);
    const observed = await service.observe(target.targetToken, undefined, includeScreenshot);
    assert.equal(observed.observation.elements.filter((element) => element.editable && element.focused).length, 2);
    adb.xml = adb.xml.replace('id="1"', 'id="101"').replace('id="2"', 'id="102"');
    const result = await service.act(target.targetToken, observed.observation.observationId, {
      kind: "type_text", text: "safe-01",
    });
    assert.equal(result.dispatchStatus, "dispatched");
    assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "input", "text", "safe-01"]);
    assert.equal(result.after?.observation.screenshot.status, includeScreenshot ? "ok" : "skipped");
  }
});

test("windowed text input rejects changed, unowned, ambiguous, or non-application field contexts", async (t) => {
  for (const change of [
    "inactive", "unfocused", "owner-type", "owner-bounds", "owner-layer", "owner-ambiguous", "owner-missing",
    "package-missing", "foreign-package", "app", "activity", "user", "foreground-before", "foreground-after",
    "scope-downgrade", "scope-upgrade", "old-ambiguous",
  ]) {
    await t.test(change, async (t) => {
      const { adb, service } = harness(t);
      const primary = (attributes: Record<string, string> = {}) => windowsXml(windowXml(editor(), attributes));
      const missingForeground = () => {
        adb.handler = (call) => call.args.includes("activities") ? Buffer.from("Fixture metadata unavailable") : undefined;
      };
      adb.xml = primary();
      if (change === "package-missing") adb.xml = windowsXml(windowXml(editor({ package: "" })));
      if (change === "foreign-package") adb.xml = windowsXml(windowXml(editor({ package: "example.other" })));
      if (change === "foreground-before") missingForeground();
      if (change === "scope-upgrade") adb.xml = hierarchy(editor());
      if (change === "old-ambiguous") adb.xml = windowsXml(windowXml(editor() + editor()));
      const target = await service.selectDevice(USB);
      const observed = await service.observe(target.targetToken, undefined, false);
      if (change === "foreground-before") {
        assert.ok(observed.observation.warnings.some((warning) => /windowed element\/text input are blocked/.test(warning)));
      }
      switch (change) {
        case "inactive": adb.xml = primary({ active: "false" }); break;
        case "unfocused": adb.xml = primary({ focused: "false" }); break;
        case "owner-type": adb.xml = primary({ type: "TYPE_INPUT_METHOD" }); break;
        case "owner-bounds": adb.xml = primary({ bounds: "[0,0][79,160]" }); break;
        case "owner-layer": adb.xml = primary({ layer: "1" }); break;
        case "owner-ambiguous": adb.xml = windowsXml(windowXml(editor()) + windowXml(node(), { id: "2" })); break;
        case "owner-missing": adb.xml = windowsXml(windowXml(null)); break;
        case "app": adb.foreground = "example.other/.MainActivity"; break;
        case "activity": adb.foreground = "example.poc/.OtherActivity"; break;
        case "user": adb.userId = 10; break;
        case "foreground-before": adb.handler = undefined; break;
        case "foreground-after": missingForeground(); break;
        case "scope-downgrade": adb.xml = hierarchy(editor()); break;
        case "scope-upgrade":
        case "old-ambiguous": adb.xml = primary(); break;
      }
      await assert.rejects(service.act(target.targetToken, observed.observation.observationId, {
        kind: "type_text", text: "safe-01",
      }), hasCode("ELEMENT_CHANGED"));
      assert.equal(adb.inputs.length, 0);
    });
  }
});
