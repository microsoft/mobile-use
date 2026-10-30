import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { MobileUseService } from "../src/device-session.js";
import { MobileUseError } from "../src/errors.js";
import { parseRecordingCapabilities, recordingDestination, validateRecordingFile } from "../src/recording.js";
import { MAX_RECORDING_TIME_SECONDS, recordingActionSchema } from "../src/types.js";
import type { RecordingResult, ScreenRecording } from "../src/types.js";
import { FakeAdb, FakeMonitors, hasCode, mp4, recorderHelp, USB, WIFI } from "./helpers.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "mobile-use recording "));
  const filePath = path.join(directory, "approved video.mp4");
  const adb = new FakeAdb();
  const monitors = new FakeMonitors(adb);
  const service = new MobileUseService(adb, monitors.factory);
  t.after(async () => {
    service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const { targetToken } = await service.selectDevice(USB);
  const start = () => service.screenRecording(targetToken, { kind: "start", filePath, timeLimitSeconds: 180 });
  return { directory, filePath, adb, monitors, service, targetToken, start };
}

function recording(value: RecordingResult): ScreenRecording {
  assert.ok("recordingId" in value);
  return value;
}

test("recording schema leaves duration optional and rejects invalid durations and unrelated fields", () => {
  assert.deepEqual(recordingActionSchema.parse({ kind: "capabilities" }), { kind: "capabilities" });
  const parsed = recordingActionSchema.parse({ kind: "start", filePath: "C:\\demo.mp4" });
  assert.ok(parsed.kind === "start");
  assert.equal(parsed.timeLimitSeconds, undefined);
  for (const timeLimitSeconds of [1, 180, 181, 600, MAX_RECORDING_TIME_SECONDS]) {
    assert.equal(recordingActionSchema.safeParse({ kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds }).success, true);
  }
  for (const action of [
    { kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds: 0 },
    { kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds: -1 },
    { kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds: null },
    { kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds: MAX_RECORDING_TIME_SECONDS + 1 },
    { kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds: Number.NaN },
    { kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds: Infinity },
    { kind: "start", filePath: "C:\\demo.mp4", timeLimitSeconds: 1.5 },
    { kind: "start", filePath: "C:\\demo.mp4", approved: true },
    { kind: "status", filePath: "C:\\demo.mp4" },
    { kind: "capabilities", timeLimitSeconds: 180 },
    { kind: "stop" }, { kind: "stop", recordingId: "123" }, { kind: "delete" },
  ]) assert.equal(recordingActionSchema.safeParse(action).success, false);
});

test("native help distinguishes the Android 11-13 cap from Android 14-16 unlimited semantics", () => {
  for (const [apiLevel, unlimited] of [[30, false], [31, false], [32, false], [33, false], [34, true], [35, true], [36, true]] as const) {
    assert.deepEqual(parseRecordingCapabilities(recorderHelp(unlimited)), {
      status: "available", source: "device-help", unlimitedSupported: unlimited,
      maxTimeLimitSeconds: unlimited ? MAX_RECORDING_TIME_SECONDS : 180, nativeDefaultTimeLimitSeconds: 180,
    }, `AOSP API ${apiLevel} help`);
  }
  assert.equal(parseRecordingCapabilities(recorderHelp(false, 600)).maxTimeLimitSeconds, 600, "OEM help supplies its own cap");
  assert.equal(parseRecordingCapabilities(recorderHelp(true).replaceAll("\n", "\r\n")).unlimitedSupported, true);
});

test("unknown, oversized, malformed and ambiguous help fails closed without exposing raw output", () => {
  for (const output of [
    "private diagnostic", "Usage: screenrecord\n--time-limit TIME\n    Default is 180.\n",
    recorderHelp(false, 0), recorderHelp(false, MAX_RECORDING_TIME_SECONDS + 1),
    recorderHelp(true) + recorderHelp(false), recorderHelp(true) + "x".repeat(64 * 1024),
    recorderHelp(true).replace("to remove the time limit.", "private OEM instructions"),
    "Usage: screenrecord\n--size WIDTHxHEIGHT\n    Default / maximum is 180.\n",
  ]) {
    assert.throws(() => parseRecordingCapabilities(output), (error: unknown) => {
      hasCode("RECORDING_CAPABILITIES_UNAVAILABLE")(error);
      assert.ok(error instanceof MobileUseError && !error.actionMayHaveRun && !error.retryable);
      assert.doesNotMatch(JSON.stringify(error), /private diagnostic|private OEM/);
      return true;
    });
  }
});

test("capabilities reads only selected-device metadata, preserves observations and works without unlocking", async (t) => {
  const { adb, service, targetToken } = await fixture(t);
  const before = await service.observe(targetToken, undefined, false);
  const count = adb.calls.length;
  adb.keyguard.showing = true;
  const capabilities = await service.screenRecording(targetToken, { kind: "capabilities" });
  assert.ok("unlimitedSupported" in capabilities);
  assert.equal(capabilities.unlimitedSupported, true);
  const calls = adb.calls.slice(count);
  assert.ok(calls.some((call) => call.args.at(-1) === "/system/bin/screenrecord --help 2>&1"));
  assert.ok(calls.every((call) => !call.options.mutating));
  assert.ok(calls.every((call) => !call.args.includes("screencap") && !call.args.includes("policy") && !call.args.includes("activities")));
  adb.keyguard.showing = false;
  await service.act(targetToken, before.observation.observationId, { kind: "key", key: "HOME" });
});

test("legacy help rejects unsupported durations before any mutation and leaves recording available for an approved timed start", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  adb.recordingHelp = recorderHelp(false);
  for (const limit of [undefined, 181, 600]) {
    const action = { kind: "start" as const, filePath, ...(limit === undefined ? {} : { timeLimitSeconds: limit }) };
    await assert.rejects(service.screenRecording(targetToken, action), (error: unknown) => {
      hasCode("RECORDING_DURATION_UNSUPPORTED")(error);
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.actionMayHaveRun, false);
      assert.match(error.message, /only 1-180 seconds/);
      assert.match(error.remediation, /Ask the user to approve/);
      return true;
    });
  }
  assert.equal(adb.calls.some((call) => call.options.mutating), false);
  assert.deepEqual(await service.screenRecording(targetToken, { kind: "status" }), { status: "idle" });
  const started = recording(await service.screenRecording(targetToken, { kind: "start", filePath, timeLimitSeconds: 60 }));
  assert.equal(started.timeLimitSeconds, 60);
  await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId });
});

