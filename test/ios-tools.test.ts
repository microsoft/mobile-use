import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { isRecord } from "../src/errors.js";
import { createIosFixture } from "./ios-fixture.js";
import { createMobileUseServer } from "../src/tools.js";
import { IOS_ENDPOINT, IOS_UDID, runtimeFixture, waitRuntimeState } from "./ios-runtime-fixture.js";

function payload(result: { content?: unknown }): Record<string, unknown> {
  assert.ok(Array.isArray(result.content));
  const text: unknown = result.content.find((block: unknown) => isRecord(block) && block.type === "text");
  assert.ok(isRecord(text) && typeof text.text === "string");
  const value: unknown = JSON.parse(text.text);
  assert.ok(isRecord(value));
  return value;
}

for (const mode of ["legacy", "auto"] as const) {
  test(`main's stdio entry point exposes the complete iOS mobile_* flow over ${mode}`, async (t) => {
    const http = await createIosFixture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      env: { ...getDefaultEnvironment(), MOBILE_USE_PLATFORM: "ios", MOBILE_USE_WDA_URL: http.url },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const client = new Client({ name: "ios-main-flow-fixture", version: "0.1.0" }, { versionNegotiation: { mode } });
    t.after(async () => {
      await client.close();
      for (let attempt = 0; attempt < 100 && http.state.sessionId !== null; attempt++) await delay(10);
      assert.equal(http.state.sessionId, null, "the stdio server must clean up its owned session on disconnect");
      await http.close();
    });
    await client.connect(transport);
    assert.match(client.getInstructions() ?? "", /server is in iOS mode/);
    assert.doesNotMatch(client.getInstructions() ?? "", /MSMT|WAITING_APPROVAL/);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some((tool) => tool.name === "mobile_ios_runtime"), false);
    for (const name of ["mobile_doctor", "mobile_list_devices", "mobile_select_device", "mobile_observe",
      "mobile_tap", "mobile_swipe", "mobile_input_text", "mobile_press_key", "mobile_app_management"]) {
      assert.ok(tools.some((tool) => tool.name === name));
    }

    assert.match(tools.find((tool) => tool.name === "mobile_input_text")?.description ?? "", /current cursor/);
    const selection = tools.find((tool) => tool.name === "mobile_select_device");
    assert.equal(selection?.annotations?.readOnlyHint, false);
    assert.equal(selection?.annotations?.destructiveHint, true);
    assert.equal(selection?.annotations?.idempotentHint, false);
    const doctor = payload(await client.callTool({ name: "mobile_doctor", arguments: {} }));
    assert.equal(doctor.platform, "ios");
    assert.equal("adbExecutable" in doctor, false);
    const devices = payload(await client.callTool({ name: "mobile_list_devices", arguments: {} })).devices;
    assert.ok(Array.isArray(devices) && isRecord(devices[0]));
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: devices[0].endpointId } }));
    assert.ok(isRecord(selected.identity));
    assert.equal(selected.identity.platform, "ios");
    assert.equal("androidVersion" in selected.identity, false);
    const targetToken = selected.targetToken;
    const observe = async (includeScreenshot: boolean) => {
      const result = await client.callTool({ name: "mobile_observe", arguments: { targetToken, includeScreenshot } });
      assert.equal(result.isError, undefined);
      const screen = payload(result).observation;
      assert.ok(isRecord(screen));
      return screen;
    };
    let screen = await observe(false);
    assert.ok(Array.isArray(screen.elements));
    const button: unknown = screen.elements.find((item: unknown) => isRecord(item) && item.resourceId === "button");
    assert.ok(isRecord(button));
    const invalid = await client.callTool({ name: "mobile_tap",
      arguments: { targetToken, approved: true, action: { kind: "tap", observationId: screen.observationId, target: { elementRef: button.ref } } } });
    assert.equal(invalid.isError, true);
    const tapped = await client.callTool({ name: "mobile_tap",
      arguments: { targetToken, action: { kind: "tap", observationId: screen.observationId, target: { elementRef: button.ref } } } });
    assert.equal(tapped.isError, undefined);
    const afterTap = payload(tapped).after;
    assert.ok(isRecord(afterTap) && isRecord(afterTap.screenshot));
    assert.equal(afterTap.screenshot.status, "skipped");
    assert.ok(tapped.content.every((block) => block.type !== "image"));
    const typed = await client.callTool({ name: "mobile_input_text",
      arguments: { targetToken, action: { kind: "type_text", observationId: afterTap.observationId, text: "中文🙂" } } });
    assert.equal(typed.isError, undefined);
    assert.equal(http.state.value, "safe中文🙂");
    assert.equal(http.calls.some((call) => call.path.endsWith("/screenshot")), false);
    screen = await observe(true);
    assert.ok(Array.isArray(screen.elements));
    const table: unknown = screen.elements.find((item: unknown) => isRecord(item) && item.resourceId === "table");
    assert.ok(isRecord(table));
    const swiped = await client.callTool({ name: "mobile_swipe", arguments: {
      targetToken, observationId: screen.observationId, elementRef: table.ref,
      from: { x: 10, y: 100 }, to: { x: 10, y: 140 }, durationMs: 400,
    } });
    assert.equal(swiped.isError, undefined);
    assert.ok(swiped.content.some((block) => block.type === "image"));
    const afterSwipe = payload(swiped).after;
    assert.ok(isRecord(afterSwipe));
    const launch = await client.callTool({ name: "mobile_app_management", arguments: {
      targetToken, action: { kind: "launch", packageName: "example.target-app" },
    } });
    assert.equal(launch.isError, undefined);
    assert.equal(payload(launch).packageName, "example.target-app");
    const old = await client.callTool({ name: "mobile_press_key",
      arguments: { targetToken, observationId: afterSwipe.observationId, key: "HOME" } });
    assert.equal(old.isError, true);
    const oldError = payload(old).error;
    assert.ok(isRecord(oldError));
    assert.equal(oldError.code, "STALE_OBSERVATION");
    screen = await observe(false);
    const home = await client.callTool({ name: "mobile_press_key",
      arguments: { targetToken, observationId: screen.observationId, key: "HOME" } });
    assert.equal(home.isError, undefined);
    const unsupported = await client.callTool({ name: "mobile_screen_recording",
      arguments: { targetToken, action: { kind: "capabilities" } } });
    const error = payload(unsupported).error;
    assert.ok(isRecord(error));
    assert.equal(error.code, "UNSUPPORTED_OPERATION");
    assert.equal(error.actionMayHaveRun, false);
    assert.doesNotMatch(stderr, /private-error|private-device-name|MSMT/);
  });
}

