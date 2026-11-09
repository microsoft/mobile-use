import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { isRecord, MobileUseError } from "../src/errors.js";
import { IosMobileUseService } from "../src/ios/device-session.js";
import { parseIosHierarchy } from "../src/ios/hierarchy.js";
import { readWdaUrl, WdaClient } from "../src/ios/wda.js";
import { chunk, png } from "./helpers.js";
import { createIosFixture } from "./ios-fixture.js";

async function fixture(t: TestContext, now?: () => number) {
  const http = await createIosFixture();
  const service = new IosMobileUseService(http.url, now);
  t.after(async () => { await service.stop(); await http.close(); });
  return { ...http, service };
}

async function select(f: Awaited<ReturnType<typeof fixture>>) {
  const [device] = await f.service.listDevices();
  assert.ok(device);
  return (await f.service.selectDevice(device.endpointId)).targetToken;
}

function ref(screen: Awaited<ReturnType<IosMobileUseService["observe"]>>, name: string) {
  const element = screen.observation.elements.find((item) => item.resourceId === name);
  assert.ok(element);
  return element.ref;
}

const mutations = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter((call) =>
  call.path.endsWith("/actions") || call.path.endsWith("/value") || call.path.endsWith("/wda/homescreen"));

test("iOS doctor/discovery are read-only and do not create sessions, capture or imply USB discovery", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.doctor()).platform, "ios");
  const [device] = await f.service.listDevices();
  assert.equal(device?.kind, "unknown");
  assert.equal(device?.transportId, null);
  assert.equal(device?.selectable, true);
  assert.ok(f.calls.every((call) => call.method === "GET"));
  assert.ok(f.calls.every((call) => /status|device\/info/.test(call.path)));
  assert.equal(f.state.sessionId, null);
});

test("iOS validates explicit configuration and refuses simulator/unsupported devices before session creation", async (t) => {
  for (const url of [undefined, "http://localhost:8100", "https://127.0.0.1:8100", "http://127.0.0.1",
    "http://127.0.0.1:8100/path", "http://user:password@127.0.0.1:8100"]) {
    assert.throws(() => readWdaUrl(url), /iOS\/WDA/);
  }
  const f = await fixture(t);
  f.state.simulator = true;
  await assert.rejects(f.service.listDevices(), (error: unknown) => error instanceof MobileUseError && error.code === "DEVICE_UNSUPPORTED");
  f.state.simulator = false;
  f.state.iosVersion = "16.7";
  await assert.rejects(f.service.listDevices(), (error: unknown) => error instanceof MobileUseError && error.code === "DEVICE_UNSUPPORTED");
  assert.equal(f.state.sessionId, null);
});

test("a foreign WDA session is reported and never replaced, including on shutdown", async (t) => {
  const f = await fixture(t);
  f.state.sessionId = "foreign-session";
  const [device] = await f.service.listDevices();
  assert.ok(device);
  assert.equal(device.selectable, false);
  await assert.rejects(f.service.selectDevice(device.endpointId), (error: unknown) =>
    error instanceof MobileUseError && error.code === "WDA_SESSION_CONFLICT" && !error.actionMayHaveRun);
  await f.service.stop();
  assert.equal(f.state.sessionId, "foreign-session");
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("explicit selection owns one session and reselection invalidates tokens without capturing or launching", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  assert.ok(f.state.sessionId);
  const next = await select(f);
  assert.notEqual(next, token);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 1);
  await assert.rejects(f.service.observe(token), (error: unknown) => error instanceof MobileUseError && error.code === "STALE_TARGET");
  assert.equal(f.calls.some((call) => /source|screenshot|apps\/launch/.test(call.path)), false);
  await f.service.stop();
  assert.equal(f.state.sessionId, null);
});

