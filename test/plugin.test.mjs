import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, "plugins", "mobile-use");
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
  const logo = manifest.extensions?.["com.github.copilot"]?.logo;
  assert.equal(logo, "assets/mobile-use.png");
  const image = await readFile(path.join(artifact, ...logo.split("/")));
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
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
  assert.match(skill, /call \*\*`mobile_start_adb_server`\*\* without a separate conversational\s+approval question/);
  assert.doesNotMatch(skill, /ADB server without specific approval|Only after approval, call `mobile_start_adb_server`|ADB startup and wake need their own exact explicit authorization/);
  assert.match(skill, /Doctor and inventory never invoke startup/);
  assert.match(skill, /sole `selectable: true`\s+endpoint without a selection question/);
  assert.match(skill, /With multiple selectable endpoints, ask unless the choice is already clear/);
  assert.match(skill, /Honor specified devices\/connections; never substitute an unavailable target/);
  assert.doesNotMatch(skill, /Ask the user which endpoint to use if their choice is not already explicit/);
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
  assert.match(skill, /Permission for a task on the selected Android phone covers waking and\s+dismissing a verified unsecured lock screen/);
  assert.match(skill, /no separate\s+wake-specific request or conversational approval is needed/);
  assert.match(skill, /before asking the user to wake or dismiss an unsecured lock\s+screen manually/);
  assert.doesNotMatch(skill, /Wake needs its own exact explicit authorization|Only when the user explicitly requests waking/);
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
  const fallbackLicense = await readFile(
    path.join(root, "third_party", "npm-licenses", "@nodable", "entities", "3.1.0", "LICENSE"), "utf8",
  );
  assert.ok(notices.includes(fallbackLicense.replace(/\r\n/g, "\n")), "Preserve the complete fallback license text in notices.");
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

test("the artifact includes complete embedded dependency notices using source-only audit records", async () => {
  const dependencies = [
    { name: "ajv", version: "8.18.0", license: "MIT", copyright: "2015-2021 Evgeny Poberezkin" },
    { name: "ajv-formats", version: "3.0.1", license: "MIT", copyright: "2020 Evgeny Poberezkin" },
    { name: "content-type", version: "1.0.5", license: "MIT", copyright: "2015 Douglas Christopher Wilson" },
    { name: "fast-deep-equal", version: "3.1.3", license: "MIT", copyright: "2017 Evgeny Poberezkin" },
    { name: "fast-uri", version: "3.1.0", license: "BSD-3-Clause", copyright: "2021-present The Fastify team" },
    { name: "json-schema-traverse", version: "1.0.0", license: "MIT", copyright: "2017 Evgeny Poberezkin" },
  ];
  const auditRelative = path.join("npm-licenses", "@modelcontextprotocol", "server", "2.3.1");
  assert.deepEqual(
    await json(path.join(root, "third_party", auditRelative, "embedded-dependencies.json")),
    dependencies.map(({ name, version, license }) => ({ name, version, license })),
  );
  assert.match(
    await readFile(path.join(root, "third_party", auditRelative, "PROVENANCE"), "utf8"),
    /Published npm tarball integrity:\r?\nsha512-/,
  );
  const notices = await readFile(path.join(artifact, "THIRD_PARTY_NOTICES"), "utf8");
  for (const dependency of dependencies) {
    const relative = path.join("npm-licenses", dependency.name, dependency.version);
    const license = await readFile(path.join(root, "third_party", relative, "LICENSE"), "utf8");
    const provenance = await readFile(path.join(root, "third_party", relative, "PROVENANCE"), "utf8");
    assert.ok(notices.includes(`=== ${dependency.name}@${dependency.version} (${dependency.license}) ===`));
    assert.ok(notices.includes(license.replace(/\r\n/g, "\n")), `${dependency.name}: preserve the complete license text in notices.`);
    assert.ok(license.includes(dependency.copyright));
    assert.match(provenance, /Published package gitHead: [0-9a-f]{40}\r?\n/);
    assert.match(provenance, /https:\/\/github\.com\/.+\/blob\/[0-9a-f]{40}\/LICENSE/);
  }
  await assert.rejects(stat(path.join(artifact, "licenses")), { code: "ENOENT" });
});