test("native help takes precedence over API level in both OEM/backport directions", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  assert.equal(adb.properties["ro.build.version.sdk"], "30");
  const backport = recording(await service.screenRecording(targetToken, { kind: "start", filePath }));
  assert.equal(backport.timeLimitSeconds, null, "an older API with modern recorder help can request unlimited capture");
  await service.screenRecording(targetToken, { kind: "stop", recordingId: backport.recordingId });
  adb.properties["ro.build.version.sdk"] = "35";
  adb.properties["ro.build.version.release"] = "15";
  adb.recordingHelp = recorderHelp(false);
  await assert.rejects(service.screenRecording(targetToken, { kind: "start", filePath: path.join(path.dirname(filePath), "new.mp4") }),
    hasCode("RECORDING_DURATION_UNSUPPORTED"));
  assert.equal(adb.calls.filter((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord")).length, 1);
});

test("unknown or missing native help prevents start without poisoning the recording slot", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  adb.recordingHelp = "private unrecognized OEM help";
  await assert.rejects(service.screenRecording(targetToken, { kind: "start", filePath }), hasCode("RECORDING_CAPABILITIES_UNAVAILABLE"));
  adb.handler = (call) => {
    if (call.args.at(-1) === "/system/bin/screenrecord --help 2>&1") {
      throw new MobileUseError("ADB_FAILED", "Private recorder not found.", "Check device recorder.");
    }
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "capabilities" }), hasCode("RECORDING_CAPABILITIES_UNAVAILABLE"));
  assert.equal(adb.calls.some((call) => call.options.mutating), false);
  adb.handler = undefined;
  adb.recordingHelp = recorderHelp(true);
  assert.equal((await service.screenRecording(targetToken, { kind: "start", filePath })).status, "recording");
});

