import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "mobile-use-text-java-test-"));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  "android/os/SystemClock.java": `
    package android.os;
    public final class SystemClock {
      public static long now = 0;
      public static long uptimeMillis() { return now; }
      public static void sleep(long duration) {
        now += duration;
        if (Boolean.getBoolean("traceRoot")) System.err.println("ROOT_SLEEP " + duration);
      }
    }`,
  "dev/mobileuse/text/TextFixture.java": `
    package dev.mobileuse.text;
    public final class TextFixture {
      public static void main(String[] args) {
        if (args.length == 1 && "--oversized".equals(args[0])) {
          args[0] = new String(new char[32769]).replace('\\0', 'A');
        }
        final int[] reads={0};
        TextMain.run(args, () -> {
          if (Boolean.getBoolean("forbidRead")) throw new IllegalStateException("Check must not read windows");
          reads[0]++;
          if (Boolean.getBoolean("windowReadFailed")) throw new java.io.IOException("Private window diagnostic");
          if (Boolean.getBoolean("oversizedWindowDiagnostics")) return new String(new char[1024 * 1024 + 1]);
          String provided=System.getProperty("windowDiagnostics");
          if (provided != null) return new String(java.util.Base64.getDecoder().decode(provided), java.nio.charset.StandardCharsets.UTF_8);
          String identity=reads[0] >= Integer.getInteger("windowChangeRead", Integer.MAX_VALUE)
            ? System.getProperty("changedWindowIdentity", "def") : System.getProperty("windowIdentity", "abc");
          return "WINDOW MANAGER DISPLAY CONTENTS\\n  Display: mDisplayId=0 stacks=1\\n" +
            "  mCurrentFocus=Window{" + identity + " u0 example.poc/.MainActivity}\\n" +
            "  Display: mDisplayId=2 stacks=1\\n  mCurrentFocus=Window{fff u10 other.app/.Activity}\\n";
        });
      }
    }`,
  "android/os/Looper.java": `package android.os; public class Looper {}`,
  "android/os/HandlerThread.java": `
    package android.os;
    public class HandlerThread {
      public HandlerThread(String name) {}
      public void start() {}
      public Looper getLooper() { return new Looper(); }
      public boolean quitSafely() { System.err.println("THREAD_CLOSED"); return true; }
    }`,
  "android/os/Bundle.java": `
    package android.os;
    public class Bundle {
      public CharSequence text;
      public void putCharSequence(String key, CharSequence value) {
        if (!key.equals("ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE")) throw new IllegalArgumentException();
        text = value;
      }
    }`,
  "android/util/Base64.java": `
    package android.util;
    public class Base64 {
      public static final int NO_WRAP = 2;
      public static byte[] decode(String text, int flags) { return java.util.Base64.getDecoder().decode(text); }
    }`,
  "android/graphics/Rect.java": `
    package android.graphics;
    public class Rect {
      public int left, top, right, bottom;
      public Rect() {}
      public Rect(int l, int t, int r, int b) { left=l; top=t; right=r; bottom=b; }
      public boolean equals(Object other) {
        if (!(other instanceof Rect)) return false;
        Rect v=(Rect)other;
        return left==v.left && top==v.top && right==v.right && bottom==v.bottom;
      }
    }`,
  "android/accessibilityservice/AccessibilityServiceInfo.java": `
    package android.accessibilityservice;
    public class AccessibilityServiceInfo {
      public static final int FLAG_REPORT_VIEW_IDS=16, FLAG_RETRIEVE_INTERACTIVE_WINDOWS=64;
      public int flags=1;
    }`,
  "android/app/ActivityManager.java": `
    package android.app;
    public class ActivityManager {
      public static int getCurrentUser() { return Integer.getInteger("user", 0); }
    }`,
  "android/app/IUiAutomationConnection.java": `package android.app; public interface IUiAutomationConnection {}`,
  "android/app/UiAutomationConnection.java": `
    package android.app; public class UiAutomationConnection implements IUiAutomationConnection {}`,
  "android/app/UiAutomation.java": `
    package android.app;
    import android.os.Looper;
    import android.accessibilityservice.AccessibilityServiceInfo;
    import android.view.accessibility.AccessibilityNodeInfo;
    public class UiAutomation {
      public static final int FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES=1;
      AccessibilityServiceInfo info = new AccessibilityServiceInfo();
      int rootReads=0;
      public UiAutomation(Looper looper, IUiAutomationConnection connection) {}
      public void connect(int flags) {
        if (flags != FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES) throw new IllegalArgumentException("Must not suppress accessibility services");
      }
      public void disconnect() { System.err.println("DISCONNECTED"); }
      public AccessibilityServiceInfo getServiceInfo() { return info; }
      public void setServiceInfo(AccessibilityServiceInfo value) {
        if (value.flags != 81) throw new IllegalArgumentException("Service flags were not preserved");
      }
      public AccessibilityNodeInfo getRootInActiveWindow() {
        if (Boolean.getBoolean("forbidRead")) throw new IllegalStateException("Check must not read UI");
        rootReads++;
        if (Boolean.getBoolean("traceRoot")) System.err.println("ROOT_READ " + rootReads);
        android.os.SystemClock.now += Integer.getInteger("rootCallMs", 0);
        return Boolean.getBoolean("noRoot") || rootReads <= Integer.getInteger("rootUnavailableReads", 0)
          ? null : new AccessibilityNodeInfo(false);
      }
    }`,
  "android/view/accessibility/AccessibilityWindowInfo.java": `
    package android.view.accessibility;
    public class AccessibilityWindowInfo {
      public static final int TYPE_APPLICATION=1;
      public int getDisplayId() { return Integer.getInteger("display", 0); }
      public int getType() { return Integer.getInteger("windowType", 1); }
      public boolean isActive() { return !Boolean.getBoolean("inactive"); }
      public boolean isFocused() { return !Boolean.getBoolean("windowUnfocused"); }
      public void recycle() {}
    }`,
  "android/view/accessibility/AccessibilityNodeInfo.java": `
    package android.view.accessibility;
    import android.os.Bundle;
    import android.graphics.Rect;
    import java.nio.charset.StandardCharsets;
    import java.util.*;
    public class AccessibilityNodeInfo {
      public static final int ACTION_SET_TEXT=2097152;
      public static final String ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE="ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE";
      public static class AccessibilityAction {
        public static final AccessibilityAction ACTION_SET_TEXT=new AccessibilityAction();
      }
      final boolean field;
      final int depth;
      boolean written=false;
      boolean refreshed=false;
      String value;
      public AccessibilityNodeInfo(boolean field) {
        this(field, 1);
      }
      public AccessibilityNodeInfo(boolean field, int depth) {
        this.field=field;
        this.depth=depth;
        value=new String(Base64.getDecoder().decode(System.getProperty("cachedPrevious", System.getProperty("previous", ""))), StandardCharsets.UTF_8);
      }
      public CharSequence getText() { return value; }
      public CharSequence getHintText() { return System.getProperty("hintValue", Boolean.getBoolean("hint") ? "Search" : ""); }
      public CharSequence getContentDescription() { return System.getProperty("label", ""); }
      public boolean isShowingHintText() {
        return written ? Boolean.getBoolean("filterToHint") : Boolean.getBoolean("hint");
      }
      public CharSequence getPackageName() {
        return System.getProperty(written ? "afterPackageName" : "packageName", "example.poc");
      }
      public CharSequence getClassName() {
        return field ? System.getProperty(written ? "afterClassName" : "className", "android.widget.EditText") : "android.view.View";
      }
      public String getViewIdResourceName() {
        return System.getProperty(written ? "afterResourceId" : "resourceId", "example.poc:id/text");
      }
      public boolean isEditable() { return field && !Boolean.getBoolean("notEditable"); }
      public boolean isVisibleToUser() { return !Boolean.getBoolean("invisible"); }
      public boolean isFocused() { return field && !Boolean.getBoolean("unfocused") && !(written && Boolean.getBoolean("afterLostFocus")); }
      public boolean isEnabled() { return !Boolean.getBoolean("disabled"); }
      public boolean isClickable() { return field; }
      public boolean isPassword() { return Boolean.getBoolean("password"); }
      public void getBoundsInScreen(Rect b) {
        b.left=Integer.getInteger("x",4); b.top=32; b.right=76;
        b.bottom=written ? Integer.getInteger("afterBottom", 56) : 56;
      }
      public int getChildCount() {
        if (Boolean.getBoolean("deep")) return depth < Integer.getInteger("depthLimit", 65) ? 1 : 0;
        return field ? 0 : Integer.getInteger("childCount", Boolean.getBoolean("ambiguous") ? 2 : 1);
      }
      public AccessibilityNodeInfo getChild(int index) { return new AccessibilityNodeInfo(true, depth+1); }
      public AccessibilityWindowInfo getWindow() { return Boolean.getBoolean("noWindow") ? null : new AccessibilityWindowInfo(); }
      public int getWindowId() {
        int id=Integer.getInteger("windowId", 1);
        if (written) return Integer.getInteger("afterWindowId", id);
        return field && refreshed ? Integer.getInteger("refreshedWindowId", id) : id;
      }
      public boolean refresh() {
        refreshed=true;
        if (!written) value=new String(Base64.getDecoder().decode(System.getProperty("previous", "")), StandardCharsets.UTF_8);
        return !Boolean.getBoolean("refreshFailed") && !(written && Boolean.getBoolean("afterRefreshFailed"));
      }
      public List<AccessibilityAction> getActionList() {
        return Boolean.getBoolean("unsupported") ? Collections.emptyList() : Arrays.asList(AccessibilityAction.ACTION_SET_TEXT);
      }
      public boolean performAction(int action, Bundle args) {
        if (action != ACTION_SET_TEXT || Boolean.getBoolean("forbidWrite")) throw new IllegalStateException("Unexpected write");
        written=true;
        value=args.text.toString();
        System.err.println("WRITE " + Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
        if (Boolean.getBoolean("filter")) value="filtered";
        if (Boolean.getBoolean("filterToHint")) value=getHintText().toString();
        if (Boolean.getBoolean("throwAfterWrite")) throw new IllegalStateException("Fixture failure");
        return !Boolean.getBoolean("reject");
      }
      public void recycle() {}
    }`,
};
for (const [file, text] of Object.entries(stubs)) {
  const destination = path.join(directory, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text);
}
const classes = path.join(directory, "classes");
await mkdir(classes);
const compiled = spawnSync("javac", [
  "--release", "8", "-Xlint:-options", "-d", classes,
  ...Object.keys(stubs).map((file) => path.join(directory, file)), path.join(root, "android", "TextMain.java"),
], { encoding: "utf8", windowsHide: true });
assert.ifError(compiled.error);
assert.equal(compiled.status, 0, compiled.stderr);

