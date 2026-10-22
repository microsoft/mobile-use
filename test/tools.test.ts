import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

for (const mode of ["legacy", "auto"] as const) {
  test(`six MCP operations expose typed wake and observe-act results over ${mode}`, async (t) => {
    const { client } = await fixture(t, mode);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6);
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
    const list = payload(await client.callTool({ name: "mobile_list_devices", arguments: {} }));
    assert.ok(Array.isArray(list.devices) && list.devices.length === 2);
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
    assert.ok(isRecord(failure));
    assert.equal(failure.code, "STALE_OBSERVATION");
    assert.equal(failure.actionMayHaveRun, false);
  });
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
