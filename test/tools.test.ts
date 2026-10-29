import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { isRecord } from "../src/errors.js";
import { USB } from "./helpers.js";

async function fixture(t: TestContext, mode: "legacy" | "auto", scenario = "") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-fixture.js")],
    env: { ...getDefaultEnvironment(), MOBILE_USE_FIXTURE_SCENARIO: scenario },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
  const client = new Client({ name: "mobile-use-fixture", version: "0.1.0" }, { versionNegotiation: { mode } });
  t.after(() => client.close());
  await client.connect(transport);
  if (mode === "auto") assert.ok(client.getDiscoverResult());
  return { client, get stderr() { return stderr; } };
}

function payload(result: { content?: unknown }): Record<string, unknown> {
  assert.ok(Array.isArray(result.content));
  const text: unknown = result.content.find((block: unknown) => isRecord(block) && block.type === "text");
  assert.ok(isRecord(text) && typeof text.text === "string");
  const value: unknown = JSON.parse(text.text);
  assert.ok(isRecord(value));
  return value;
}

function setupSteps(value: Record<string, unknown>, stage: string): string {
  const setup = value.setup;
  assert.ok(isRecord(setup));
  assert.deepEqual(Object.keys(setup).sort(), ["stage", "steps"]);
  assert.equal(setup.stage, stage);
  assert.ok(Array.isArray(setup.steps) && setup.steps.length > 0);
  assert.ok(setup.steps.every((step: unknown) => typeof step === "string" && step.length > 0));
  return setup.steps.join("\n");
}

