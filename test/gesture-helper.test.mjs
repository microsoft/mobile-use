import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "mobile-use-java-test-"));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  "android/os/SystemClock.java": `
    package android.os;
    public final class SystemClock {
      public static long now = 1000;
      public static long uptimeMillis() { return now; }
      public static void sleep(long duration) { now += duration; }
    }`,
  "android/view/InputDevice.java": `
    package android.view;
    public final class InputDevice { public static final int SOURCE_TOUCHSCREEN = 4098; }`,
  "android/view/InputEvent.java": `
    package android.view;
    public class InputEvent {}`,
  "android/view/ViewConfiguration.java": `
    package android.view;
    public final class ViewConfiguration {
      public static int getDoubleTapTimeout() { return 300; }
    }`,
  "android/view/MotionEvent.java": `
    package android.view;
    public final class MotionEvent extends InputEvent {
      public static final int ACTION_DOWN = 0, ACTION_UP = 1;
      public int action, source, display;
      public long down, time;
      public static MotionEvent obtain(long down, long time, int action, float x, float y,
          float pressure, float size, int meta, float xp, float yp, int device, int edge) {
        if (x != 10 || y != 20 || pressure != (action == ACTION_UP ? 0f : 1f)) {
          throw new IllegalStateException("Unexpected event geometry/pressure");
        }
        MotionEvent e = new MotionEvent();
        e.down = down; e.time = time; e.action = action;
        return e;
      }
      public void setSource(int source) { this.source = source; }
      public void setDisplayId(int display) { this.display = display; }
      public void recycle() {}
    }`,
  "android/hardware/input/InputManager.java": `
    package android.hardware.input;
    import android.os.SystemClock;
    import android.view.InputEvent;
    import android.view.MotionEvent;
    public class InputManager {
      private int count = 0;
      public static InputManager getInstance() { return new InputManager(); }
      public boolean injectInputEvent(InputEvent input, int mode) {
        MotionEvent e = (MotionEvent) input;
        if (mode != 2 || e.source != 4098 || e.display != 0) {
          throw new IllegalStateException("Unexpected dispatch mode/source/display");
        }
        count++;
        System.err.println("EVENT " + e.action + " " + e.down + " " + e.time);
        if (count == 2) SystemClock.now += Integer.getInteger("stall", 0);
        return count != Integer.getInteger("failAt", 0);
      }
    }`,
};
for (const [file, text] of Object.entries(stubs)) {
  const destination = path.join(directory, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text);
}
function compile(output, files) {
  const result = spawnSync("javac", [
    "--release", "8", "-Xlint:-options", "-d", output,
    ...files, path.join(root, "android", "GestureMain.java"),
  ], { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
function run(classes, args, properties = []) {
  const result = spawnSync("java", [
    ...properties, "-cp", classes, "dev.mobileuse.gestures.GestureMain", ...args,
  ], { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  return result;
}

const variants = [];
for (const modern of [false, true]) {
  const classes = path.join(directory, modern ? "modern" : "legacy");
  await mkdir(classes);
  const sources = Object.keys(stubs).map((file) => path.join(directory, file));
  if (modern) {
    const global = path.join(directory, "android", "hardware", "input", "InputManagerGlobal.java");
    await writeFile(global, `
      package android.hardware.input;
      public final class InputManagerGlobal extends InputManager {
        public static InputManagerGlobal getInstance() { return new InputManagerGlobal(); }
      }`);
    sources.push(global);
  }
  compile(classes, sources);
  const label = modern ? "InputManagerGlobal" : "Android 11 InputManager";
  variants.push({ classes, label });
}

for (const { classes, label } of variants) {
  test(`helper compatibility check injects no input (${label})`, () => {
    const result = run(classes, ["--check"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "MOBILE_USE_GESTURES_V1_READY");
    assert.equal(result.stderr, "");
  });

  test(`helper injects four acknowledged events with controlled timestamps (${label})`, () => {
    for (const delay of [0, 1, 50, 250]) {
      const result = run(classes, ["10", "20", String(delay)]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `MOBILE_USE_DOUBLE_TAP_V1 ${delay}`);
      const secondDown = 1010 + delay;
      assert.deepEqual(result.stderr.trim().split(/\r?\n/), [
        "EVENT 0 1000 1000", "EVENT 1 1000 1010",
        `EVENT 0 ${secondDown} ${secondDown}`, `EVENT 1 ${secondDown} ${secondDown + 10}`,
      ]);
    }
  });

  test(`helper stops on each rejected injection without success or retries (${label})`, () => {
    for (const failAt of [1, 2, 3, 4]) {
      const result = run(classes, ["10", "20", "50"], [`-DfailAt=${failAt}`]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal((result.stderr.match(/^EVENT /gm) ?? []).length, failAt);
      assert.match(result.stderr, /input may be partial; do not replay/);
    }
  });

  test(`helper refuses a late second tap and rejects invalid arguments (${label})`, () => {
    const late = run(classes, ["10", "20", "50"], ["-Dstall=301"]);
    assert.equal(late.status, 1);
    assert.equal(late.stdout, "");
    assert.equal((late.stderr.match(/^EVENT /gm) ?? []).length, 2);
    for (const args of [[], ["10", "20"], ["10", "20", "251"], ["10", "20", "-1"],
      ["10", "20", "1.5"], ["-1", "20", "50"], ["10", "20", "50;reboot"]]) {
      const invalid = run(classes, args);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, "");
      assert.doesNotMatch(invalid.stderr, /^EVENT /m);
    }
  });
}