test("the checked-in plugin matches a fresh build", async () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-plugin.mjs"), "--check"], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
});

test("plugin generation preserves authored files and detects stale assets without rewriting them", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "mobile-use build with spaces "));
  t.after(() => rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(path.join(fixture, "scripts"));
  await cp(path.join(root, "scripts", "build-plugin.mjs"), path.join(fixture, "scripts", "build-plugin.mjs"));
  for (const relative of ["src", "third_party", "plugins", "package.json", "LICENSE", "THIRD_PARTY_NOTICES"]) {
    await cp(path.join(root, relative), path.join(fixture, relative), { recursive: true });
  }
  await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  for (const relative of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
    const file = path.join(fixture, relative);
    await writeFile(file, (await readFile(file, "utf8")).replace(/\r?\n/g, "\r\n"));
  }

  const published = path.join(fixture, "plugins", "mobile-use");
  const scripts = (await json(path.join(fixture, "package.json"))).scripts;
  assert.equal(scripts["build:plugin"], scripts["build:marketplace"]);
  const authoredPaths = [
    "plugin.json", "mcp.json", path.join("assets", "mobile-use.png"),
    path.join("skills", "mobile-use", "SKILL.md"),
    path.join("skills", "mobile-use", "references", "screen-recording.md"),
  ];
  const authored = await Promise.all(authoredPaths.map((relative) => readFile(path.join(published, relative))));
  for (const relative of ["server", "licenses"]) {
    await mkdir(path.join(published, relative), { recursive: true });
    await writeFile(path.join(published, relative, "stale-build-probe.txt"), "stale\n", { flag: "wx" });
  }
  const runBuild = (args, expectedError) => {
    const result = spawnSync(process.execPath, [path.join(fixture, "scripts", "build-plugin.mjs"), ...args], {
      cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 120_000,
    });
    if (expectedError) {
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, "The build or consistency check must fail.");
      assert.match(result.stderr, expectedError);
      return;
    }
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  };

  runBuild(["--check"], /Plugin package is out of date/);
  for (const relative of ["server", "licenses"]) {
    assert.equal(await readFile(path.join(published, relative, "stale-build-probe.txt"), "utf8"), "stale\n");
  }
  runBuild([]);
  for (const [index, relative] of authoredPaths.entries()) {
    assert.deepEqual(await readFile(path.join(published, relative)), authored[index], `${relative} must not be rewritten.`);
  }
  for (const relative of ["server", "licenses"]) {
    await assert.rejects(stat(path.join(published, relative, "stale-build-probe.txt")), { code: "ENOENT" });
  }
  await assert.rejects(stat(path.join(published, "licenses")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(fixture, "dist")), { code: "ENOENT" });
  for (const relative of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
    assert.doesNotMatch(await readFile(path.join(published, relative), "utf8"), /\r\n/);
  }
  runBuild(["--check"]);

  const logoPath = path.join(published, "assets", "mobile-use.png");
  const logo = await readFile(logoPath);
  await rm(logoPath);
  runBuild(["--check"], /Plugin artifact is incomplete: assets[\\/]mobile-use\.png/);
  await writeFile(logoPath, logo);
  runBuild(["--check"]);

  const bundlePath = path.join(published, "server", "index.mjs");
  const bundle = await readFile(bundlePath);
  for (const relative of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
    assert.deepEqual(await readFile(path.join(published, relative)), await readFile(path.join(artifact, relative)));
  }
  const sourcePath = path.join(fixture, "src", "index.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, `${source}\nconsole.error("fixture source change");\n`);
  runBuild(["--check"], /server[\\/]index\.mjs/);
  assert.deepEqual(await readFile(bundlePath), bundle);
  await writeFile(sourcePath, source);
  runBuild(["--check"]);

  await writeFile(bundlePath, "stale bundle\n");
  runBuild(["--check"], /server[\\/]index\.mjs/);
  assert.equal(await readFile(bundlePath, "utf8"), "stale bundle\n");
  runBuild(["--marketplace"]);
  assert.deepEqual(await readFile(bundlePath), bundle);
  runBuild(["--check"]);

  const publishedNotices = await readFile(path.join(published, "THIRD_PARTY_NOTICES"));
  const publishedLicense = await readFile(path.join(published, "LICENSE"));
  for (const [relative, expectedError] of [
    [path.join("@modelcontextprotocol", "server", "2.3.1", "embedded-dependencies.json"),
      /Embedded dependency audit\/provenance missing for @modelcontextprotocol\/server@2\.3\.1/],
    [path.join("@modelcontextprotocol", "server", "2.3.1", "PROVENANCE"),
      /Embedded dependency audit\/provenance missing for @modelcontextprotocol\/server@2\.3\.1/],
    [path.join("ajv", "8.18.0", "LICENSE"), /License\/provenance missing for embedded dependency ajv@8\.18\.0/],
    [path.join("fast-uri", "3.1.0", "PROVENANCE"), /License\/provenance missing for embedded dependency fast-uri@3\.1\.0/],
  ]) {
    const file = path.join(fixture, "third_party", "npm-licenses", relative);
    const original = await readFile(file);
    await rm(file);
    runBuild([], expectedError);
    assert.deepEqual(await readFile(path.join(published, "THIRD_PARTY_NOTICES")), publishedNotices);
    assert.deepEqual(await readFile(path.join(published, "LICENSE")), publishedLicense);
    assert.deepEqual(await readFile(bundlePath), bundle);
    await writeFile(file, original);
  }
});

