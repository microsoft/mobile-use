import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseDeviceList } from "../src/adb.js";
import { AndroidBackend, decodePng, parseDisplayState, parseHierarchy, parseKeyguardState, validatePng, validateText } from "../src/android.js";
import { MobileUseError } from "../src/errors.js";
import { actionSchema } from "../src/types.js";
import { chunk, FakeAdb, displayDiagnostics, editField, hasCode, hierarchy, keyguardPolicy, node, pixelPng, png, textHash, USB, WIFI } from "./helpers.js";

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
    Buffer.concat([valid.subarray(0, 33), chunk("tRNS", Buffer.alloc(6)), valid.subarray(33)]),
  ]) assert.throws(() => validatePng(invalid), hasCode("INVALID_IMAGE"));
  assert.throws(() => validatePng(Buffer.alloc(5 * 1024 * 1024 + 1)), hasCode("CAPTURE_UNAVAILABLE"));
});

test("pixel decoding reverses every supported PNG row filter, including byte wrapping", () => {
  const expected = [
    [8, 8, 8, 8],
    [8, 16, 8, 16],
    [8, 8, 16, 16],
    [8, 12, 12, 20],
    [8, 16, 16, 24],
  ];
  for (const filter of [0, 1, 2, 3, 4]) {
    const decoded = decodePng(png(2, 2, 8, filter));
    assert.equal(decoded.channels, 4);
    assert.deepEqual([...decoded.pixels], expected[filter]?.flatMap((value) => [value, value, value, value]));
  }
  assert.deepEqual([...decodePng(png(2, 1, 200, 1)).pixels], [200, 200, 200, 200, 144, 144, 144, 144]);
  const rgb = decodePng(pixelPng(2, 1, (x) => [10 + x, 20 + x, 30 + x, 255], 3));
  assert.equal(rgb.channels, 3);
  assert.deepEqual([...rgb.pixels], [10, 20, 30, 11, 21, 31]);
  assert.throws(() => decodePng(png(2, 2, 8, 5)), hasCode("INVALID_IMAGE"));
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

test("scrollability is exposed without inventing actionability for generic containers", () => {
  const parsed = parseHierarchy(hierarchy(node({
    class: "android.widget.ScrollView", text: "", "resource-id": "", clickable: "false", scrollable: "true",
  })));
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0]?.scrollable, true);
  assert.equal(parsed.elements[0]?.clickable, false);
  assert.equal(parseHierarchy(hierarchy()).elements[0]?.scrollable, null);
  assert.throws(() => parseHierarchy(hierarchy(node({ scrollable: "yes" }))), hasCode("HIERARCHY_UNAVAILABLE"));
});

test("hierarchy field text and labels preserve exact whitespace for Unicode append guards", () => {
  for (const text of ["  abc  ", " \t ", "\r\n中文\t😀\n", "e\u0301", "中文 😀", "literal &#10; &copy; &quot;"]) {
    const field = parseHierarchy(hierarchy(editField({ text, "content-desc": "  label  " }))).elements[0];
    assert.equal(field?.text, text);
    assert.equal(field?.label, "  label  ");
  }
});

test("XML numeric references roundtrip line breaks, combining marks, and supplementary characters exactly once", () => {
  const xml = hierarchy(editField()).replace('text=""',
    'text="&#10;中文&#x9;日本語&#13;&#10;한국어 | العربية | Русский | e&#x301; | &#x1F600; &#128105;‍&#x1F4BB; | &amp;#10;"');
  assert.equal(parseHierarchy(xml).elements[0]?.text,
    "\n中文\t日本語\r\n한국어 | العربية | Русский | e\u0301 | 😀 👩‍💻 | &#10;");
});

