import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { isRecord } from "../src/errors.js";
import { createIosFixture } from "./ios-fixture.js";

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
    for (const name of ["mobile_doctor", "mobile_list_devices", "mobile_select_device", "mobile_observe",
      "mobile_tap", "mobile_swipe", "mobile_input_text", "mobile_press_key", "mobile_app_management"]) {
      assert.ok(tools.some((tool) => tool.name === name));
    }
    assert.match(tools.find((tool) => tool.name === "mobile_input_text")?.description ?? "", /current cursor/);
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