test("capability probe transport loss invalidates the target rather than reporting unsupported recording", async (t) => {
  const { adb, service, targetToken } = await fixture(t);
  adb.handler = (call) => {
    if (call.args.at(-1) === "/system/bin/screenrecord --help 2>&1") {
      throw new MobileUseError("TRANSPORT_LOST", "Fixture transport lost.", "Reselect explicitly.");
    }
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "capabilities" }), hasCode("TRANSPORT_LOST"));
  adb.handler = undefined;
  await assert.rejects(service.screenRecording(targetToken, { kind: "status" }), hasCode("TRANSPORT_LOST"));
});

test("omitting the duration requests native unlimited recording with no host timeout, until explicit stop", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  const started = recording(await service.screenRecording(targetToken, { kind: "start", filePath }));
  assert.equal(started.status, "recording");
  assert.equal(started.timeLimitSeconds, null);
  assert.equal(adb.recordingArgv?.at(-2), "0", "omission must not use Android's default duration");
  const command = adb.calls.find((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord"));
  assert.equal(command?.options.timeoutMs, 0, "the host must not impose its default timeout");
  const status = recording(await service.screenRecording(targetToken, { kind: "status" }));
  assert.equal(status.timeLimitSeconds, null);
  assert.ok(adb.recordingExit);
  const stopped = recording(await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }));
  assert.equal(stopped.status, "saved");
  assert.equal(stopped.timeLimitSeconds, null);
  assert.deepEqual(await readFile(filePath), mp4());
  const pull = adb.calls.find((call) => call.args[2] === "pull");
  assert.equal(pull?.options.timeoutMs, 0, "large recording exports must not retain the old fixed deadline");
});

for (const seconds of [600, MAX_RECORDING_TIME_SECONDS]) {
  test(`an explicit ${seconds}-second limit is forwarded without the old three-minute cap or timer overflow`, async (t) => {
    const { filePath, adb, service, targetToken } = await fixture(t);
    const started = recording(await service.screenRecording(targetToken, { kind: "start", filePath, timeLimitSeconds: seconds }));
    assert.equal(started.timeLimitSeconds, seconds);
    assert.equal(adb.recordingArgv?.at(-2), String(seconds));
    const command = adb.calls.find((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord"));
    assert.equal(command?.options.timeoutMs, seconds === 600 ? 615_000 : 0);
    adb.recordingExit?.();
    const stopped = await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId });
    assert.equal(stopped.status, "saved");
  });
}

test("start/status/stop allow intervening UI input and export only the owned finalized MP4", async (t) => {
  const { directory, filePath, adb, service, targetToken, start } = await fixture(t);
  assert.deepEqual(await service.screenRecording(targetToken, { kind: "status" }), { status: "idle" });
  const before = await service.observe(targetToken, undefined, false);
  const started = recording(await start());
  assert.equal(started.status, "recording");
  assert.equal(started.filePath, filePath);
  assert.equal(started.userId, 0);
  assert.equal(started.timeLimitSeconds, 180);
  assert.deepEqual(await readdir(directory), [], "start must not export or reserve an empty evidence file");
  await assert.rejects(service.act(targetToken, before.observation.observationId, { kind: "key", key: "HOME" }), hasCode("STALE_OBSERVATION"));
  const screen = await service.observe(targetToken, undefined, false);
  await service.act(targetToken, screen.observation.observationId, { kind: "key", key: "HOME" });
  assert.equal((await service.screenRecording(targetToken, { kind: "status" })).status, "recording");
  assert.ok(adb.recordingExit, "the long recording command must not block other tools");
  await assert.rejects(start(), hasCode("RECORDING_ACTIVE"));
  const stopped = recording(await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }));
  assert.equal(stopped.status, "saved");
  assert.equal(stopped.sizeBytes, mp4().length);
  assert.deepEqual(await readFile(filePath), mp4());
  assert.deepEqual(await readdir(directory), ["approved video.mp4"]);
  const calls = adb.calls.length;
  assert.deepEqual(await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }), stopped);
  assert.ok(adb.calls.slice(calls).every((call) => !call.args.includes("pull") && !call.args.join(" ").includes("kill -INT")));
  const running = adb.calls.find((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord"));
  assert.ok(running);
  assert.equal(running.options.timeoutMs, 195_000);
  assert.match(running.args.join(" "), /--bit-rate 4000000 --time-limit 180/);
  assert.ok(adb.calls.every((call) => call.args[0] !== "-t" || call.args[1] === "7"));
  assert.equal(adb.calls.some((call) => call.args.includes("screencap") || call.args.includes("push")), false);
});

