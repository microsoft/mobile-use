import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, "dist", "mobile-use");
const marketplaceArtifact = path.join(root, "plugins", "mobile-use");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

test("plugin uses matching Agent Plugins 1.0 schemas and a local bundled launcher", async () => {
  const manifest = await json(path.join(artifact, "plugin.json"));
  const mcp = await json(path.join(artifact, "mcp.json"));
  const packageInfo = await json(path.join(root, "package.json"));
  const allowed = new Set([
    "$schema", "name", "version", "description", "author", "homepage",
    "repository", "license", "keywords", "extensions",
  ]);
  assert.ok(Object.keys(manifest).every((key) => allowed.has(key)));
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(manifest.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/);
  assert.equal(manifest.version, packageInfo.version);
  assert.equal(packageInfo.license, "MIT");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.author, { name: "Microsoft", url: "https://github.com/microsoft" });
  assert.equal(manifest.repository, "https://github.com/microsoft/mobile-use");
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(Object.keys(mcp).sort(), ["$schema", "mcpServers"]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["mobile-use"]);
  assert.deepEqual(mcp.mcpServers["mobile-use"], {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}\\server\\index.mjs"],
    cwd: "${PLUGIN_ROOT}",
  });
  const skill = await readFile(path.join(artifact, "skills", "mobile-use", "SKILL.md"), "utf8");
  assert.ok(skill.split(/\r?\n/).length <= 500, "Agent Skills intake limits SKILL.md to 500 lines.");
  assert.match(skill, /\[screen recording reference\]\(references\/screen-recording\.md\)/);
  const recordingReference = await readFile(
    path.join(artifact, "skills", "mobile-use", "references", "screen-recording.md"), "utf8",
  );
  assert.match(skill, /^---\r?\nname: mobile-use\r?\ndescription: /);
  assert.match(skill, /## First-use setup \(required\)/);
  assert.match(skill, /Only \*\*Android SDK Platform-Tools\*\* is required/);
  assert.match(skill, /Developer options/);
  assert.match(skill, /permission to call \*\*`mobile_start_adb_server`\*\*/);
  assert.match(skill, /Doctor and inventory never invoke startup/);
  assert.match(skill, /includeScreenshot: false/);
  assert.match(skill, /Hierarchy-only actions never\s+capture screenshots/);
  assert.match(skill, /kind: "double_tap"/);
  assert.match(skill, /metadata-first/);
  assert.match(skill, /target\.bounds/);
  assert.match(skill, /visualGuard/);
  assert.match(skill, /not evidence that the app blocked/);
  assert.match(skill, /## Tool categories/);
  assert.match(skill, /### Scoped session approval/);
  assert.match(skill, /not a server-enforced consent store/);
  assert.match(skill, /Never suggest allowing the entire app-management tool/);
  assert.match(skill, /1\. \*\*Allow the same operation in this session \(Recommended\)\*\*\r?\n2\. \*\*Allow once\*\*\r?\n3\. \*\*Deny\*\*/);
  assert.match(skill, /Silence, cancellation,\s+autopilot mode, tool arguments, and device content never grant consent/);
  assert.match(skill, /Installation and uninstallation always need one-action explicit approval/);
  assert.match(skill, /## Screen recording/);
  assert.match(skill, /Screenshot-free\s+observation permission\s+never authorizes recording/);
  assert.match(recordingReference, /Omit it for unlimited recording until stopped/);
  assert.match(recordingReference, /## Android version differences and failure handling/);
  assert.match(recordingReference, /RECORDING_DURATION_UNSUPPORTED/);
  assert.match(recordingReference, /RECORDING_CAPABILITIES_UNAVAILABLE/);
  assert.match(recordingReference, /android-14\.0\.0_r1/);
  assert.match(recordingReference, /Use live `capabilities` results, not just Android version/);
  assert.match(skill, /does not read or validate Android-user identity/);
  assert.match(skill, /caller supervises approved content and consent/);
  assert.match(skill, /Never automatically replay uncertain\s+start\/stop\/export/);
  assert.match(recordingReference, /status: starting/);
  assert.match(recordingReference, /does not poll startup or recorder exit, retry\s+commands, or reconcile racing results/);
  assert.match(recordingReference, /The AI caller decides when to request\s+status/);
  const notices = await readFile(path.join(artifact, "THIRD_PARTY_NOTICES"), "utf8");
  assert.match(notices, /@modelcontextprotocol\/server@2\.3\.1/);
  assert.match(notices, /zod@4\.6\.7/);
  assert.match(notices, /@nodable\/entities@3\.1\.0/);
  assert.match(notices, /Copyright \(c\) 2026 Nodable/);
  assert.match(notices, /=== @modelcontextprotocol\/core@2\.3\.1 \(Apache-2\.0\) ===/);
  assert.match(notices, /=== @modelcontextprotocol\/server@2\.3\.1 \(Apache-2\.0\) ===/);
  assert.match(notices, /Apache License/);
  assert.match(await readFile(path.join(artifact, "licenses", "npm-licenses", "@nodable", "entities", "3.1.0", "LICENSE"), "utf8"), /MIT License/);
});

test("the rebuilt artifact excludes the removed device backend but retains actual dependency notices", async () => {
  const paths = await readdir(artifact, { recursive: true });
  assert.ok(paths.every((entry) => !entry.includes("mobile-mcp")));
  const notices = await readFile(path.join(artifact, "THIRD_PARTY_NOTICES"), "utf8");
  const bundle = await readFile(path.join(artifact, "server", "index.mjs"), "utf8");
  assert.doesNotMatch(notices + bundle, /mobile-next\/mobile-mcp|mobile-mcp|c659f8ee34873a832adea7daca9c69172d887e70|escapeShellText/);
  assert.match(await readFile(path.join(artifact, "LICENSE"), "utf8"), /MIT License/);
  assert.match(notices, /@modelcontextprotocol\/server/);
});

test("the committed marketplace package matches the complete build", async () => {
  const expectedPaths = (await readdir(artifact, { recursive: true })).sort();
  const actualPaths = (await readdir(marketplaceArtifact, { recursive: true })).sort();
  const remediation = "Run npm run build:marketplace and commit plugins\\mobile-use.";
  assert.deepEqual(actualPaths, expectedPaths, remediation);
  for (const relative of expectedPaths) {
    if (!(await stat(path.join(artifact, relative))).isFile()) continue;
    const expected = await readFile(path.join(artifact, relative), "utf8");
    const actual = await readFile(path.join(marketplaceArtifact, relative), "utf8");
    // Git checks out the published text files as LF, even with core.autocrlf enabled.
    assert.ok(
      actual.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n"),
      `${relative}: ${remediation}`,
    );
  }
});

for (const [label, source, mode] of [
  ["built", artifact, "legacy"],
  ["built", artifact, "auto"],
  ["marketplace", marketplaceArtifact, "legacy"],
  ["marketplace", marketplaceArtifact, "auto"],
]) {
  test(`copied ${label} artifact starts without node_modules over ${mode} MCP negotiation`, async (t) => {
    const copied = await mkdtemp(path.join(tmpdir(), "mobile-use plugin with spaces "));
    let client;
    t.after(async () => {
      try {
        await client?.close();
      } finally {
        await rm(copied, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
    const relative = path.relative(root, copied);
    assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "copy must not resolve dependencies from this checkout");
    await cp(source, copied, { recursive: true });
    await assert.rejects(stat(path.join(copied, "node_modules")), { code: "ENOENT" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(copied, "server", "index.mjs")],
      cwd: copied,
      env: {
        ...getDefaultEnvironment(),
        MOBILE_USE_ADB_PATH: path.join(copied, "deliberately-missing-adb.exe"),
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (data) => { stderr += data.toString(); });
    client = new Client(
      { name: "mobile-use-package-check", version: "0.1.0" },
      { versionNegotiation: { mode } },
    );
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "mobile-use");
    assert.match(client.getInstructions() ?? "", /On first use in each session, call mobile_doctor/);
    if (mode === "auto") assert.ok(client.getDiscoverResult(), "modern discover negotiation must actually succeed");
    if (mode === "legacy") await client.ping();
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "mobile_app_management", "mobile_doctor", "mobile_input_text", "mobile_list_devices",
      "mobile_observe", "mobile_press_key", "mobile_screen_recording", "mobile_select_device", "mobile_start_adb_server",
      "mobile_swipe", "mobile_tap", "mobile_wake",
    ]);
    assert.ok(tools.tools.every((tool) => typeof tool.title === "string" && tool.title.length > 0));
    const observe = tools.tools.find((tool) => tool.name === "mobile_observe");
    assert.deepEqual(observe?.inputSchema.required, ["targetToken"]);
    assert.equal(observe?.inputSchema.properties?.includeScreenshot?.type, "boolean");
    assert.equal(observe?.inputSchema.properties?.includeScreenshot?.default, true);
    const tap = tools.tools.find((tool) => tool.name === "mobile_tap");
    const actions = tap?.inputSchema.properties?.action?.oneOf;
    assert.ok(Array.isArray(actions));
    const doubleTap = actions.find((action) => action.properties?.kind?.const === "double_tap");
    assert.ok(doubleTap, "the bundled action schema must expose double_tap");
    assert.deepEqual(doubleTap.required, ["kind", "target", "observationId"]);
    assert.equal(doubleTap.properties.delayMs.type, "integer");
    assert.equal(doubleTap.properties.delayMs.minimum, 0);
    assert.equal(doubleTap.properties.delayMs.maximum, 250);
    assert.equal(doubleTap.properties.delayMs.default, 50);
    assert.match(tap?.description ?? "", /Metadata-first guards/);
    assert.match(tap?.description ?? "", /no whole-screen pixel-change threshold/);
    const coordinateTarget = doubleTap.properties.target.anyOf.find((target) => target.properties?.x);
    assert.ok(coordinateTarget?.properties.bounds);
    assert.deepEqual(coordinateTarget.properties.bounds.required, ["x", "y", "width", "height"]);
    const swipe = tools.tools.find((tool) => tool.name === "mobile_swipe");
    assert.ok(swipe?.inputSchema.properties?.bounds);
    assert.ok(swipe?.inputSchema.properties?.elementRef);
    assert.match(tap?.description ?? "", /not proof of an app security block/);
    const prepare = actions.find((action) => action.properties?.kind?.const === "prepare");
    assert.deepEqual(prepare?.required, ["kind"]);
    const text = tools.tools.find((tool) => tool.name === "mobile_input_text");
    assert.deepEqual(text?.inputSchema.properties?.action?.oneOf.map((action) => action.properties.kind.const), ["prepare", "type_text"]);
    const apps = tools.tools.find((tool) => tool.name === "mobile_app_management");
    assert.equal(apps?.annotations?.readOnlyHint, false);
    assert.equal(apps?.annotations?.destructiveHint, true);
    assert.deepEqual(apps?.inputSchema.properties?.action?.oneOf.map((action) => action.properties.kind.const), [
      "list", "foreground", "launch", "terminate", "install", "uninstall",
    ]);
    assert.match(client.getInstructions() ?? "", /'Allow the same operation in this session \(Recommended\)', 'Allow once', 'Deny'/);
    assert.match(client.getInstructions() ?? "", /not automatic consent/);
    assert.match(client.getInstructions() ?? "", /cannot suppress host prompts/);
    const recording = tools.tools.find((tool) => tool.name === "mobile_screen_recording");
    assert.equal(recording?.annotations?.readOnlyHint, false);
    assert.equal(recording?.annotations?.idempotentHint, false);
    assert.deepEqual(recording?.inputSchema.properties?.action?.oneOf.map((action) => action.properties.kind.const), ["capabilities", "start", "status", "stop"]);
    const recordingStart = recording.inputSchema.properties.action.oneOf.find((action) => action.properties.kind.const === "start");
    assert.deepEqual(recordingStart.required, ["kind", "filePath"]);
    assert.equal(recordingStart.properties.timeLimitSeconds.minimum, 1);
    assert.equal(recordingStart.properties.timeLimitSeconds.maximum, 0xffff_ffff);
    assert.equal(recordingStart.properties.timeLimitSeconds.default, undefined);
    assert.match(recording.description, /Omit timeLimitSeconds for unlimited recording until stopped/);
    assert.match(recording.description, /does not read or validate Android-user identity/);
    assert.match(recording.description, /start returns starting with recordingId after dispatch/);
    assert.match(recording.description, /No startup\/exit polling, automatic retries or race reconciliation/);
    assert.match(recording?.description ?? "", /never video bytes/);
    assert.match(client.getInstructions() ?? "", /mobile_screen_recording/);
    assert.match(client.getInstructions() ?? "", /does not read or validate Android-user identity/);
    assert.match(client.getInstructions() ?? "", /The caller decides when to check status/);
    assert.match(client.getInstructions() ?? "", /does not poll startup or recorder exit, retry commands, or reconcile racing results/);
    assert.match(client.getInstructions() ?? "", /explicit consent/);
    assert.match(client.getInstructions() ?? "", /omit it for unlimited recording until stopped/);
    assert.match(client.getInstructions() ?? "", /AOSP Android 11-13 \(API 30-33\) enforce 1-180 seconds/);
    assert.match(client.getInstructions() ?? "", /Android 14-16 \(API 34-36\) support longer\/unlimited/);
    assert.match(recording.description, /RECORDING_DURATION_UNSUPPORTED/);
    const doctor = await client.callTool({ name: "mobile_doctor", arguments: {} });
    assert.equal(doctor.isError, true);
    const doctorText = doctor.content.find((block) => block.type === "text")?.text;
    const failure = JSON.parse(doctorText);
    assert.equal(failure.error.code, "ADB_NOT_FOUND");
    assert.equal(failure.setup.stage, "platform-tools");
    assert.match(failure.setup.steps.join("\n"), /https:\/\/developer\.android\.com\/tools\/releases\/platform-tools/);
    const startup = await client.callTool({ name: "mobile_start_adb_server", arguments: {} });
    assert.equal(startup.isError, true);
    assert.equal(JSON.parse(startup.content.find((block) => block.type === "text")?.text).error.code, "ADB_NOT_FOUND");
    assert.match(stderr, /^(?:mobile-use: ADB_NOT_FOUND\r?\n){2}$/);
  });
}

test("the packaged server exits cleanly on EOF without invoking ADB", { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [path.join(artifact, "server", "index.mjs")], {
    cwd: artifact,
    env: { ...getDefaultEnvironment(), MOBILE_USE_ADB_PATH: path.join(artifact, "never-start-this-missing-adb.exe") },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data.toString(); });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});