test("iOS observations use pixel geometry, scoped refs and redact secure editor subtrees", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token);
  assert.deepEqual(screen.observation.display, { width: 80, height: 160, rotation: 0, scale: 2 });
  assert.equal(screen.observation.targetToken, token);
  assert.ok(screen.image);
  const button = screen.observation.elements.find((item) => item.resourceId === "button");
  assert.deepEqual(button?.bounds, { x: 10, y: 10, width: 20, height: 20 });
  assert.doesNotMatch(JSON.stringify(screen.observation), /private-name|private-label|private-value|private-child/);
  assert.equal(screen.observation.elements.find((item) => item.resourceId === "editor")?.focused, true);
  assert.match(screen.observation.warnings.join(" "), /non-atomic/);
});

test("hierarchy-only taps preserve no-capture mode; coordinates and swipes cannot silently capture", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  let screen = await f.service.observe(token, undefined, false);
  const result = await f.service.act(token, screen.observation.observationId, { kind: "tap", target: { elementRef: ref(screen, "button") } });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.after?.observation.screenshot.status, "skipped");
  assert.equal(result.after?.image, null);
  screen = await f.service.observe(token, undefined, false);
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "tap", target: { x: 20, y: 20 } }),
    (error: unknown) => error instanceof MobileUseError && error.code === "CAPTURE_UNAVAILABLE");
  screen = await f.service.observe(token, undefined, false);
  await assert.rejects(f.service.act(token, screen.observation.observationId, {
    kind: "swipe", from: { x: 10, y: 100 }, to: { x: 10, y: 140 }, elementRef: ref(screen, "table"),
  }), (error: unknown) => error instanceof MobileUseError && error.code === "CAPTURE_UNAVAILABLE");
  assert.equal(f.calls.some((call) => call.path.endsWith("/screenshot")), false);
  assert.equal(mutations(f).length, 1);
});

test("coordinate taps convert screenshot pixels to points and reject changed/disabled controls without fallback", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  let screen = await f.service.observe(token);
  await f.service.act(token, screen.observation.observationId, { kind: "tap", target: { x: 20, y: 20 } });
  const first = mutations(f)[0]?.body;
  assert.ok(isRecord(first) && Array.isArray(first.actions) && isRecord(first.actions[0]));
  assert.ok(Array.isArray(first.actions[0].actions));
  assert.deepEqual(first.actions[0].actions[0], { type: "pointerMove", origin: "viewport", x: 10, y: 10, duration: 0 });
  screen = await f.service.observe(token);
  f.state.buttonEnabled = false;
  await assert.rejects(f.service.act(token, screen.observation.observationId, {
    kind: "tap", target: { x: 20, y: 20, bounds: { x: 10, y: 10, width: 20, height: 20 } },
  }), (error: unknown) => error instanceof MobileUseError && error.code === "ELEMENT_CHANGED");
  assert.equal(mutations(f).length, 1);
});

test("custom-drawn taps require stable explicit visual bounds and report changed-pixel diagnostics", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const action = { kind: "tap", target: { x: 65, y: 20, bounds: { x: 60, y: 10, width: 10, height: 20 } } };
  let screen = await f.service.observe(token);
  await f.service.act(token, screen.observation.observationId, action);
  screen = await f.service.observe(token);
  f.state.shade++;
  await assert.rejects(f.service.act(token, screen.observation.observationId, action), (error: unknown) =>
    error instanceof MobileUseError && error.code === "STALE_OBSERVATION" && !!error.visualGuard && !error.actionMayHaveRun);
  assert.equal(mutations(f).length, 1);
});

test("a newly overlapping control cannot be ignored by an unchanged tappable reference", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token, undefined, false);
  f.state.overlay = true;
  await assert.rejects(f.service.act(token, screen.observation.observationId, {
    kind: "tap", target: { elementRef: ref(screen, "button") },
  }), (error: unknown) => error instanceof MobileUseError && error.code === "ELEMENT_CHANGED");
  assert.equal(mutations(f).length, 0);
});