test("natural deadline completion remains unsaved until stop, without signaling an exited PID", async (t) => {
  const { filePath, adb, service, targetToken, start } = await fixture(t);
  const started = recording(await start());
  adb.recordingExit?.();
  await Promise.resolve();
  assert.equal((await service.screenRecording(targetToken, { kind: "status" })).status, "completed");
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
  await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId });
  assert.equal(adb.calls.some((call) => call.args.join(" ").includes("kill -INT")), false);
});

test("the minimum duration is passed to the native recorder with a bounded command timeout", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  const started = recording(await service.screenRecording(targetToken, { kind: "start", filePath, timeLimitSeconds: 1 }));
  assert.equal(started.timeLimitSeconds, 1);
  assert.equal(adb.recordingArgv?.at(-2), "1");
  const command = adb.calls.find((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord"));
  assert.equal(command?.options.timeoutMs, 16_000);
});

test("a cancelled startup retains an identifiable recording for an explicit stop, without replay", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  const controller = new AbortController();
  adb.handler = (call) => {
    if (call.args.join(" ").startsWith("-t 7 shell if [ -f ")) controller.abort();
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "start", filePath, timeLimitSeconds: 180 }, controller.signal),
    (error: unknown) => hasCode("CANCELLED")(error) && error instanceof MobileUseError && error.actionMayHaveRun);
  adb.handler = undefined;
  const status = recording(await service.screenRecording(targetToken, { kind: "status" }));
  assert.equal(status.status, "starting");
  assert.ok(adb.recordingExit);
  const stopped = await service.screenRecording(targetToken, { kind: "stop", recordingId: status.recordingId });
  assert.equal(stopped.status, "saved");
  assert.equal(adb.calls.filter((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord")).length, 1);
});

test("a device rejecting unlimited recording fails explicitly without falling back to a timed capture", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  adb.handler = (call) => {
    if (call.args.join(" ").includes("; exec /system/bin/screenrecord")) {
      assert.match(call.args.join(" "), /--time-limit 0 /);
      throw new MobileUseError("ADB_FAILED", "Native unlimited recorder unavailable.", "Check Android recorder support.", false, true);
    }
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "start", filePath }), hasCode("ADB_FAILED"));
  await assert.rejects(service.screenRecording(targetToken, { kind: "status" }), hasCode("ADB_FAILED"));
  assert.equal(adb.calls.filter((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord")).length, 1);
});

test("startup cannot accept a matching PID before the recorder accepts its duration and creates output", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  adb.handler = (call) => {
    if (call.args.join(" ").startsWith("-t 7 shell if [ -r /proc/12345/cmdline ]")) {
      assert.match(call.args.join(" "), /&& \[ -f \/data\/local\/tmp\/mobile-use-recording-[0-9a-f-]+\/capture\.mp4 \]/);
      adb.recordingExit?.(new MobileUseError("ADB_FAILED", "Native duration was rejected.", "Check device recorder support.", false, true));
      return Buffer.alloc(0);
    }
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "start", filePath }), hasCode("ADB_FAILED"));
  await assert.rejects(service.screenRecording(targetToken, { kind: "status" }), hasCode("ADB_FAILED"));
});

test("recording rejects locked screens, invalid paths, existing files and malformed durations before launch", async (t) => {
  const { filePath, adb, service, targetToken, start } = await fixture(t);
  adb.keyguard.showing = true;
  await assert.rejects(start(), hasCode("MANUAL_UNLOCK_REQUIRED"));
  adb.keyguard.showing = false;
  for (const value of [
    "relative.mp4", "\\\\server\\share\\demo.mp4", "\\\\?\\C:\\demo.mp4",
    "C:\\demo.mp4:secret", "C:\\demo.mov", "C:\\NUL.mp4", "C:\\demo.mp4.",
    "C:\\bad?name.mp4", "C:\\folder.\\demo.mp4", "C:\\missing\\directory\\demo.mp4",
  ]) await assert.rejects(recordingDestination(value), hasCode("INVALID_RECORDING_FILE"));
  await writeFile(filePath, "existing");
  await assert.rejects(start(), hasCode("INVALID_RECORDING_FILE"));
  await assert.rejects(service.screenRecording(targetToken, { kind: "start", filePath, timeLimitSeconds: 0 }), hasCode("INVALID_INPUT"));
  assert.equal(adb.calls.some((call) => call.options.mutating), false);
  assert.equal(await readFile(filePath, "utf8"), "existing");
});