test("prepared hierarchies expose validated non-password raw-text fingerprints", () => {
  const hash = textHash("中文😀");
  assert.equal(parseHierarchy(hierarchy(editField({ text: "中文😀", "text-sha256": hash }))).elements[0]?.textHash, hash);
  assert.equal(parseHierarchy(hierarchy(editField({ password: "true", "text-sha256": hash }))).elements[0]?.textHash, undefined);
  for (const invalid of ["", "a".repeat(63), "A".repeat(64), "a".repeat(65), "private-content"]) {
    assert.throws(() => parseHierarchy(hierarchy(editField({ "text-sha256": invalid }))), hasCode("HIERARCHY_UNAVAILABLE"));
  }
});

test("prepared hierarchies preserve stable window identities and reject unknown or invalid identities", () => {
  for (const windowIdentity of ["0:u0", "abc:u1", "ffffffff:u2147483647"]) {
    assert.equal(parseHierarchy(hierarchy(editField({ "window-identity": windowIdentity }))).elements[0]?.windowIdentity, windowIdentity);
  }
  assert.equal(parseHierarchy(hierarchy(editField())).elements[0]?.windowIdentity, undefined);
  for (const invalid of ["", "abc", "ABC:u0", "abc:u01", "abc:u-1", "abc:u2147483648", "abcdefabc:u0", "unknown"]) {
    assert.throws(() => parseHierarchy(hierarchy(editField({ "window-identity": invalid }))), hasCode("HIERARCHY_UNAVAILABLE"));
  }
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

test("Unicode text validation preserves multilingual data and rejects malformed or unsafe controls", () => {
  validateText("ABC xyz 0123.,_-");
  validateText("a".repeat(256));
  for (const value of ["é", "中文", "line\nbreak", "tab\t", "quote'", "$HOME", "%s", "&", ";", "\\", "😀", "日本語", "한국어", "العربية", "русский", "e\u0301", "👩‍💻"]) validateText(value);
  for (const value of ["", "a".repeat(257), "\u0000", "\u001b", "\u007f", "\u0085", "\ud800", "\udc00", "\ufffe", "\uffff"]) {
    assert.throws(() => validateText(value), hasCode("UNSUPPORTED_TEXT"));
  }
  for (let code = 0; code < 128; code++) {
    const character = String.fromCharCode(code);
    if (code >= 32 && code !== 127 || [9, 10, 13].includes(code)) validateText(character);
    else assert.throws(() => validateText(character), hasCode("UNSUPPORTED_TEXT"));
  }
  validateText("😀".repeat(128));
  assert.throws(() => validateText("😀".repeat(129)), hasCode("UNSUPPORTED_TEXT"));
});

test("the bounded action union rejects unsupported operations and target shapes", () => {
  assert.equal(actionSchema.parse({ kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }).kind, "swipe");
  for (const target of [{ elementRef: "e1" }, { x: 0, y: 20 }]) {
    assert.deepEqual(actionSchema.parse({ kind: "tap", target }), { kind: "tap", target });
    assert.deepEqual(actionSchema.parse({ kind: "long_press", target }), { kind: "long_press", target });
    assert.equal(actionSchema.safeParse({ kind: "long_press", target, durationMs: 500 }).success, false);
    assert.deepEqual(actionSchema.parse({ kind: "double_tap", target }), { kind: "double_tap", target, delayMs: 50 });
    for (const delayMs of [0, 1, 50, 250]) {
      assert.deepEqual(actionSchema.parse({ kind: "double_tap", target, delayMs }), { kind: "double_tap", target, delayMs });
    }
    for (const delayMs of [-1, 251, 1.5, "50", "0;reboot", null, NaN, Infinity]) {
      assert.equal(actionSchema.safeParse({ kind: "double_tap", target, delayMs }).success, false);
    }
  }
  for (const value of [
    { kind: "shell", command: "reboot" },
    { kind: "key", key: "POWER" },
    { kind: "tap", target: { x: 1, y: 1, elementRef: "e1" } },
    { kind: "tap", target: { x: -1, y: 0 } },
    { kind: "tap", target: { x: 1.5, y: 0 } },
    { kind: "long_press", target: { x: 1, y: 1, elementRef: "e1" } },
    { kind: "long_press", target: { x: -1, y: 0 } },
    { kind: "long_press", target: { x: 1.5, y: 0 } },
    { kind: "double_tap", target: { x: 1, y: 1, elementRef: "e1" } },
    { kind: "double_tap", target: { x: -1, y: 0 } },
    { kind: "double_tap", target: { x: 1.5, y: 0 } },
    { kind: "double_tap", target: { x: "1;reboot", y: 0 } },
    { kind: "double_tap", target: { elementRef: "e0" } },
    { kind: "double_tap", target: { x: 1, y: 1 }, count: 3 },
    { kind: "launch_app", packageName: "example.app;reboot" },
    { kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 2001 },
    { kind: "tap", target: { x: 1, y: 1, bounds: { x: 0, y: 0, width: 0, height: 10 } } },
    { kind: "tap", target: { x: 1, y: 1, bounds: { x: -1, y: 0, width: 10, height: 10 } } },
    { kind: "tap", target: { elementRef: "e1", bounds: { x: 0, y: 0, width: 10, height: 10 } } },
    { kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, elementRef: "e0" },
  ]) assert.equal(actionSchema.safeParse(value).success, false);
  const bounds = { x: 0, y: 0, width: 40, height: 20 };
  for (const kind of ["tap", "long_press", "double_tap"]) {
    assert.equal(actionSchema.safeParse({ kind, target: { x: 10, y: 10, bounds } }).success, true);
  }
  assert.equal(actionSchema.safeParse({ kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, bounds }).success, true);
  assert.equal(actionSchema.safeParse({ kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, elementRef: "e1" }).success, true);
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

test("primary logical display geometry is read independently for all rotations", () => {
  for (const rotation of [0, 1, 2, 3]) {
    const width = rotation % 2 ? 160 : 80;
    const height = rotation % 2 ? 80 : 160;
    const output = displayDiagnostics(rotation, width, height);
    assert.deepEqual(parseDisplayState(output), { width, height, rotation });
    assert.deepEqual(parseDisplayState(output.replace(`mRotation=${rotation}`, `mRotation=ROTATION_${rotation * 90}`)), { width, height, rotation });
  }
  assert.equal(parseDisplayState(displayDiagnostics().replaceAll("\n", "\r\n")).rotation, 0);
  const secondary = displayDiagnostics(3, 160, 80).replace("mDisplayId=0", "mDisplayId=7");
  const multiple = secondary + displayDiagnostics() + secondary;
  assert.deepEqual(parseDisplayState(multiple), { width: 80, height: 160, rotation: 0 });
  const offset = displayDiagnostics().replace("  unrelated=true", "  InputViewport\n    orientation=1\n  unrelated=true");
  assert.equal(parseDisplayState(offset).rotation, 0, "physical panel orientation must not be mistaken for logical UI rotation");
});

test("missing, ambiguous, oversized, and unrecognized primary display diagnostics fail closed", () => {
  const valid = displayDiagnostics();
  for (const invalid of [
    "", "Permission Denial", " ".repeat(1024 * 1024 + 1),
    valid.replace("mRotation=0", "mRotation=4"),
    valid.replace("mRotation=0", "mRotation=unknown"),
    valid.replace("mRotation=0", "mRotation=ROTATION_45"),
    valid.replace("mRotation=0", "mRotation=0 mRotation=0"),
    valid.replace("mRotation=0", "unrecognized=0"),
    valid.replace("mDisplayId=0", "mDisplayId=1"),
    valid.replace("cur=80x160", "cur=0x160"),
    valid.replace("cur=80x160", "cur=8193x160"),
    valid.replace("cur=80x160", "cur=80x9007199254740992"),
    valid.replace("cur=80x160", "cur=80x160 cur=80x160"),
    valid.replace("cur=80x160", "unrecognized=80x160"),
    valid.replace("  DisplayRotation\n", ""),
    valid.replace("  unrelated=true", "  DisplayRotation\n    mRotation=0"),
    valid + valid,
  ]) assert.throws(() => parseDisplayState(invalid), hasCode("DISPLAY_STATE_UNAVAILABLE"));
});

test("display reads retry transient failures once without hierarchy, settings, or input commands", async () => {
  for (const failure of ["ADB_FAILED", "ADB_TIMEOUT", "malformed"] as const) {
    const adb = new FakeAdb();
    let attempts = 0;
    adb.handler = () => {
      if (++attempts !== 1) return undefined;
      if (failure === "malformed") return Buffer.from("Unrecognized display diagnostics");
      throw new MobileUseError(failure, "Fixture read failed.", "Observe again.");
    };
    assert.deepEqual(await backend(adb).displayState(), { width: 80, height: 160, rotation: 0 });
    assert.equal(attempts, 2);
    assert.ok(adb.calls.every((call) => call.args.join(" ") === "-t 7 shell dumpsys window displays" && !call.options.mutating));
    assert.equal(adb.inputs.length, 0);
  }
});

test("display reads have a two-second attempt deadline and a finite retry budget", { timeout: 6000 }, async () => {
  const adb = new FakeAdb();
  let attempts = 0;
  let expiredAt = 0;
  const startedAt = performance.now();
  adb.handler = async (call) => {
    if (++attempts === 1) {
      const signal = call.options.signal;
      assert.ok(signal);
      return new Promise<Buffer>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          expiredAt = performance.now();
          reject(new MobileUseError("CANCELLED", "Fixture attempt deadline.", "Observe again."));
        }, { once: true });
      });
    }
    return undefined;
  };
  const read = backend(adb).displayState();
  await delay(2100);
  assert.equal((await read).rotation, 0);
  assert.ok(expiredAt - startedAt >= 1900 && expiredAt - startedAt < 4500);
  assert.equal(attempts, 2);
  adb.display = "";
  adb.handler = undefined;
  const before = adb.calls.length;
  await assert.rejects(backend(adb).displayState(), (error: unknown) => {
    hasCode("DISPLAY_STATE_UNAVAILABLE")(error);
    assert.ok(error instanceof MobileUseError && !error.actionMayHaveRun);
    return true;
  });
  assert.equal(adb.calls.length - before, 2);
  assert.equal(adb.inputs.length, 0);
});