test("double-tap/long-press use one bounded W3C sequence and preserve the specified double-tap delay", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  for (const kind of ["double_tap", "long_press"] as const) {
    const screen = await f.service.observe(token, undefined, false);
    await f.service.act(token, screen.observation.observationId, {
      kind, target: { elementRef: ref(screen, "button") }, ...(kind === "double_tap" ? { delayMs: 75 } : {}),
    });
    const body = mutations(f).at(-1)?.body;
    assert.ok(isRecord(body) && Array.isArray(body.actions) && isRecord(body.actions[0]));
    const sequence: unknown = body.actions[0].actions;
    assert.ok(Array.isArray(sequence));
    assert.equal(sequence.filter((item: unknown) => isRecord(item) && item.type === "pointerDown").length, kind === "double_tap" ? 2 : 1);
    assert.ok(sequence.some((item: unknown) => isRecord(item) && item.type === "pause" && item.duration === (kind === "double_tap" ? 75 : 1000)));
  }
  assert.equal(mutations(f).length, 2);
});

test("swipes remain in the verified native surface and preserve W3C movement duration", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  let screen = await f.service.observe(token);
  await f.service.act(token, screen.observation.observationId, { kind: "swipe", elementRef: ref(screen, "table"),
    from: { x: 10, y: 100 }, to: { x: 10, y: 140 }, durationMs: 600 });
  const body = mutations(f)[0]?.body;
  assert.ok(isRecord(body) && Array.isArray(body.actions) && isRecord(body.actions[0]));
  const sequence: unknown = body.actions[0].actions;
  assert.ok(Array.isArray(sequence));
  assert.deepEqual(sequence[2], { type: "pointerMove", origin: "viewport", x: 5, y: 70, duration: 600 });
  screen = await f.service.observe(token);
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "swipe", elementRef: ref(screen, "table"),
    from: { x: 10, y: 100 }, to: { x: 10, y: 20 } }));
  assert.equal(mutations(f).length, 1);
});

test("Unicode input uses only the unchanged focused editor without helper, clear, submit or screenshot", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  let screen = await f.service.observe(token, undefined, false);
  const result = await f.service.act(token, screen.observation.observationId, { kind: "type_text", text: "中文🙂" });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(f.state.value, "safe中文🙂");
  assert.equal(mutations(f).length, 1);
  assert.ok(mutations(f)[0]?.path.endsWith("/element/editor/value"));
  screen = await f.service.observe(token, undefined, false);
  f.state.focusId = "other-editor";
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "type_text", text: "no" }));
  assert.equal(mutations(f).length, 1);
  assert.equal(f.calls.some((call) => /clear|keys|screenshot/.test(call.path)), false);
});

test("secure focus and control-character input are rejected without dispatch", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  let screen = await f.service.observe(token, undefined, false);
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "type_text", text: "submit\n" }),
    (error: unknown) => error instanceof MobileUseError && error.code === "TEXT_INPUT_UNSUPPORTED");
  f.state.focusType = "XCUIElementTypeSecureTextField";
  screen = await f.service.observe(token, undefined, false);
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "type_text", text: "no" }));
  assert.equal(mutations(f).length, 0);
});

test("observations expire and are consumed once even on a rejected target", async (t) => {
  let now = 100;
  const f = await fixture(t, () => now);
  const token = await select(f);
  let screen = await f.service.observe(token, undefined, false);
  now += 30_001;
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "tap", target: { elementRef: ref(screen, "button") } }),
    (error: unknown) => error instanceof MobileUseError && error.code === "STALE_OBSERVATION");
  screen = await f.service.observe(token, undefined, false);
  const action = { kind: "tap", target: { elementRef: "e999" } };
  await assert.rejects(f.service.act(token, screen.observation.observationId, action));
  await assert.rejects(f.service.act(token, screen.observation.observationId, action),
    (error: unknown) => error instanceof MobileUseError && error.code === "STALE_OBSERVATION");
  assert.equal(mutations(f).length, 0);
});

test("App/rotation/window changes block old references and do not dispatch", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  for (const mutate of [() => { f.state.app = "example.other"; }, () => { f.state.rotation = 90; },
    () => { f.state.windowName = "Replacement"; }]) {
    const screen = await f.service.observe(token, undefined, false);
    mutate();
    await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "tap", target: { elementRef: ref(screen, "button") } }));
  }
  assert.equal(mutations(f).length, 0);
});