test("stop rejects a wrong recording ID and mismatched PID without signaling another process", async (t) => {
  const { adb, service, targetToken, start } = await fixture(t);
  const started = recording(await start());
  await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: "12345678-1234-4234-8234-123456789012" }), hasCode("RECORDING_NOT_FOUND"));
  assert.ok(adb.recordingExit);
  adb.handler = (call) => {
    if (call.args.join(" ").includes("kill -INT")) return Buffer.from("MISMATCH\n");
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }), hasCode("RECORDING_STOP_FAILED"));
  assert.ok(adb.recordingExit);
  assert.equal(adb.calls.some((call) => call.args[2] === "pull"), false);
  const signal = adb.calls.find((call) => call.args.join(" ").includes("kill -INT"));
  assert.match(signal?.args.join(" ") ?? "", /\/proc\/12345\/cmdline/);
  assert.match(signal?.args.join(" ") ?? "", /mobile-use-recording-[0-9a-f-]+\/capture.mp4/);
  assert.doesNotMatch(signal?.args.join(" ") ?? "", /killall|pkill/);
});

test("export never overwrites a file created after start; completed capture remains retryable", async (t) => {
  const { filePath, adb, service, targetToken, start } = await fixture(t);
  const started = recording(await start());
  await writeFile(filePath, "other-session");
  await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }), hasCode("INVALID_RECORDING_FILE"));
  assert.equal(await readFile(filePath, "utf8"), "other-session");
  assert.equal(adb.recordingExit, undefined);
  await rm(filePath);
  const saved = await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId });
  assert.equal(saved.status, "saved");
});

test("exclusive export also prevents a destination race during pull", async (t) => {
  const { filePath, adb, service, targetToken, start } = await fixture(t);
  const started = recording(await start());
  adb.handler = async (call) => {
    if (call.args[2] === "pull") await writeFile(filePath, "race-winner");
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }), hasCode("RECORDING_EXPORT_FAILED"));
  assert.equal(await readFile(filePath, "utf8"), "race-winner");
});

test("unfinalized MP4 and invalid device file sizes are never saved or deleted", async (t) => {
  for (const invalidSize of [undefined, "0", "-1", "unknown", String(Number.MAX_SAFE_INTEGER + 1)]) {
    const { directory, adb, service, targetToken, start } = await fixture(t);
    const started = recording(await start());
    if (invalidSize !== undefined) {
      adb.handler = (call) => call.args.includes("stat") ? Buffer.from(`${invalidSize}\n`) : undefined;
    } else adb.recordingBytes = Buffer.from("not a finalized private video");
    await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }),
      hasCode(invalidSize === undefined ? "RECORDING_EXPORT_FAILED" : "RECORDING_FAILED"));
    assert.deepEqual(await readdir(directory), []);
    assert.equal(adb.calls.some((call) => call.args.join(" ").startsWith("-t 7 shell rm -f")), false);
  }
});

test("recordings larger than the former 128 MiB cap validate and export without buffering the video", async (t) => {
  const { filePath, adb, service, targetToken } = await fixture(t);
  const sizeBytes = 129 * 1024 * 1024;
  const started = recording(await service.screenRecording(targetToken, { kind: "start", filePath }));
  adb.handler = async (call) => {
    if (call.args.includes("stat")) return Buffer.from(`${sizeBytes}\n`);
    if (call.args[2] === "pull") {
      const local = call.args[4];
      assert.ok(local);
      const file = await open(local, "wx");
      try {
        const fixture = mp4();
        const media = Buffer.alloc(8);
        media.writeUInt32BE(sizeBytes - 16 - 20);
        media.write("mdat", 4, "ascii");
        await file.write(fixture.subarray(0, 16), 0, 16, 0);
        await file.write(media, 0, media.length, 16);
        await file.truncate(sizeBytes);
        await file.write(fixture.subarray(-20), 0, 20, sizeBytes - 20);
      } finally {
        await file.close();
      }
      assert.equal(await validateRecordingFile(local), sizeBytes);
      return Buffer.from("1 file pulled\n");
    }
    return undefined;
  };
  const saved = recording(await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }));
  assert.equal(saved.status, "saved");
  assert.equal(saved.sizeBytes, sizeBytes);
  assert.equal((await stat(filePath)).size, sizeBytes);
  assert.equal(await validateRecordingFile(filePath), sizeBytes);
});