function textHash(text, hint = false) {
  return createHash("sha256").update(Buffer.from([hint ? 1 : 0]))
    .update(Buffer.from(text, "utf16le").swap16()).digest("hex");
}
function payload(text, previous = "", numbers = [4, 0, 4, 32, 72, 24], hint = false, windowIdentity = "abc:u0") {
  const header = Buffer.alloc(numbers.length * 4);
  numbers.forEach((value, index) => header.writeInt32BE(value, index * 4));
  const parts = [header];
  for (const value of [windowIdentity, "example.poc", "android.widget.EditText", "example.poc:id/text", textHash(previous, hint), text]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts).toString("base64");
}
function run(argument, properties = {}) {
  const result = spawnSync("java", [
    ...Object.entries(properties).map(([key, value]) => `-D${key}=${value}`),
    "-cp", classes, "dev.mobileuse.text.TextFixture", ...(Array.isArray(argument) ? argument : [argument]),
  ], { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  return result;
}
function expectStatus(result, status, writes = 0) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `MOBILE_USE_TEXT_V1_${status}`);
  assert.equal(result.stderr.split("\n").filter((line) => line.startsWith("WRITE ")).length, writes);
  assert.match(result.stderr, /DISCONNECTED/);
  assert.match(result.stderr, /THREAD_CLOSED/);
}
function expectFailure(result, phase, writes = 0) {
  expectStatus(result, `ERROR_${phase}`, writes);
  assert.match(result.stderr, /text helper failed/);
}
const base64 = (value) => Buffer.from(value).toString("base64");

