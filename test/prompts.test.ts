import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SESSION_CONSENT_CHOICES,
  androidPromptPack,
  buildAndroidSelectDeviceSetup,
  buildIosSelectDeviceSetup,
  buildMultiPlatformSelectDeviceSetup,
  iosExternalPromptPack,
  iosManagedPromptPack,
  iosSetup,
  iosSharedSafetyInstructions,
  managedIosSetup,
  multiPlatformHostSetup,
  multiPlatformPromptPack,
  type CoreToolName,
} from "../src/prompts/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const coreToolNames: readonly CoreToolName[] = [
  "mobile_doctor",
  "mobile_start_adb_server",
  "mobile_list_devices",
  "mobile_select_device",
  "mobile_wake",
  "mobile_observe",
  "mobile_tap",
  "mobile_swipe",
  "mobile_press_key",
  "mobile_input_text",
  "mobile_screen_recording",
  "mobile_app_management",
];

test("prompt packs define complete tool metadata and runtime-specific tool gating", () => {
  const packs = [
    ["android", androidPromptPack],
    ["ios-external", iosExternalPromptPack],
    ["ios-managed", iosManagedPromptPack],
    ["multi-platform", multiPlatformPromptPack],
  ] as const;

  for (const [label, pack] of packs) {
    assert.ok(pack.instructions.length > 0);
    for (const name of coreToolNames) {
      const prompt = pack.tools[name];
      assert.ok(prompt.title.length > 0, `${label} missing title for ${name}`);
      assert.ok(prompt.description.length > 0, `${label} missing description for ${name}`);
    }
  }

  assert.equal("mobile_ios_runtime" in androidPromptPack.tools, false);
  assert.equal("mobile_ios_runtime" in iosExternalPromptPack.tools, false);
  assert.ok(iosManagedPromptPack.tools.mobile_ios_runtime.description.includes("confirm_trust"));
  assert.ok(multiPlatformPromptPack.tools.mobile_ios_runtime.description.includes("confirm_trust"));
});

test("multi-platform prompt pack replaces unsupported-mode stubs with simultaneous Android and iOS contracts", () => {
  assert.match(multiPlatformPromptPack.instructions, /Android 11\+ and iOS 17\+/);
  assert.match(multiPlatformPromptPack.instructions, /On Android targets only/);
  assert.match(multiPlatformPromptPack.instructions, /On iOS targets, enforce the stricter iOS safety boundary/);
  assert.ok(
    multiPlatformPromptPack.instructions.includes(iosSharedSafetyInstructions),
    "multi-platform instructions must preserve iosSharedSafetyInstructions for iOS targets",
  );
  for (const choice of SESSION_CONSENT_CHOICES) {
    assert.ok(
      multiPlatformPromptPack.instructions.includes(choice),
      `multi-platform instructions missing consent choice: ${choice}`,
    );
  }
  for (const name of coreToolNames) {
    assert.doesNotMatch(
      multiPlatformPromptPack.tools[name].description,
      /Unsupported in iOS mode/,
      `multi-platform ${name} must not advertise single-platform iOS mode stubs`,
    );
  }
});

test("android prompt modules remain free of iOS imports and iOS-specific runtime terminology", async () => {
  assert.doesNotMatch(androidPromptPack.instructions, /WebDriverAgent|MOBILE_USE_WDA_URL|go-ios|\bWDA\b/);
  for (const name of coreToolNames) {
    assert.doesNotMatch(
      androidPromptPack.tools[name].description,
      /WebDriverAgent|MOBILE_USE_WDA_URL|go-ios|\bWDA\b/,
      `android ${name} must not contain iOS runtime copy`,
    );
  }

  const androidOnlyFiles = [
    path.join(root, "src", "prompts", "contracts.ts"),
    path.join(root, "src", "prompts", "shared", "consent.ts"),
    ...(await readdir(path.join(root, "src", "prompts", "android"))).map((entry) =>
      path.join(root, "src", "prompts", "android", entry),
    ),
  ];
  for (const file of androidOnlyFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:\/ios\/|\/multi-platform\/)/,
      `${path.relative(root, file)} must not import iOS or multi-platform modules`,
    );
  }

  const bundleResult = await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src", "prompts", "android", "tools.ts")],
    write: false,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    metafile: true,
    logLevel: "silent",
  });
  for (const input of Object.keys(bundleResult.metafile.inputs)) {
    const normalized = input.replace(/\\/g, "/");
    assert.doesNotMatch(
      normalized,
      /(?:^|\/)src\/prompts\/(?:ios|multi-platform)\//,
      `Android prompt bundle must not include ${normalized}`,
    );
  }
  const bundledCode = bundleResult.outputFiles[0]?.text ?? "";
  assert.doesNotMatch(
    bundledCode,
    /WebDriverAgent|MOBILE_USE_WDA_URL|go-ios|\bWDA\b|iosSharedSafetyInstructions|Authenticate manually; never observe authentication screens/,
  );
});

test("select-device setup builders return fresh single vs multi-endpoint guidance", () => {
  const androidSingle = buildAndroidSelectDeviceSetup(1);
  const androidMulti = buildAndroidSelectDeviceSetup(2);
  assert.equal(androidSingle.stage, "select-device");
  assert.equal(androidMulti.stage, "select-device");
  assert.notEqual(androidSingle.steps[1], androidMulti.steps[1]);

  const iosExternalStepsBefore = [...iosSetup.steps];
  const iosManagedStepsBefore = [...managedIosSetup.steps];
  const iosExternalSelect = buildIosSelectDeviceSetup(false);
  const iosManagedSelect = buildIosSelectDeviceSetup(true);
  assert.match(iosExternalSelect.steps[0] ?? "", /configured WDA endpoint/);
  assert.match(iosManagedSelect.steps[0] ?? "", /USB UDIDs/);
  assert.deepEqual(iosSetup.steps, iosExternalStepsBefore);
  assert.deepEqual(managedIosSetup.steps, iosManagedStepsBefore);

  const multiHostStepsBefore = [...multiPlatformHostSetup.steps];
  const multiSingle = buildMultiPlatformSelectDeviceSetup(1);
  const multiMultiple = buildMultiPlatformSelectDeviceSetup(3);
  assert.match(multiSingle.steps[1] ?? "", /Only one endpoint is currently selectable/);
  assert.match(multiMultiple.steps[1] ?? "", /Multiple endpoints are selectable/);
  assert.deepEqual(multiPlatformHostSetup.steps, multiHostStepsBefore);
});