test("display reads preserve transport, configuration, internal, and cancellation errors without retry", async () => {
  for (const code of ["TRANSPORT_LOST", "DEVICE_UNAUTHORIZED", "ADB_NOT_FOUND", "ADB_CONFIG_UNSUPPORTED", "INTERNAL_ERROR", "CANCELLED"] as const) {
    const adb = new FakeAdb();
    adb.handler = () => { throw new MobileUseError(code, "Fixture failure.", "Stop."); };
    await assert.rejects(backend(adb).displayState(), hasCode(code));
    assert.equal(adb.calls.length, 1);
  }
  const adb = new FakeAdb();
  const controller = new AbortController();
  adb.handler = () => {
    controller.abort();
    throw new MobileUseError("ADB_FAILED", "Fixture interrupted.", "Stop.");
  };
  await assert.rejects(backend(adb).displayState(controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, 1);
  await assert.rejects(backend(adb).displayState(controller.signal), hasCode("CANCELLED"));
  assert.equal(adb.calls.length, 1, "an already cancelled read must not dispatch");
});

test("keyguard diagnostics distinguish unsecured, secure, and SIM-locked states", () => {
  assert.deepEqual(parseKeyguardState(keyguardPolicy()), {
    showing: false, secure: false, inputRestricted: false, screenOn: true, userId: 0,
  });
  assert.equal(parseKeyguardState(keyguardPolicy({ secure: "true" })).secure, true);
  assert.equal(parseKeyguardState(keyguardPolicy({ mSimSecure: "true" })).secure, true);
  assert.equal(parseKeyguardState(keyguardPolicy({ screenState: "SCREEN_STATE_OFF" })).screenOn, false);
  assert.equal(parseKeyguardState(keyguardPolicy({ currentUser: "10", mCurrentUserId: "10" })).userId, 10);
  assert.deepEqual(parseKeyguardState(keyguardPolicy({
    showing: "true", inputRestricted: "false", currentUser: "-10000",
    mIsShowing: "true", mInputRestricted: "true", mCurrentUserId: "0",
    screenState: "SCREEN_STATE_OFF",
  })), { showing: true, secure: false, inputRestricted: true, screenOn: false, userId: 0 });
});

test("unknown, oversized, contradictory, and ambiguous keyguard diagnostics fail closed", () => {
  for (const output of [
    "", "Permission Denial", " ".repeat(128 * 1024 + 1),
    keyguardPolicy().replace("secure=false", "secure=unknown"),
    keyguardPolicy().replace("    secure=false\n", ""),
    keyguardPolicy().replace("      mSimSecure=false\n", ""),
    keyguardPolicy() + keyguardPolicy(),
    keyguardPolicy().replace("    secure=false", "    secure=false\n    secure=true"),
    keyguardPolicy({ mIsShowing: "unknown" }), keyguardPolicy({ mInputRestricted: "unknown" }),
    keyguardPolicy().replace("    mCurrentUserId=0", "    mCurrentUserId=10"),
    keyguardPolicy({ currentUser: "10" }), keyguardPolicy({ currentUser: "-1", mCurrentUserId: "-1" }),
    keyguardPolicy({ bootCompleted: "false" }), keyguardPolicy({ systemIsReady: "false" }),
    keyguardPolicy({ screenState: "OEM_UNKNOWN" }),
    "  secure=false\n" + keyguardPolicy().replace("    secure=false\n", ""),
  ]) assert.throws(() => parseKeyguardState(output), hasCode("KEYGUARD_STATE_UNAVAILABLE"));
});

test("wake uses a fixed non-toggle key and dismisses only an unsecured keyguard on the exact transport", async () => {
  const adb = new FakeAdb();
  Object.assign(adb.keyguard, { showing: true, inputRestricted: true, screenState: "SCREEN_STATE_OFF" });
  assert.deepEqual(await backend(adb).wake(), { status: "awake-and-unlocked", keyguardDismissed: true });
  assert.deepEqual(adb.inputs.map((call) => call.args), [
    ["-t", "7", "shell", "input", "keyevent", "224"],
    ["-t", "7", "shell", "wm", "dismiss-keyguard"],
  ]);
  assert.ok(adb.calls.every((call) => call.args[0] === "-t" && call.args[1] === "7"));
  assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator")), false);
});

test("an already unlocked phone is woken without dismissing keyguard or changing security", async () => {
  const adb = new FakeAdb();
  adb.keyguard.secure = true;
  assert.deepEqual(await backend(adb).wake(), { status: "awake-and-unlocked", keyguardDismissed: false });
  assert.equal(adb.inputs.length, 1);
  assert.deepEqual(adb.inputs[0]?.args.slice(-2), ["keyevent", "224"]);
});

test("secure credentials and SIM locks require manual unlock without dismissal or capture", async () => {
  for (const security of [{ secure: true }, { simSecure: true }]) {
    const adb = new FakeAdb();
    Object.assign(adb.keyguard, { showing: true, inputRestricted: true, ...security });
    await assert.rejects(backend(adb).wake(), (error: unknown) => {
      hasCode("MANUAL_UNLOCK_REQUIRED")(error);
      assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
      return true;
    });
    assert.deepEqual(adb.inputs.map((call) => call.args.slice(2)), [["shell", "input", "keyevent", "224"]]);
    assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("uiautomator")), false);
  }
});

