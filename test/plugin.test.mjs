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
  assert.match(skill, /^---\r?\nname: mobile-use\r?\ndescription: /);
  assert.match(skill, /## First-use setup \(required\)/);
  assert.match(skill, /Only \*\*Android SDK Platform-Tools\*\* is required/);
  assert.match(skill, /Developer options/);
  assert.match(skill, /permission to call \*\*`mobile_start_adb_server`\*\*/);
  assert.match(skill, /Doctor and inventory never invoke startup/);
  assert.match(skill, /includeScreenshot: false/);
  assert.match(skill, /Hierarchy-only actions never\s+capture screenshots/);
  assert.match(skill, /kind: "double_tap"/);
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

for (const mode of ["legacy", "auto"]) {
  test(`copied artifact starts without node_modules over ${mode} MCP negotiation`, async (t) => {
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
    await cp(artifact, copied, { recursive: true });
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
      "mobile_act", "mobile_doctor", "mobile_get_foreground_app", "mobile_install_app",
      "mobile_launch_app", "mobile_list_apps", "mobile_list_devices", "mobile_observe",
      "mobile_select_device", "mobile_start_adb_server", "mobile_terminate_app", "mobile_uninstall_app", "mobile_wake",
    ]);
    const observe = tools.tools.find((tool) => tool.name === "mobile_observe");
    assert.deepEqual(observe?.inputSchema.required, ["targetToken"]);
    assert.equal(observe?.inputSchema.properties?.includeScreenshot?.type, "boolean");
    assert.equal(observe?.inputSchema.properties?.includeScreenshot?.default, true);
    const act = tools.tools.find((tool) => tool.name === "mobile_act");
    const actions = act?.inputSchema.properties?.action?.oneOf;
    assert.ok(Array.isArray(actions));
    const doubleTap = actions.find((action) => action.properties?.kind?.const === "double_tap");
    assert.ok(doubleTap, "the bundled action schema must expose double_tap");
    assert.deepEqual(doubleTap.required, ["kind", "target"]);
    const doctor = await client.callTool({ name: "mobile_doctor", arguments: {} });
    assert.equal(doctor.isError, true);
    const text = doctor.content.find((block) => block.type === "text")?.text;
    const failure = JSON.parse(text);
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