test("an App change during capture rejects the result rather than delivering mismatched context", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  f.state.sourceHook = () => { f.state.app = "example.other"; };
  await assert.rejects(f.service.observe(token, undefined, false), (error: unknown) =>
    error instanceof MobileUseError && error.code === "STALE_OBSERVATION");
});

test("device identity/session replacement at the same endpoint invalidates targets and never deletes the replacement", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token, undefined, false);
  f.state.uuid = "22222222-2222-4222-8222-222222222222";
  f.state.sessionId = "foreign-session";
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "tap", target: { elementRef: ref(screen, "button") } }),
    (error: unknown) => error instanceof MobileUseError && error.code === "TRANSPORT_LOST");
  await f.service.stop();
  assert.equal(f.state.sessionId, "foreign-session");
  assert.equal(f.calls.some((call) => call.method === "DELETE"), false);
});

test("failed WDA qualification invalidates the target even if the endpoint subsequently recovers", async (t) => {
  for (const scenario of [
    { version: "16.7", code: "DEVICE_UNSUPPORTED" },
    { version: "invalid", code: "WDA_RESPONSE_INVALID" },
  ]) {
    await t.test(scenario.code, async (t) => {
      const f = await fixture(t);
      const token = await select(f);
      const screen = await f.service.observe(token, undefined, false);
      f.state.iosVersion = scenario.version;
      await assert.rejects(f.service.observe(token, undefined, false), (error: unknown) =>
        error instanceof MobileUseError && error.code === scenario.code && !error.actionMayHaveRun);
      f.state.iosVersion = "17.5";
      const calls = f.calls.length;
      await assert.rejects(f.service.act(token, screen.observation.observationId, {
        kind: "tap", target: { elementRef: ref(screen, "button") },
      }), (error: unknown) => error instanceof MobileUseError && error.code === "TRANSPORT_LOST");
      await assert.rejects(f.service.observe(token, undefined, false), (error: unknown) =>
        error instanceof MobileUseError && error.code === "TRANSPORT_LOST");
      await f.service.stop();
      assert.equal(f.calls.length, calls);
      assert.equal(mutations(f).length, 0);
      assert.equal(f.calls.some((call) => call.method === "DELETE"), false);
    });
  }
});

test("lost action responses are uncertain, sanitized and never automatically retried", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token, undefined, false);
  f.state.failAction = true;
  const result = await f.service.act(token, screen.observation.observationId, { kind: "tap", target: { elementRef: ref(screen, "button") } });
  assert.equal(result.dispatchStatus, "outcome-unknown");
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(result.after, null);
  assert.doesNotMatch(JSON.stringify(result), /private-error/);
  assert.equal(mutations(f).length, 1);
});

test("a post-action observation failure preserves dispatched status instead of reporting no input", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token, undefined, false);
  f.state.failAfterAction = true;
  const result = await f.service.act(token, screen.observation.observationId, { kind: "tap", target: { elementRef: ref(screen, "button") } });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(mutations(f).length, 1);
});

test("request cancellation reaches in-flight WDA input without retrying or claiming it was undone", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token, undefined, false);
  const controller = new AbortController();
  f.state.actionHook = async () => { controller.abort(); };
  const result = await f.service.act(token, screen.observation.observationId, { kind: "tap", target: { elementRef: ref(screen, "button") } }, controller.signal);
  assert.equal(result.dispatchStatus, "outcome-unknown");
  assert.equal(result.error?.code, "CANCELLED");
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(mutations(f).length, 1);
});

test("Home works while unsupported capabilities reject explicitly without touching WDA", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  let screen = await f.service.observe(token, undefined, false);
  await f.service.act(token, screen.observation.observationId, { kind: "key", key: "HOME" });
  assert.equal(f.state.app, "com.apple.springboard");
  assert.equal(mutations(f)[0]?.path, "/wda/homescreen");
  const calls = f.calls.length;
  for (const operation of [
    () => f.service.startAdbServer(), () => f.service.wake(token), () => f.service.prepareGestures(token),
    () => f.service.prepareTextInput(token), () => f.service.listApps(token),
    () => f.service.terminateApp(token, "example.demo"), () => f.service.installApp(token, "no.ipa"),
    () => f.service.uninstallApp(token, "example.demo"), () => f.service.screenRecording(token, { kind: "capabilities" }),
  ]) await assert.rejects(operation(), (error: unknown) => error instanceof MobileUseError && error.code === "UNSUPPORTED_OPERATION");
  assert.equal(f.calls.length, calls);
  for (const key of ["BACK", "ENTER"]) {
    screen = await f.service.observe(token, undefined, false);
    await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "key", key }),
      (error: unknown) => error instanceof MobileUseError && error.code === "UNSUPPORTED_OPERATION");
  }
  assert.equal(mutations(f).length, 1);
});