test("unrecognized lock states and dismissal errors are explicit and never replayed", async () => {
  for (const scenario of ["unknown-state", "rejected-dismissal"]) {
    const adb = new FakeAdb();
    Object.assign(adb.keyguard, { showing: true, inputRestricted: true });
    adb.handler = (call) => {
      if (scenario === "unknown-state" && call.args.includes("dumpsys")) return Buffer.from("unrecognized OEM output");
      if (scenario === "rejected-dismissal" && call.args.includes("dismiss-keyguard")) return Buffer.from("Error: private platform details");
      return undefined;
    };
    await assert.rejects(backend(adb).wake(), (error: unknown) => {
      hasCode(scenario === "unknown-state" ? "KEYGUARD_STATE_UNAVAILABLE" : "WAKE_FAILED")(error);
      assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
      assert.doesNotMatch(error.message, /private platform details/);
      return true;
    });
    assert.equal(adb.inputs.filter((call) => call.args.includes("dismiss-keyguard")).length, scenario === "unknown-state" ? 0 : 1);
  }
});

test("wake verifies dismissal instead of trusting the command's zero exit status", async () => {
  const adb = new FakeAdb();
  Object.assign(adb.keyguard, { showing: true, inputRestricted: true });
  adb.handler = (call) => call.args.includes("dismiss-keyguard") ? Buffer.alloc(0) : undefined;
  await assert.rejects(backend(adb).wake(), hasCode("WAKE_FAILED"));
  assert.equal(adb.inputs.filter((call) => call.args.includes("dismiss-keyguard")).length, 1);
  assert.equal(adb.calls.filter((call) => call.args.includes("dumpsys")).length, 10);
});