test("recorder failures are sanitized and never automatically restarted or exported", async (t) => {
  const { adb, service, targetToken, start } = await fixture(t);
  const started = recording(await start());
  adb.recordingExit?.(new MobileUseError("ADB_FAILED", "Recorder failed.", "Inspect status.", false, true));
  await Promise.resolve();
  await assert.rejects(service.screenRecording(targetToken, { kind: "status" }), hasCode("ADB_FAILED"));
  await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }), hasCode("ADB_FAILED"));
  assert.equal(adb.calls.filter((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord")).length, 1);
  assert.equal(adb.calls.some((call) => call.args[2] === "pull"), false);
});

test("a user switch stops capture but prevents exporting content under a different Android user", async (t) => {
  const { directory, adb, service, targetToken, start } = await fixture(t);
  const started = recording(await start());
  adb.userId = 10;
  await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }), hasCode("RECORDING_FAILED"));
  assert.equal(adb.recordingExit, undefined);
  assert.deepEqual(await readdir(directory), []);
});

test("cleanup errors preserve the saved result and never repeat capture or export", async (t) => {
  const { filePath, adb, service, targetToken, start } = await fixture(t);
  const started = recording(await start());
  adb.handler = (call) => {
    if (call.args.join(" ").includes("shell rm -f")) throw new MobileUseError("ADB_FAILED", "Fixture cleanup failed.", "Check connection.");
    return undefined;
  };
  await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }), hasCode("RECORDING_CLEANUP_FAILED"));
  assert.equal((await service.screenRecording(targetToken, { kind: "status" })).status, "saved");
  assert.deepEqual(await readFile(filePath), mp4());
  adb.handler = undefined;
  await service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId });
  assert.equal(adb.calls.filter((call) => call.args[2] === "pull").length, 1);
});

for (const event of ["disconnect", "reselect", "shutdown"] as const) {
  test(`${event} cancels the recording command without fallback or automatic export`, async (t) => {
    const { directory, filePath, adb, monitors, service, targetToken } = await fixture(t);
    const started = recording(await service.screenRecording(targetToken, { kind: "start", filePath }));
    assert.equal(started.timeLimitSeconds, null);
    const command = adb.calls.find((call) => call.args.join(" ").includes("; exec /system/bin/screenrecord"));
    assert.ok(command?.options.signal);
    if (event === "disconnect") monitors.disconnect();
    else if (event === "reselect") await service.selectDevice(WIFI);
    else service.stop();
    assert.equal(command.options.signal.aborted, true);
    assert.equal(adb.recordingExit, undefined);
    await assert.rejects(service.screenRecording(targetToken, { kind: "stop", recordingId: started.recordingId }),
      hasCode(event === "shutdown" ? "SERVER_STOPPED" : event === "disconnect" ? "TRANSPORT_LOST" : "STALE_TARGET"));
    assert.deepEqual(await readdir(directory), []);
    assert.equal(adb.calls.some((call) => call.args[2] === "pull"), false);
  });
}

test("MP4 validation checks container boundaries and requires finalized metadata and media", async (t) => {
  const { directory } = await fixture(t);
  const file = path.join(directory, "validation.mp4");
  const valid = mp4();
  await writeFile(file, valid);
  assert.equal(await validateRecordingFile(file), valid.length);
  const overflow = Buffer.from(valid);
  overflow.writeUInt32BE(0xfffffff0);
  for (const bytes of [valid.subarray(0, -1), valid.subarray(0, 36), Buffer.concat([valid, Buffer.from("x")]), overflow]) {
    await writeFile(file, bytes);
    await assert.rejects(validateRecordingFile(file), hasCode("RECORDING_EXPORT_FAILED"));
  }
});