test("App launch/foreground use Bundle IDs without capture and launch invalidates prior observations", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token, undefined, false);
  const calls = f.calls.length;
  assert.deepEqual(await f.service.launchApp(token, "example.target-app"), { platform: "ios", status: "launched", packageName: "example.target-app" });
  assert.deepEqual(await f.service.getForegroundApp(token), { platform: "ios", packageName: "example.target-app", pid: 101 });
  assert.equal(f.calls.slice(calls).some((call) => /source|screenshot/.test(call.path)), false);
  await assert.rejects(f.service.act(token, screen.observation.observationId, { kind: "key", key: "HOME" }),
    (error: unknown) => error instanceof MobileUseError && error.code === "STALE_OBSERVATION");
});

test("iOS hierarchy parsing rejects entities, excessive depth and malformed geometry", async (t) => {
  const f = await fixture(t);
  const parse = (xml: string) => parseIosHierarchy(xml, 2, "example.demo", { width: 80, height: 160 });
  assert.throws(() => parse('<!DOCTYPE AppiumAUT [<!ENTITY x "private">]>' + f.source()));
  assert.throws(() => parse(f.source().replace('width="10"', 'width="NaN"')));
  const wrapping = '<XCUIElementTypeOther x="0" y="0" width="1" height="1" enabled="true" visible="true">';
  const deep = wrapping.repeat(65) + "</XCUIElementTypeOther>".repeat(65);
  assert.throws(() => parse(f.source().replace("</XCUIElementTypeApplication>", deep + "</XCUIElementTypeApplication>")));
});

test("indented WDA XML preserves attributes and reference identity without accepting meaningful tag text", async (t) => {
  const f = await fixture(t);
  f.state.value = "  spaced & text  ";
  f.state.prettySource = false;
  const compact = f.source();
  const parse = (xml: string) => parseIosHierarchy(xml, 2, "example.demo", { width: 80, height: 160 });
  f.state.prettySource = true;
  assert.deepEqual(parse(f.source()), parse(compact));
  assert.equal(parse(f.source()).nodes.find((node) => node.name === "editor")?.element.text, f.state.value);
  assert.throws(() => parse(compact.replace("<AppiumAUT>", "<AppiumAUT>unexpected")));
  assert.throws(() => parse(compact.replace("</XCUIElementTypeWindow>", "unexpected</XCUIElementTypeWindow>")));
  f.state.prettySource = false;
  const token = await select(f);
  const before = await f.service.observe(token, undefined, false);
  f.state.prettySource = true;
  const result = await f.service.act(token, before.observation.observationId, {
    kind: "tap", target: { elementRef: ref(before, "button") },
  });
  assert.equal(result.dispatchStatus, "dispatched");
});

test("partially visible disabled controls cannot fall back to visual taps and keep native geometry", async (t) => {
  const f = await fixture(t);
  f.state.buttonX = -1;
  f.state.buttonEnabled = false;
  const token = await select(f);
  let screen = await f.service.observe(token);
  const action = { kind: "tap", target: { x: 2, y: 20, bounds: { x: 0, y: 10, width: 18, height: 20 } } };
  await assert.rejects(f.service.act(token, screen.observation.observationId, action), (error: unknown) =>
    error instanceof MobileUseError && error.code === "ELEMENT_CHANGED" && !error.actionMayHaveRun);
  assert.equal(mutations(f).length, 0);
  assert.deepEqual(screen.observation.elements.find((node) => node.resourceId === "button")?.bounds,
    { x: -2, y: 10, width: 20, height: 20 });
  f.state.buttonEnabled = true;
  screen = await f.service.observe(token);
  assert.equal((await f.service.act(token, screen.observation.observationId, action)).dispatchStatus, "dispatched");
  assert.equal(mutations(f).length, 1);
});