test("wake waits for screen readiness and refuses a user or security change during verification", async () => {
  const waiting = new FakeAdb();
  let reads = 0;
  waiting.handler = (call) => {
    if (call.args.includes("dumpsys") && reads++ === 0) {
      return Buffer.from(keyguardPolicy({ screenState: "SCREEN_STATE_TURNING_ON" }));
    }
    return undefined;
  };
  assert.equal((await backend(waiting).wake()).status, "awake-and-unlocked");
  assert.equal(reads, 2);
  for (const change of [{ userId: 10 }, { showing: true, secure: true, inputRestricted: true }]) {
    const adb = new FakeAdb();
    Object.assign(adb.keyguard, { showing: true, inputRestricted: true });
    adb.handler = (call) => {
      if (call.args.includes("dismiss-keyguard")) {
        Object.assign(adb.keyguard, change);
        return Buffer.alloc(0);
      }
      return undefined;
    };
    await assert.rejects(backend(adb).wake(), hasCode("userId" in change ? "WAKE_FAILED" : "MANUAL_UNLOCK_REQUIRED"));
    assert.equal(adb.inputs.filter((call) => call.args.includes("dismiss-keyguard")).length, 1);
  }
});

test("wake cancellation is reported as uncertain after waking and never dismisses again", async () => {
  const adb = new FakeAdb();
  const controller = new AbortController();
  Object.assign(adb.keyguard, { showing: true, inputRestricted: true });
  adb.handler = (call) => {
    if (call.args.includes("dismiss-keyguard")) {
      setTimeout(() => controller.abort(), 10);
      return Buffer.alloc(0);
    }
    return undefined;
  };
  await assert.rejects(backend(adb).wake(controller.signal), (error: unknown) => {
    hasCode("CANCELLED")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
  assert.equal(adb.inputs.length, 2);
});

test("an interrupted wake dispatch preserves its uncertain-delivery flag", async () => {
  const adb = new FakeAdb();
  const controller = new AbortController();
  adb.handler = (call) => {
    if (call.options.mutating) {
      controller.abort();
      throw new MobileUseError("CANCELLED", "Delivery is uncertain.", "Check the phone.", false, true);
    }
    return undefined;
  };
  await assert.rejects(backend(adb).wake(controller.signal), (error: unknown) => {
    hasCode("CANCELLED")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
  assert.equal(adb.calls.length, 1);
});

test("hierarchy capture forces a remote terminal while PNG capture remains binary-safe raw output", async () => {
  const adb = new FakeAdb();
  adb.xml = hierarchy().replaceAll("\n", "\r\n");
  const android = backend(adb);
  assert.equal((await android.hierarchy()).elements[0]?.text, "Demo");
  const capture = await android.screenshot();
  assert.deepEqual(capture.image, adb.image);
  assert.deepEqual(adb.calls.map((call) => call.args), [
    ["-t", "7", "shell", "-tt", "uiautomator", "dump", "--windows", "/dev/tty"],
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
  await assert.rejects(backend(adb).typeText("\ud800"), hasCode("UNSUPPORTED_TEXT"));
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

test("double-tap dispatch uses one prepared Android process on the exact transport", async () => {
  const adb = new FakeAdb();
  const controller = new AbortController();
  const android = backend(adb, WIFI);
  const prepared = await android.prepareGestures();
  for (const delayMs of [0, 1, 50, 250]) {
    assert.equal(await android.doubleTap(10, 20, delayMs, controller.signal), delayMs);
    assert.deepEqual(adb.inputs.at(-1)?.args, [
      "-t", "12", "shell", `CLASSPATH=${prepared.remotePath}`, "app_process", "/",
      "dev.mobileuse.gestures.GestureMain", "10", "20", String(delayMs),
    ]);
  }
  assert.equal(adb.inputs.length, 4);
  assert.equal(adb.calls.filter((call) => call.args[2] === "push").length, 1);
  assert.equal(adb.inputs[0]?.options.signal?.aborted, false);
  controller.abort();
  assert.equal(adb.inputs[0]?.options.signal?.aborted, true);
});

test("double-tap never deploys implicitly and rejects changed or missing helper bytes before input", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await assert.rejects(android.doubleTap(10, 20, 50), hasCode("GESTURE_HELPER_NOT_PREPARED"));
  assert.equal(adb.calls.length, 0);
  const prepared = await android.prepareGestures();
  adb.gestureFiles.set(prepared.remotePath, Buffer.from("changed"));
  await assert.rejects(android.doubleTap(10, 20, 50), hasCode("GESTURE_HELPER_UNAVAILABLE"));
  adb.gestureFiles.delete(prepared.remotePath);
  await assert.rejects(android.doubleTap(10, 20, 50), hasCode("ADB_FAILED"));
  assert.equal(adb.inputs.length, 0);
});

test("helper compatibility failures leave double-tap unprepared and never inject input", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  adb.handler = (call) => call.args.at(-1) === "--check" ? Buffer.from("incompatible\n") : undefined;
  await assert.rejects(android.prepareGestures(), (error: unknown) => {
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return hasCode("GESTURE_HELPER_UNAVAILABLE")(error);
  });
  await assert.rejects(android.doubleTap(10, 20, 50), hasCode("GESTURE_HELPER_NOT_PREPARED"));
  assert.equal(adb.inputs.length, 0);
});

test("invalid helper acknowledgements are uncertain and are never retried", async () => {
  const adb = new FakeAdb();
  const android = backend(adb);
  await android.prepareGestures();
  for (const output of ["", "MOBILE_USE_DOUBLE_TAP_V1 301\n", "MOBILE_USE_DOUBLE_TAP_V1 -1\n", "noise\nMOBILE_USE_DOUBLE_TAP_V1 50\n"]) {
    adb.handler = (call) => call.args[4] === "app_process" ? Buffer.from(output) : undefined;
    await assert.rejects(android.doubleTap(10, 20, 50), (error: unknown) => {
      assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
      return hasCode("GESTURE_HELPER_UNAVAILABLE")(error);
    });
  }
  assert.equal(adb.inputs.length, 4);
});

test("app launch is limited to one resolved installed launcher and confirms only dispatch", async () => {
  const adb = new FakeAdb();
  await backend(adb).launchApp("example.poc");
  assert.deepEqual(adb.inputs[0]?.args, ["-t", "7", "shell", "am", "start", "-W", "--user", "0", "-n", "'example.poc/.MainActivity'"]);
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