test("text helper compatibility check connects without reading UI or writing input, then disconnects", () => {
  expectStatus(run("--check", { forbidRead: true, forbidWrite: true }), "READY");
});

test("prepared helper observations preserve exact Unicode, whitespace, XML escapes and redact passwords", () => {
  const text = "  中文 👩‍💻😀 e\u0301 & \" <\n\t\r ";
  const result = run(["--dump", "2"], { previous: base64(text), forbidWrite: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^<hierarchy rotation="2">/);
  assert.match(result.stdout, /window-identity="abc:u0"/);
  assert.doesNotMatch(result.stdout, /window-id=/);
  assert.ok(result.stdout.includes('text="  中文 👩‍💻😀 e\u0301 &amp; &quot; &lt;&#10;&#9;&#13; "'), result.stdout);
  assert.doesNotMatch(result.stderr, /WRITE /);
  assert.match(result.stderr, /DISCONNECTED/);
  const password = run(["--dump", "0"], { password: true, previous: base64("secret-value"), forbidWrite: true });
  assert.equal(password.status, 0, password.stderr);
  assert.doesNotMatch(password.stdout, /secret-value/);
  assert.match(password.stdout, /text="\[redacted\]"/);
  assert.doesNotMatch(password.stdout, /text-sha256=/);
  for (const [properties, phase] of [
    [{ display: 1 }, "WINDOW_DISPLAY"], [{ noRoot: true }, "ROOT"], [{ noWindow: true }, "WINDOW_MISSING"],
    [{ windowUnfocused: true }, "WINDOW_FOCUS"], [{ inactive: true }, "WINDOW_ACTIVE"],
    [{ windowType: 2 }, "WINDOW_TYPE"], [{ windowId: -1 }, "WINDOW_REGISTRATION"],
  ]) {
    const unavailable = run(["--dump", "0"], properties);
    expectFailure(unavailable, phase);
  }
  for (const properties of [{ childCount: 2000 }, { deep: true, depthLimit: 65 }]) {
    const oversized = run(["--dump", "0"], properties);
    expectFailure(oversized, "HIERARCHY");
  }
  for (const properties of [{ childCount: 1999 }, { deep: true, depthLimit: 64 }]) {
    const atLimit = run(["--dump", "0"], properties);
    assert.equal(atLimit.status, 0, atLimit.stderr);
    assert.match(atLimit.stdout, /^<hierarchy/);
  }
});

test("focused fields refresh before observation and carry a fingerprint of raw text rather than lossy XML", () => {
  const previous = "  existing\u0001text\r\n中文😀  ";
  const observed = run(["--dump", "0"], {
    previous: base64(previous), cachedPrevious: base64("cached stale text"), forbidWrite: true,
  });
  assert.equal(observed.status, 0, observed.stderr);
  assert.ok(observed.stdout.includes(`text-sha256="${textHash(previous)}"`));
  assert.ok(observed.stdout.includes("existing\ufffdtext&#13;&#10;中文😀"));
  const appended = run(payload("中文", previous), {
    previous: base64(previous), cachedPrevious: base64("cached stale text"),
  });
  expectStatus(appended, "OK", 1);
  assert.ok(appended.stderr.includes(`WRITE ${base64(previous + "中文")}`));
  expectStatus(run(payload("中文", previous), {
    previous: base64(previous + "changed"), cachedPrevious: base64(previous), forbidWrite: true,
  }), "ELEMENT_CHANGED_FIELD_TEXT");
  expectStatus(run(payload("中文", "Search", undefined, true), {
    previous: base64("Search"), hint: false, forbidWrite: true,
  }), "ELEMENT_CHANGED_FIELD_TEXT");
});

test("cold automation connections wait for a root before a read or a single guarded write", () => {
  for (const argument of [["--dump", "0"], payload("中文")]) {
    const result = run(argument, { rootUnavailableReads: 3, traceRoot: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.split("\n").filter((line) => line.startsWith("ROOT_READ ")).length, 4);
    assert.equal(result.stderr.split("\n").filter((line) => line.startsWith("ROOT_SLEEP ")).length, 3);
    if (Array.isArray(argument)) assert.match(result.stdout, /^<hierarchy/);
    else expectStatus(result, "OK", 1);
  }
  const delayedChangedField = run(payload("中文"), {
    rootUnavailableReads: 3, previous: base64("changed"), forbidWrite: true,
  });
  expectStatus(delayedChangedField, "ELEMENT_CHANGED_FIELD_TEXT");
});

test("root readiness is bounded by the monotonic deadline and never writes when unavailable", () => {
  const boundary = run(payload("中文"), { rootUnavailableReads: 20, traceRoot: true });
  expectStatus(boundary, "OK", 1);
  const overBoundary = run(payload("中文"), { rootUnavailableReads: 21, traceRoot: true, forbidWrite: true });
  expectFailure(overBoundary, "ROOT");
  assert.equal(overBoundary.stderr.split("\n").filter((line) => line.startsWith("ROOT_READ ")).length, 21);
  const slow = run(payload("中文"), { noRoot: true, rootCallMs: 2000, traceRoot: true, forbidWrite: true });
  expectFailure(slow, "ROOT");
  assert.equal(slow.stderr.split("\n").filter((line) => line.startsWith("ROOT_READ ")).length, 1);
});

test("text helper appends exact Unicode, emoji, combining marks, punctuation, and line breaks once", () => {
  for (const text of ["中文", "日本語", "한국어", "العربية", "русский", "e\u0301", "👩‍💻😀", "'\"$HOME;%s&|`\\\n\t\r"]) {
    const previous = "Existing: ";
    const result = run(payload(text, previous), { previous: base64(previous) });
    expectStatus(result, "OK", 1);
    assert.ok(result.stderr.includes(`WRITE ${base64(previous + text)}`));
  }
});

test("text helper never appends placeholder hints as existing text", () => {
  for (const reported of ["Search", ""]) {
    const result = run(payload("中文", reported, undefined, true), { previous: base64(reported), hint: true });
    expectStatus(result, "OK", 1);
    assert.ok(result.stderr.includes(`WRITE ${base64("中文")}`));
    assert.ok(!result.stderr.includes(`WRITE ${base64("Search中文")}`));
  }
});

test("a matching placeholder after filtering is never successful text input", () => {
  for (const reported of ["", "中文"]) {
    expectStatus(run(payload("中文", reported, undefined, true), {
      previous: base64(reported), hint: true, hintValue: "中文", filterToHint: true,
    }), "FAILED", 1);
  }
});

test("an identical editor in a replacement window is rejected before writing", () => {
  const observed = run(["--dump", "0"], { windowIdentity: "abc", windowId: 7, forbidWrite: true });
  assert.match(observed.stdout, /window-identity="abc:u0"/);
  expectStatus(run(payload("中文"), { windowIdentity: "def", forbidWrite: true }), "ELEMENT_CHANGED_WINDOW_ID");
  expectStatus(run(payload("中文"), { windowChangeRead: 2, forbidWrite: true }), "ELEMENT_CHANGED_FIELD_WINDOW");
  expectStatus(run(payload("中文"), { refreshedWindowId: 2, forbidWrite: true }), "ELEMENT_CHANGED_FIELD_WINDOW");
});

test("accessibility re-registration may change IDs across connections without replacing the authorized window", () => {
  for (const windowId of [1, 7, 17539]) {
    const observed = run(["--dump", "0"], { windowId, forbidWrite: true });
    assert.match(observed.stdout, /window-identity="abc:u0"/);
    expectStatus(run(payload("中文"), { windowId: windowId + 1 }), "OK", 1);
  }
});

test("window identity diagnostics reject missing, ambiguous, wrong-user, secondary-display-only and failed reads", () => {
  for (const suffix of ["", " mLastFocus=Window{def u0 other.app/.Activity}"]) {
    const diagnostic = `Display: mDisplayId=0\n mCurrentFocus=Window{ABC  u0\tTitle {with braces}}${suffix}`;
    expectStatus(run(payload("中文"), { windowDiagnostics: base64(diagnostic) }), "OK", 1);
  }
  for (const metadata of ["mode=0 ", "mode=1 rootTaskId=40 ", "mode=0 taskId=-1 "]) {
    const diagnostic = `Display: mDisplayId=0\n mCurrentFocus=Window{abc ${metadata}u0 example.poc/.MainActivity}`;
    expectStatus(run(payload("中文"), { windowDiagnostics: base64(diagnostic) }), "OK", 1);
    expectFailure(run(payload("中文"), {
      windowDiagnostics: base64(diagnostic.replace("u0 ", "u10 ")), forbidWrite: true,
    }), "TARGET_USER");
  }
  for (const [diagnostic, reason] of [
    ["", "DISPLAY"], ["mCurrentFocus=Window{abc u0 example.poc/.MainActivity}", "DISPLAY"],
    ["Display: mDisplayId=1\n mCurrentFocus=Window{abc u0 example.poc/.MainActivity}", "DISPLAY"],
    ["Display: mDisplayId=0\n mCurrentFocus=null", "NONE"],
    ["Display: mDisplayId=0\n mCurrentFocus=Window{abc u10 example.poc/.MainActivity}", "USER"],
    ["Display: mDisplayId=0\n mCurrentFocus=Other{abc u0 example.poc/.MainActivity}", "PREFIX"],
    ["Display: mDisplayId=0\n mCurrentFocus=Window{unknown u0 example.poc/.MainActivity}", "HASH"],
    ["Display: mDisplayId=0\n mCurrentFocus=Window{abc unknown example.poc/.MainActivity}", "OWNER"],
    ["Display: mDisplayId=0\n mCurrentFocus=Window{abc u0 no closing delimiter", "ENDING"],
    ["Display: mDisplayId=0\n mCurrentFocus=Window{abc u0 example.poc/.MainActivity}\n mCurrentFocus=Window{def u0 example.poc/.MainActivity}", "AMBIGUOUS"],
    ["Display: mDisplayId=0\n mCurrentFocus=Window{abc u0 example.poc/.MainActivity}\n Display: mDisplayId=0", "DISPLAY"],
  ]) {
    const result = run(payload("中文"), { windowDiagnostics: base64(diagnostic), forbidWrite: true });
    expectFailure(result, `TARGET_${reason}`);
    assert.doesNotMatch(result.stdout, /example\.poc|mCurrentFocus|Private/);
  }
  for (const [properties, reason] of [[{ windowReadFailed: true }, "READ"], [{ oversizedWindowDiagnostics: true }, "LIMIT"]]) {
    expectFailure(run(payload("中文"), { ...properties, forbidWrite: true }), `TARGET_${reason}`);
  }
  expectFailure(run(["--dump", "0"], { windowChangeRead: 2, forbidWrite: true }), "WINDOW_CHANGED");
});

test("successful text-setting can resize the same field without weakening pre-write geometry checks", () => {
  for (const afterBottom of [50, 100]) expectStatus(run(payload("\n中文😀"), { afterBottom }), "OK", 1);
  expectStatus(run(payload("\n中文😀"), { x: 5, afterBottom: 100, forbidWrite: true }), "ELEMENT_CHANGED_FIELD_BOUNDS");
});

test("text helper rejects changed, password, disabled, ambiguous, wrong-user/app/display targets before writing", () => {
  for (const [properties, reason] of [
    [{ noWindow: true }, "WINDOW_MISSING"], [{ display: 1 }, "WINDOW_DISPLAY"],
    [{ windowType: 2 }, "WINDOW_TYPE"], [{ inactive: true }, "WINDOW_ACTIVE"], [{ windowUnfocused: true }, "WINDOW_ACTIVE"],
    [{ windowId: -1 }, "WINDOW_ID"],
    [{ user: 10 }, "USER"], [{ packageName: "other.app" }, "ROOT_PACKAGE"],
    [{ className: "android.view.View" }, "FIELD_CLASS"], [{ resourceId: "other:id/text" }, "FIELD_ID"],
    [{ x: 5 }, "FIELD_BOUNDS"], [{ password: true }, "FIELD_PASSWORD"], [{ unfocused: true }, "FIELD_MISSING"],
    [{ notEditable: true }, "FIELD_MISSING"], [{ invisible: true }, "FIELD_VISIBLE"],
    [{ disabled: true }, "FIELD_ENABLED"], [{ ambiguous: true }, "FIELD_AMBIGUOUS"],
    [{ refreshFailed: true }, "FIELD_REFRESH"], [{ previous: base64("changed") }, "FIELD_TEXT"],
  ]) expectStatus(run(payload("中文"), { ...properties, forbidWrite: true }), `ELEMENT_CHANGED_${reason}`);
});

test("unsupported actions and oversized resulting values fail without writing", () => {
  expectStatus(run(payload("中文"), { unsupported: true, forbidWrite: true }), "UNSUPPORTED");
  const previous = "a".repeat(4095);
  expectStatus(run(payload("中文", previous), { previous: base64(previous), forbidWrite: true }), "UNSUPPORTED");
  const atLimit = "a".repeat(4094);
  expectStatus(run(payload("中文", atLimit), { previous: base64(atLimit) }), "OK", 1);
  expectStatus(run(payload("中文", atLimit), { previous: base64(atLimit), label: "label", forbidWrite: true }), "UNSUPPORTED");
});

test("rejection, filtering, or post-write identity/readback failure is not success and is never retried", () => {
  for (const properties of [
    { reject: true }, { filter: true }, { afterLostFocus: true }, { afterRefreshFailed: true },
    { afterWindowId: 2 }, { afterPackageName: "other.app" }, { afterClassName: "other.EditText" },
    { afterResourceId: "other:id/text" }, { windowChangeRead: 3 },
  ]) {
    expectStatus(run(payload("中文"), properties), "FAILED", 1);
  }
  const crashed = run(payload("中文"), { throwAfterWrite: true });
  expectFailure(crashed, "WRITE", 1);
  assert.doesNotMatch(crashed.stderr, /中文|Fixture failure/);
});

test("malformed framing, invalid UTF-8, bounds, and controls cannot reach text mutation", () => {
  const invalidUtf8 = Buffer.from(payload("x"), "base64");
  invalidUtf8[invalidUtf8.length - 1] = 0xff;
  for (const argument of [
    "invalid", "--oversized", payload(""), payload("a".repeat(257)), payload("\u0000"),
    payload("\u001b"), payload("\u007f"), payload("\uffff"), payload("x", "", [3, 0, 1, 4, 32, 72, 24]),
    payload("x", "", [4, -1, 4, 32, 72, 24]), payload("x", "", [4, 0, -1, 32, 72, 24]),
    payload("x", "", [4, 0, 4, 32, 0, 24]),
    payload("x", "", [4, 0, 2147483647, 32, 72, 24]), invalidUtf8.toString("base64"),
    ...["", "unknown", "abc:u1", "123456789:u0"].map((identity) => payload("x", "", undefined, false, identity)),
  ]) {
    const result = run(argument, { forbidWrite: true });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "MOBILE_USE_TEXT_V1_ERROR_REQUEST");
    assert.doesNotMatch(result.stderr, /WRITE /);
    assert.match(result.stderr, /text helper failed/);
  }
});