test("multi-megabyte valid PNG screenshots survive observation and post-action capture", async (t) => {
  const f = await fixture(t);
  const image = png();
  const large = Buffer.concat([
    image.subarray(0, -12),
    chunk("tEXt", Buffer.concat([Buffer.from("fixture\0"), Buffer.alloc(3 * 1024 * 1024, 97)])),
    image.subarray(-12),
  ]);
  f.state.screenshot = large.toString("base64");
  const token = await select(f);
  const screen = await f.service.observe(token);
  assert.deepEqual(screen.image, large);
  const result = await f.service.act(token, screen.observation.observationId, {
    kind: "tap", target: { elementRef: ref(screen, "button") },
  });
  assert.equal(result.dispatchStatus, "dispatched");
  assert.equal(result.verificationStatus, "requires-observation-review");
  assert.deepEqual(result.after?.image, large);
});

test("screenshot Base64 validation rejects invalid length, alphabet and padding", async (t) => {
  const f = await fixture(t);
  await select(f);
  const sessionId = f.state.sessionId;
  assert.ok(sessionId);
  const wda = new WdaClient(f.url);
  for (const value of ["", "AAAAA", "AA=A", "A===", "AA?=", "AAAA\n", "AAA\n", "AAA\r", "AA\r\n"]) {
    f.state.screenshot = value;
    await assert.rejects(wda.screenshot(sessionId), (error: unknown) =>
      error instanceof MobileUseError && error.code === "CAPTURE_UNAVAILABLE");
  }
});

test("HOME verifies the owned session even though its route is sessionless", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  const screen = await f.service.observe(token, undefined, false);
  f.state.actionHook = async () => { f.state.sessionId = "foreign-session"; };
  const result = await f.service.act(token, screen.observation.observationId, { kind: "key", key: "HOME" });
  assert.equal(result.dispatchStatus, "outcome-unknown");
  assert.equal(result.error?.code, "TRANSPORT_LOST");
  assert.equal(result.error?.actionMayHaveRun, true);
  assert.equal(mutations(f)[0]?.path, "/wda/homescreen");
  await f.service.stop();
  assert.equal(f.state.sessionId, "foreign-session");
  assert.equal(f.calls.some((call) => call.method === "DELETE"), false);
});

test("observations distinguish all four interface rotations and reject unsupported axes or angles", async (t) => {
  const f = await fixture(t);
  const token = await select(f);
  for (const angle of [0, 90, 180, 270]) {
    f.state.rotation = angle;
    assert.equal((await f.service.observe(token, undefined, false)).observation.display?.rotation, angle / 90);
  }
  f.state.rotation = 45;
  await assert.rejects(f.service.observe(token, undefined, false), (error: unknown) =>
    error instanceof MobileUseError && error.code === "DISPLAY_STATE_UNAVAILABLE");
  f.state.rotation = 0;
  f.state.rotationX = 90;
  await assert.rejects(f.service.observe(token, undefined, false), (error: unknown) =>
    error instanceof MobileUseError && error.code === "DISPLAY_STATE_UNAVAILABLE");
});

test("opposite portrait and landscape rotations block old refs even with unchanged dimensions and metadata", async (t) => {
  for (const [before, after] of [[0, 180], [90, 270]] as const) {
    await t.test(`${before} to ${after}`, async (t) => {
      const f = await fixture(t);
      const token = await select(f);
      f.state.rotation = before;
      const screen = await f.service.observe(token, undefined, false);
      f.state.rotation = after;
      await assert.rejects(f.service.act(token, screen.observation.observationId, {
        kind: "tap", target: { elementRef: ref(screen, "button") },
      }), (error: unknown) => error instanceof MobileUseError &&
        error.code === "STALE_OBSERVATION" && !error.actionMayHaveRun);
      assert.equal(mutations(f).length, 0);
    });
  }
});