for (const mode of ["legacy", "auto"] as const) {
  for (const scenario of ["coordinate-animation", "coordinate-target-change"]) {
    test(`coordinate revalidation distinguishes unrelated changes from changed targets over ${mode}: ${scenario}`, async (t) => {
      const { client } = await fixture(t, mode, scenario);
      const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
      const screen = payload(await client.callTool({
        name: "mobile_observe", arguments: { targetToken: selected.targetToken },
      })).observation;
      assert.ok(isRecord(screen));
      const acted = await client.callTool({
        name: "mobile_act",
        arguments: { targetToken: selected.targetToken, observationId: screen.observationId, action: { kind: "tap", target: { x: 40, y: 120 } } },
      });
      const result = payload(acted);
      if (scenario === "coordinate-animation") {
        assert.equal(acted.isError, undefined);
        assert.equal(result.dispatchStatus, "dispatched");
        assert.equal(result.verificationStatus, "requires-observation-review");
        assert.ok(isRecord(result.after) && result.after.observationId !== screen.observationId);
      } else {
        assert.equal(acted.isError, true);
        assert.ok(isRecord(result.error));
        assert.equal(result.error.code, "STALE_OBSERVATION");
        assert.equal(result.error.actionMayHaveRun, false);
        assert.match(String(result.error.message), /Pixels.*interaction region/);
      }
    });
  }

  test(`hierarchy-only observation and action results remain screenshot-free over ${mode}`, async (t) => {
    const { client } = await fixture(t, mode, "no-screenshots");
    assert.match(client.getInstructions() ?? "", /includeScreenshot: false/);
    const observe = (await client.listTools()).tools.find((tool) => tool.name === "mobile_observe");
    assert.ok(observe);
    assert.equal(observe.inputSchema.additionalProperties, false);
    assert.deepEqual(observe.inputSchema.required, ["targetToken"]);
    const screenshotOption = observe.inputSchema.properties?.includeScreenshot;
    assert.ok(isRecord(screenshotOption));
    assert.equal(screenshotOption.type, "boolean");
    assert.equal(screenshotOption.default, true);
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
    const prepared = await client.callTool({
      name: "mobile_prepare_gestures", arguments: { targetToken: selected.targetToken },
    });
    assert.equal(prepared.isError, undefined);
    assert.equal(payload(prepared).status, "prepared");
    for (const invalid of ["false", null, 0]) {
      const result = await client.callTool({
        name: "mobile_observe", arguments: { targetToken: selected.targetToken, includeScreenshot: invalid },
      });
      assert.equal(result.isError, true);
    }
    const observed = await client.callTool({
      name: "mobile_observe", arguments: { targetToken: selected.targetToken, includeScreenshot: false },
    });
    assert.equal(observed.isError, undefined);
    assert.ok(Array.isArray(observed.content) && observed.content.length === 1);
    const initialObservation = payload(observed).observation;
    assert.ok(isRecord(initialObservation));
    let observation = initialObservation;
    assert.deepEqual(observation.screenshot, { status: "skipped", error: null });
    assert.deepEqual(observation.hierarchy, { status: "ok", error: null });
    assert.ok(Array.isArray(observation.elements) && isRecord(observation.elements[0]));
    assert.equal(observation.elements[0].text, "Demo");
    for (const action of [
      { kind: "tap", target: { elementRef: "e1" } },
      { kind: "double_tap", target: { elementRef: "e1" } },
      { kind: "double_tap", target: { elementRef: "e1" }, delayMs: 75 },
      { kind: "key", key: "BACK" },
    ]) {
      const acted = await client.callTool({
        name: "mobile_act",
        arguments: { targetToken: selected.targetToken, observationId: observation.observationId, action },
      });
      assert.equal(acted.isError, undefined);
      assert.ok(Array.isArray(acted.content) && acted.content.length === 1);
      const result = payload(acted);
      if (action.kind === "double_tap") {
        assert.deepEqual(result.gestureTiming, {
          requestedDelayMs: action.delayMs ?? 50, actualGapMs: action.delayMs ?? 50,
        });
      }
      assert.equal(result.dispatchStatus, "dispatched");
      assert.equal(result.verificationStatus, "requires-observation-review");
      assert.ok(isRecord(result.after));
      observation = result.after;
      assert.deepEqual(observation.screenshot, { status: "skipped", error: null });
    }
    for (const delayMs of [-1, 251, 1.5, "50", "0;reboot", null]) {
      const rejected = await client.callTool({
        name: "mobile_act",
        arguments: {
          targetToken: selected.targetToken, observationId: observation.observationId,
          action: { kind: "double_tap", target: { elementRef: "e1" }, delayMs },
        },
      });
      assert.equal(rejected.isError, true);
    }
    for (const action of [
      { kind: "tap", target: { x: 10, y: 10 } },
      { kind: "double_tap", target: { x: 10, y: 10 } },
      { kind: "swipe", from: { x: 10, y: 100 }, to: { x: 10, y: 50 } },
    ]) {
      const fresh = payload(await client.callTool({
        name: "mobile_observe", arguments: { targetToken: selected.targetToken, includeScreenshot: false },
      })).observation;
      assert.ok(isRecord(fresh));
      const rejected = await client.callTool({
        name: "mobile_act", arguments: { targetToken: selected.targetToken, observationId: fresh.observationId, action },
      });
      assert.equal(rejected.isError, true);
      const error = payload(rejected).error;
      assert.ok(isRecord(error) && error.code === "CAPTURE_UNAVAILABLE" && error.actionMayHaveRun === false);
    }
  });

  test(`hierarchy-only capture cannot silently fall back to an image over ${mode}`, async (t) => {
    const { client } = await fixture(t, mode, "hierarchy-unavailable");
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
    const observed = await client.callTool({
      name: "mobile_observe", arguments: { targetToken: selected.targetToken, includeScreenshot: false },
    });
    assert.equal(observed.isError, true);
    assert.ok(Array.isArray(observed.content) && observed.content.length === 1);
    const error = payload(observed).error;
    assert.ok(isRecord(error) && error.code === "OBSERVATION_UNAVAILABLE" && error.actionMayHaveRun === false);
  });

  test(`termination verification ignores MIUI's unrelated user headings over ${mode}`, async (t) => {
    const { client } = await fixture(t, mode, "app-miui-package-users");
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
    const result = await client.callTool({
      name: "mobile_terminate_app", arguments: { targetToken: selected.targetToken, packageName: "example.poc" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(payload(result), { status: "terminated", packageName: "example.poc", userId: 0 });
  });

  test(`Android 11 foreground lookup and launch verification accept ResumedActivity over ${mode}`, async (t) => {
    const { client } = await fixture(t, mode, "app-android11-resumed");
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
    const foreground = await client.callTool({
      name: "mobile_get_foreground_app", arguments: { targetToken: selected.targetToken },
    });
    assert.equal(foreground.isError, undefined);
    assert.deepEqual(payload(foreground), {
      foregroundApp: { packageName: "example.poc", activityName: ".MainActivity", userId: 0 },
    });
    const launched = await client.callTool({
      name: "mobile_launch_app", arguments: { targetToken: selected.targetToken, packageName: "example.poc" },
    });
    assert.equal(launched.isError, undefined);
    assert.deepEqual(payload(launched), { status: "launched", packageName: "example.poc", userId: 0 });
  });

  test(`all six app-management tools expose strict schemas and complete operations over ${mode}`, async (t) => {
    const base = path.resolve(".test-artifacts");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(path.join(base, "mcp apk "));
    t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const filePath = path.join(directory, "fixture app.apk");
    await writeFile(filePath, "fixture only");
    const { client } = await fixture(t, mode);
    const tools = (await client.listTools()).tools;
    const reads = ["mobile_list_apps", "mobile_get_foreground_app"];
    const writes = ["mobile_launch_app", "mobile_terminate_app", "mobile_install_app", "mobile_uninstall_app"];
    for (const name of [...reads, ...writes]) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, reads.includes(name));
      assert.equal(tool.annotations?.destructiveHint, writes.includes(name));
      assert.equal(tool.inputSchema.additionalProperties, false);
      const required = name === "mobile_install_app" ? ["targetToken", "filePath"]
        : reads.includes(name) ? ["targetToken"] : ["targetToken", "packageName"];
      assert.deepEqual(tool.inputSchema.required, required);
      if (writes.includes(name)) assert.equal(tool.annotations?.idempotentHint, false);
      const unselected = await client.callTool({
        name, arguments: { targetToken: randomUUID(), ...(name === "mobile_install_app" ? { filePath } : reads.includes(name) ? {} : { packageName: "example.poc" }) },
      });
      assert.equal(unselected.isError, true);
      const error = payload(unselected).error;
      assert.ok(isRecord(error) && error.code === "TARGET_NOT_SELECTED" && error.actionMayHaveRun === false);
    }
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
    const targetToken = selected.targetToken;
    const listed = await client.callTool({ name: "mobile_list_apps", arguments: { targetToken } });
    assert.equal(listed.isError, undefined);
    assert.deepEqual(payload(listed), { userId: 0, apps: [{ packageName: "android" }, { packageName: "example.poc" }] });
    const foreground = await client.callTool({ name: "mobile_get_foreground_app", arguments: { targetToken } });
    assert.deepEqual(payload(foreground), { foregroundApp: { packageName: "example.poc", activityName: ".MainActivity", userId: 0 } });
    for (const [name, expected] of [
      ["mobile_launch_app", "launched"], ["mobile_terminate_app", "terminated"],
      ["mobile_install_app", "installed"], ["mobile_uninstall_app", "uninstalled"],
    ]) {
      assert.ok(name && expected);
      const result = await client.callTool({
        name, arguments: { targetToken, ...(name === "mobile_install_app" ? { filePath } : { packageName: "example.poc" }) },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(payload(result), { status: expected, userId: 0, packageName: name === "mobile_install_app" ? null : "example.poc" });
      assert.ok(Array.isArray(result.content) && result.content.length === 1, "app management must not capture a screen");
    }
    const after = payload(await client.callTool({ name: "mobile_get_foreground_app", arguments: { targetToken } }));
    assert.equal(after.foregroundApp, null);
    for (const [name, fields] of [
      ["mobile_launch_app", { packageName: "example.poc\n" }],
      ["mobile_terminate_app", { packageName: "example.poc;reboot" }],
      ["mobile_uninstall_app", { packageName: "--user" }],
      ["mobile_install_app", { filePath, grantPermissions: true }],
      ["mobile_list_apps", { observationId: randomUUID() }],
    ] as const) {
      const invalid = await client.callTool({ name, arguments: { targetToken, ...fields } });
      assert.equal(invalid.isError, true);
    }
    const unsupported = await client.callTool({ name: "mobile_install_app", arguments: { targetToken, filePath: "C:\\demo.ipa" } });
    assert.equal(unsupported.isError, true);
    const error = payload(unsupported).error;
    assert.ok(isRecord(error) && error.code === "INVALID_APP_FILE" && error.actionMayHaveRun === false);
  });

  test(`fourteen MCP operations expose typed setup, wake, and observe-act results over ${mode}`, async (t) => {
    const { client } = await fixture(t, mode);
    assert.match(client.getInstructions() ?? "", /On first use in each session, call mobile_doctor/);
    assert.match(client.getInstructions() ?? "", /call mobile_list_devices before offering phone setup/);
    assert.match(client.getInstructions() ?? "", /Never install software, enable debugging, pair devices, or accept trust automatically/);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 14);
    const prepare = tools.tools.find((tool) => tool.name === "mobile_prepare_gestures");
    assert.deepEqual(prepare?.inputSchema.required, ["targetToken"]);
    assert.equal(prepare?.annotations?.readOnlyHint, false);
    assert.equal(prepare?.annotations?.idempotentHint, false);
    assert.match(prepare?.description ?? "", /explicit approval/);
    const startup = tools.tools.find((tool) => tool.name === "mobile_start_adb_server");
    assert.equal(startup?.annotations?.readOnlyHint, false);
    assert.equal(startup?.annotations?.idempotentHint, false);
    assert.deepEqual(startup?.inputSchema.properties, {});
    assert.match(startup?.description ?? "", /user explicitly approves/);
    assert.match(client.getInstructions() ?? "", /ask for explicit permission to use mobile_start_adb_server/);
    const act = tools.tools.find((tool) => tool.name === "mobile_act");
    assert.equal(act?.annotations?.destructiveHint, true);
    assert.equal(act?.annotations?.idempotentHint, false);
    const wake = tools.tools.find((tool) => tool.name === "mobile_wake");
    assert.equal(wake?.annotations?.readOnlyHint, false);
    assert.equal(wake?.annotations?.destructiveHint, true);
    assert.equal(wake?.annotations?.idempotentHint, false);
    assert.deepEqual(wake?.inputSchema.required, ["targetToken"]);
    const doctor = payload(await client.callTool({ name: "mobile_doctor", arguments: {} }));
    assert.equal(doctor.status, "ready");
    assert.equal(doctor.scope, "host");
    assert.equal(doctor.adbExecutable, "C:\\fixture-only\\adb.exe");
    const phoneGuide = setupSteps(doctor, "phone");
    assert.match(phoneGuide, /Build number/);
    assert.match(phoneGuide, /seven times/);
    assert.match(phoneGuide, /USB debugging/);
    assert.match(phoneGuide, /https:\/\/developer\.android\.com\/studio\/debug\/dev-options/);
    const list = payload(await client.callTool({ name: "mobile_list_devices", arguments: {} }));
    assert.ok(Array.isArray(list.devices) && list.devices.length === 2);
    assert.match(setupSteps(list, "select-device"), /Ask which exact endpoint/);
    const unselected = await client.callTool({ name: "mobile_observe", arguments: { targetToken: randomUUID() } });
    assert.equal(unselected.isError, true);
    const unselectedError = payload(unselected).error;
    assert.ok(isRecord(unselectedError));
    assert.equal(unselectedError.code, "TARGET_NOT_SELECTED");
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
    assert.equal(typeof selected.targetToken, "string");
    const woken = await client.callTool({ name: "mobile_wake", arguments: { targetToken: selected.targetToken } });
    assert.equal(woken.isError, undefined);
    assert.deepEqual(payload(woken), { status: "awake-and-unlocked", keyguardDismissed: false });
    assert.ok(Array.isArray(woken.content) && woken.content.length === 1);
    const observed = await client.callTool({ name: "mobile_observe", arguments: { targetToken: selected.targetToken } });
    assert.ok(Array.isArray(observed.content));
    assert.equal(observed.content.length, 2);
    const image: unknown = observed.content.find((block: unknown) => isRecord(block) && block.type === "image");
    assert.ok(isRecord(image) && image.mimeType === "image/png" && typeof image.data === "string");
    assert.equal(Buffer.from(image.data, "base64")[0], 137);
    const observation = payload(observed).observation;
    assert.ok(isRecord(observation));
    assert.equal(observation.targetToken, selected.targetToken);
    assert.equal(observation.nonAtomic, true);
    assert.deepEqual(observation.displayState, { status: "ok", error: null });
    assert.doesNotMatch(JSON.stringify(payload(observed)), /"type":"Buffer"|"image":/);
    const acted = await client.callTool({
      name: "mobile_act",
      arguments: { targetToken: selected.targetToken, observationId: observation.observationId, action: { kind: "tap", target: { elementRef: "e1" } } },
    });
    const action = payload(acted);
    assert.equal(acted.isError, undefined);
    assert.equal(action.dispatchStatus, "dispatched");
    assert.equal(action.verificationStatus, "requires-observation-review");
    assert.ok(isRecord(action.after));
    assert.notEqual(action.after.observationId, observation.observationId);
    const stale = await client.callTool({
      name: "mobile_act",
      arguments: { targetToken: selected.targetToken, observationId: observation.observationId, action: { kind: "key", key: "HOME" } },
    });
    assert.equal(stale.isError, true);
    const failure = payload(stale).error;
    assert.equal(payload(stale).setup, undefined);
    assert.ok(isRecord(failure));
    assert.equal(failure.code, "STALE_OBSERVATION");
    assert.equal(failure.actionMayHaveRun, false);
  });

  for (const scenario of ["hierarchy-unavailable", "display-unavailable"] as const) {
    test(`independent display-state status and input guards survive ${scenario} over ${mode}`, async (t) => {
      const { client } = await fixture(t, mode, scenario);
      const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
      const observed = await client.callTool({ name: "mobile_observe", arguments: { targetToken: selected.targetToken } });
      assert.equal(observed.isError, undefined);
      const observation = payload(observed).observation;
      assert.ok(isRecord(observation) && isRecord(observation.displayState) && isRecord(observation.display));
      assert.equal(observation.displayState.status, scenario === "display-unavailable" ? "unavailable" : "ok");
      assert.equal(observation.display.rotation, scenario === "display-unavailable" ? null : 0);
      const acted = await client.callTool({
        name: "mobile_act",
        arguments: {
          targetToken: selected.targetToken, observationId: observation.observationId,
          action: { kind: "tap", target: { x: 10, y: 10 } },
        },
      });
      if (scenario === "display-unavailable") {
        assert.equal(acted.isError, true);
        const error = payload(acted).error;
        assert.ok(isRecord(error));
        assert.equal(error.code, "DISPLAY_STATE_UNAVAILABLE");
        assert.equal(error.actionMayHaveRun, false);
      } else {
        assert.equal(acted.isError, undefined);
        assert.equal(payload(acted).dispatchStatus, "dispatched");
      }
    });
  }

  for (const scenario of ["app-foreground-unavailable", "app-uncertain-mutation", "app-install-rejected", "app-uninstall-rejected"] as const) {
    test(`app-management ${scenario} errors remain explicit and sanitized over ${mode} MCP`, async (t) => {
      const base = path.resolve(".test-artifacts");
      await mkdir(base, { recursive: true });
      const directory = await mkdtemp(path.join(base, "mcp app error "));
      t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
      const filePath = path.join(directory, "fixture.apk");
      await writeFile(filePath, "fixture only");
      const server = await fixture(t, mode, scenario);
      const selected = payload(await server.client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
      const name = scenario === "app-foreground-unavailable" ? "mobile_get_foreground_app"
        : scenario === "app-install-rejected" ? "mobile_install_app"
        : scenario === "app-uninstall-rejected" ? "mobile_uninstall_app" : "mobile_terminate_app";
      const fields = name === "mobile_get_foreground_app" ? {} : name === "mobile_install_app" ? { filePath } : { packageName: "example.poc" };
      const result = await server.client.callTool({ name, arguments: { targetToken: selected.targetToken, ...fields } });
      assert.equal(result.isError, true);
      assert.ok(Array.isArray(result.content) && result.content.length === 1);
      const value = payload(result);
      assert.equal(value.status, undefined);
      assert.ok(isRecord(value.error));
      const code = scenario === "app-foreground-unavailable" ? "APP_FOREGROUND_UNAVAILABLE"
        : scenario === "app-install-rejected" ? "APP_INSTALL_FAILED"
        : scenario === "app-uninstall-rejected" ? "APP_UNINSTALL_FAILED" : "INTERNAL_ERROR";
      assert.equal(value.error.code, code);
      assert.equal(value.error.actionMayHaveRun, scenario !== "app-foreground-unavailable");
      assert.equal(value.error.retryable, false);
      assert.match(server.stderr, new RegExp(`mobile-use: ${code}`));
      assert.doesNotMatch(JSON.stringify(result) + server.stderr, /private fixture-only app diagnostics/);
    });
  }

  for (const scenario of ["no-devices", "unauthorized", "offline", "unsupported"] as const) {
    test(`first-use ${scenario} inventory returns actionable guidance without selection over ${mode}`, async (t) => {
      const { client } = await fixture(t, mode, scenario);
      const doctor = payload(await client.callTool({ name: "mobile_doctor", arguments: {} }));
      assert.equal(doctor.status, "ready");
      assert.equal(doctor.scope, "host");
      const result = await client.callTool({ name: "mobile_list_devices", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.ok(Array.isArray(result.content) && result.content.length === 1);
      const list = payload(result);
      assert.ok(Array.isArray(list.devices));
      assert.equal(list.targetToken, undefined);
      if (scenario === "no-devices") {
        assert.deepEqual(list.devices, []);
        const steps = setupSteps(list, "phone");
        assert.match(steps, /data-capable cable/);
        assert.match(steps, /empty inventory does not prove Developer options\/debugging is disabled/);
        assert.match(steps, /Developer options alone is not enough/);
      } else {
        assert.equal(list.devices.length, 1);
        const endpoint: unknown = list.devices[0];
        assert.ok(isRecord(endpoint));
        assert.equal(endpoint.selectable, false);
        assert.equal(endpoint.state, scenario === "unsupported" ? "device" : scenario);
        if (scenario === "unauthorized") {
          assert.match(setupSteps(list, "authorization"), /intended computer's RSA/);
        } else {
          assert.match(setupSteps(list, "connection"), /not ready/);
        }
      }
    });
  }

  for (const scenario of ["missing-adb", "old-adb", "server-unavailable", "discovery-failed"] as const) {
    test(`first-use ${scenario} preserves an explicit error over ${mode}`, async (t) => {
      const fixtureServer = await fixture(t, mode, scenario);
      const isHostCheck = scenario === "missing-adb" || scenario === "old-adb";
      const result = await fixtureServer.client.callTool({
        name: isHostCheck ? "mobile_doctor" : "mobile_list_devices", arguments: {},
      });
      assert.equal(result.isError, true);
      assert.ok(Array.isArray(result.content) && result.content.length === 1);
      const failure = payload(result);
      assert.equal(failure.devices, undefined, "failed discovery is never an empty inventory");
      assert.equal(failure.status, undefined, "failed setup must not look ready");
      assert.ok(isRecord(failure.error));
      const expectedCode = scenario === "missing-adb" ? "ADB_NOT_FOUND" : scenario === "old-adb" ? "ADB_VERSION_UNSUPPORTED"
        : scenario === "server-unavailable" ? "ADB_SERVER_UNAVAILABLE" : "INTERNAL_ERROR";
      assert.equal(failure.error.code, expectedCode);
      assert.equal(failure.error.actionMayHaveRun, false);
      if (isHostCheck) {
        const steps = setupSteps(failure, "platform-tools");
        assert.match(steps, /https:\/\/developer\.android\.com\/tools\/releases\/platform-tools/);
        assert.match(steps, /%LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb\.exe/);
        assert.match(steps, /Fully quit and reopen Copilot/);
      } else if (scenario === "server-unavailable") {
        const steps = setupSteps(failure, "adb-server");
        assert.match(steps, /Ask for explicit permission/);
        assert.match(steps, /mobile_start_adb_server/);
        assert.match(steps, /does not establish whether a phone is connected/);
        assert.match(steps, /retries read-only discovery/);
      } else {
        assert.equal(failure.setup, undefined, "unknown failures do not invent a setup diagnosis");
      }
      assert.match(fixtureServer.stderr, new RegExp(`mobile-use: ${expectedCode}`));
      assert.doesNotMatch(JSON.stringify(result) + fixtureServer.stderr, /private fixture-only discovery details/);
    });
  }

  for (const scenario of ["server-unavailable", "server-reused", "server-start-empty"] as const) {
    test(`approved startup returns verified inventory without device selection (${scenario}, ${mode})`, async (t) => {
      const { client } = await fixture(t, mode, scenario);
      if (scenario === "server-unavailable") {
        const before = await client.callTool({ name: "mobile_list_devices", arguments: {} });
        assert.equal(before.isError, true);
        assert.match(setupSteps(payload(before), "adb-server"), /permission/);
      }
      const result = await client.callTool({ name: "mobile_start_adb_server", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.ok(Array.isArray(result.content) && result.content.length === 1);
      const started = payload(result);
      assert.equal(started.status, "ready");
      assert.equal(started.serverAddress, "127.0.0.1:5037");
      assert.equal(started.startupAttempted, scenario !== "server-reused");
      assert.equal(started.targetToken, undefined);
      assert.ok(Array.isArray(started.devices));
      assert.equal(started.devices.length, scenario === "server-start-empty" ? 0 : 2);
      setupSteps(started, scenario === "server-start-empty" ? "phone" : "select-device");
      const unselected = await client.callTool({ name: "mobile_observe", arguments: { targetToken: randomUUID() } });
      assert.equal(unselected.isError, true);
      const invalid = await client.callTool({ name: "mobile_start_adb_server", arguments: { host: "192.0.2.20" } });
      assert.equal(invalid.isError, true, "the startup tool never accepts a remote endpoint");
    });
  }

  for (const scenario of ["server-conflict", "server-start-uncertain"] as const) {
    test(`startup conflicts/uncertainty remain errors with no automatic retry guidance (${scenario}, ${mode})`, async (t) => {
      const { client } = await fixture(t, mode, scenario);
      const result = await client.callTool({ name: "mobile_start_adb_server", arguments: {} });
      assert.equal(result.isError, true);
      const failure = payload(result);
      assert.equal(failure.status, undefined);
      assert.equal(failure.devices, undefined);
      assert.ok(isRecord(failure.error));
      assert.equal(failure.error.code, scenario === "server-conflict" ? "ADB_SERVER_CONFLICT" : "ADB_SERVER_START_FAILED");
      assert.equal(failure.error.actionMayHaveRun, scenario === "server-start-uncertain");
      assert.equal(failure.error.retryable, false);
      assert.match(setupSteps(failure, "adb-server"), /Stop automatic startup attempts/);
    });
  }
}

test("MCP wake reports manual authentication as an error without images or credential inputs", async (t) => {
  const fixtureServer = await fixture(t, "auto", "secure-keyguard");
  const { client } = fixtureServer;
  const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
  const result = await client.callTool({ name: "mobile_wake", arguments: { targetToken: selected.targetToken } });
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content) && result.content.length === 1);
  const error = payload(result).error;
  assert.ok(isRecord(error));
  assert.equal(error.code, "MANUAL_UNLOCK_REQUIRED");
  assert.equal(error.actionMayHaveRun, true);
  assert.equal(error.retryable, false);
  assert.match(fixtureServer.stderr, /MANUAL_UNLOCK_REQUIRED/);
  const credentials = await client.callTool({
    name: "mobile_wake", arguments: { targetToken: selected.targetToken, pin: "fixture-only" },
  });
  assert.equal(credentials.isError, true);
});

test("MCP uncertain outcomes are error results, sanitized, non-retryable, and not semantic success", async (t) => {
  const fixtureServer = await fixture(t, "legacy", "uncertain-input");
  const { client } = fixtureServer;
  const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
  const observed = payload(await client.callTool({ name: "mobile_observe", arguments: { targetToken: selected.targetToken } }));
  assert.ok(isRecord(observed.observation));
  const result = await client.callTool({
    name: "mobile_act",
    arguments: { targetToken: selected.targetToken, observationId: observed.observation.observationId, action: { kind: "key", key: "HOME" } },
  });
  const action = payload(result);
  assert.equal(result.isError, true);
  assert.equal(action.dispatchStatus, "outcome-unknown");
  assert.equal(action.verificationStatus, "unverified");
  assert.equal(action.after, null);
  assert.ok(isRecord(action.error));
  assert.equal(action.error.actionMayHaveRun, true);
  assert.equal(action.error.retryable, false);
  assert.doesNotMatch(JSON.stringify(result) + fixtureServer.stderr, /private fixture-only dispatch details/);
});

test("a maximum-size image plus a large hierarchy fits the documented wire-size budget", async (t) => {
  const { client } = await fixture(t, "auto", "large-observation");
  const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: USB } }));
  const observed = await client.callTool({ name: "mobile_observe", arguments: { targetToken: selected.targetToken } });
  const observation = payload(observed).observation;
  assert.ok(isRecord(observation) && Array.isArray(observation.elements));
  assert.equal(observation.elements.length, 280);
  assert.ok(Array.isArray(observed.content));
  const image: unknown = observed.content.find((block: unknown) => isRecord(block) && block.type === "image");
  assert.ok(isRecord(image) && typeof image.data === "string");
  assert.equal(Buffer.from(image.data, "base64").length, 5 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 8 * 1024 * 1024);
});