for (const mode of ["legacy", "auto"] as const) {
  test(`managed iOS runtime integrates with existing MCP selection/input over ${mode}`, async (t) => {
    const f = await runtimeFixture(t);
    const server = createMobileUseServer(f.service);
    const client = new Client({ name: "managed-ios-fixture", version: "0.1.0" }, { versionNegotiation: { mode } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((tool) => tool.name === "mobile_ios_runtime")?.annotations?.readOnlyHint, false);
    assert.match(client.getInstructions() ?? "", /Managed USB mode/);
    const doctor = payload(await client.callTool({ name: "mobile_doctor", arguments: {} }));
    assert.equal(doctor.status, "runtime-not-ready");
    const start = await client.callTool({ name: "mobile_ios_runtime",
      arguments: { action: { kind: "start", endpointId: IOS_ENDPOINT } } });
    assert.equal(start.isError, undefined);
    const { runtimeToken, state } = payload(start);
    assert.equal(state, "preparing");
    assert.equal(typeof runtimeToken, "string");
    await waitRuntimeState(f.runtime, "awaiting-developer-trust");
    assert.equal(f.events.includes("install"), false);
    assert.equal(f.events.includes("start-wda"), false);
    const premature = await client.callTool({ name: "mobile_select_device", arguments: { endpointId: IOS_ENDPOINT } });
    assert.equal(premature.isError, true);
    const ready = await client.callTool({ name: "mobile_ios_runtime",
      arguments: { action: { kind: "confirm_trust", runtimeToken } } });
    assert.equal(ready.isError, undefined);
    assert.equal(payload(ready).state, "starting");
    await waitRuntimeState(f.runtime, "ready");
    const selected = payload(await client.callTool({ name: "mobile_select_device", arguments: { endpointId: IOS_ENDPOINT } }));
    assert.ok(isRecord(selected.identity));
    assert.equal(selected.identity.udid, IOS_UDID);
    const screen = payload(await client.callTool({ name: "mobile_observe",
      arguments: { targetToken: selected.targetToken, includeScreenshot: false } })).observation;
    assert.ok(isRecord(screen));
    const input = await client.callTool({ name: "mobile_input_text", arguments: {
      targetToken: selected.targetToken, action: { kind: "type_text", observationId: screen.observationId, text: "runtime-test" },
    } });
    assert.equal(input.isError, undefined);
    assert.equal(f.http.state.value, "saferuntime-test");
    const stopped = await client.callTool({ name: "mobile_ios_runtime",
      arguments: { action: { kind: "stop", runtimeToken } } });
    assert.equal(stopped.isError, undefined);
    assert.equal(payload(stopped).wdaPortClosed, true);
    assert.equal(f.http.state.sessionId, null);
    const stale = await client.callTool({ name: "mobile_observe", arguments: { targetToken: selected.targetToken } });
    assert.equal(stale.isError, true);
  });

  test(`managed main stdio connects before runtime startup over ${mode}`, async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      env: { ...getDefaultEnvironment(), MOBILE_USE_PLATFORM: "ios", MOBILE_USE_IOS_RUNTIME: "managed",
        MOBILE_USE_IOS_RUNNER_BUNDLE_ID: "example.runner.xctrunner" }, stderr: "pipe",
    });
    const client = new Client({ name: "managed-main-entry-fixture", version: "0.1.0" }, { versionNegotiation: { mode } });
    t.after(() => client.close());
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "mobile_ios_runtime"));
    const status = payload(await client.callTool({ name: "mobile_ios_runtime", arguments: { action: { kind: "status" } } }));
    assert.equal(status.state, "idle");
    assert.equal(status.runtimeToken, null);
  });
}