for (const mode of ["legacy", "auto"]) {
  test(`copied plugin starts without node_modules over ${mode} MCP negotiation`, async (t) => {
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
    assert.match(client.getInstructions() ?? "", /sole endpoint with selectable: true for initial selection without asking a selection question/);
    assert.match(client.getInstructions() ?? "", /no separate wake-specific request or conversational approval is needed/);
    if (mode === "auto") assert.ok(client.getDiscoverResult(), "modern discover negotiation must actually succeed");
    if (mode === "legacy") await client.ping();
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "mobile_app_management", "mobile_doctor", "mobile_input_text", "mobile_list_devices",
      "mobile_observe", "mobile_press_key", "mobile_screen_recording", "mobile_select_device", "mobile_start_adb_server",
      "mobile_swipe", "mobile_tap", "mobile_wake",
    ]);
    assert.ok(tools.tools.every((tool) => typeof tool.title === "string" && tool.title.length > 0));
    for (const name of ["mobile_list_devices", "mobile_select_device"]) {
      const description = tools.tools.find((tool) => tool.name === name)?.description ?? "";
      assert.match(description, /sole endpoint with selectable: true for initial selection without asking a selection question/);
      assert.match(description, /Honor any user-specified device or connection/);
    }
    const wake = tools.tools.find((tool) => tool.name === "mobile_wake");
    assert.match(wake?.description ?? "", /Task permission covers this preparation; no separate wake-specific request or conversational approval is needed/);
    assert.match(wake?.description ?? "", /MANUAL_UNLOCK_REQUIRED requires user authentication/);
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

for (const runtime of ["external", "managed"]) {
  test(`copied plugin starts the experimental ${runtime} iOS adapter`, async (t) => {
    const copied = await mkdtemp(path.join(tmpdir(), "mobile-use ios plugin with spaces "));
    let client;
    t.after(async () => {
      try {
        await client?.close();
      } finally {
        await rm(copied, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
    await cp(artifact, copied, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(copied, "server", "index.mjs")],
      cwd: copied,
      env: {
        ...getDefaultEnvironment(),
        MOBILE_USE_PLATFORM: "ios",
        MOBILE_USE_IOS_RUNTIME: runtime,
        ...(runtime === "external"
          ? { MOBILE_USE_WDA_URL: "http://127.0.0.1:1" }
          : { MOBILE_USE_IOS_RUNNER_BUNDLE_ID: "example.runner.xctrunner" }),
      },
      stderr: "pipe",
    });
    client = new Client(
      { name: "mobile-use-ios-package-check", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    assert.match(client.getInstructions() ?? "", /server is in iOS mode/);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some((tool) => tool.name === "mobile_ios_runtime"), runtime === "managed");
    assert.ok(tools.some((tool) => tool.name === "mobile_observe"));
    const wake = tools.find((tool) => tool.name === "mobile_wake");
    assert.match(wake?.description ?? "", /Unsupported in iOS mode.*Android-only/);
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
