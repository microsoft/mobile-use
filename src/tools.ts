import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import type { MobileUseService } from "./device-session.js";
import { publicError } from "./errors.js";
import { onboardingInstructions, phoneSetup, setupForDevices, setupForError } from "./setup.js";
import { actionSchema, packageNameSchema } from "./types.js";
import type { ObservedScreen } from "./types.js";

function result(payload: unknown, image: Buffer | null = null, isError = false): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(payload) }];
  if (image) content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
  return { content, ...(isError ? { isError: true } : {}) };
}

async function safely(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    const failure = publicError(error);
    const setup = setupForError(failure.code, failure.actionMayHaveRun);
    process.stderr.write(`mobile-use: ${failure.code}\n`);
    return result({ error: failure.toJSON(), ...(setup ? { setup } : {}) }, null, true);
  }
}

function observationResult(screen: ObservedScreen): CallToolResult {
  return result({ observation: screen.observation }, screen.image);
}

export function createMobileUseServer(service: MobileUseService): McpServer {
  const server = new McpServer(
    { name: "mobile-use", version: packageInfo.version },
    { instructions: onboardingInstructions },
  );
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const targetToken = z.string().uuid();

  server.registerTool("mobile_doctor", {
    description: "Start here on first use: diagnose Windows/ADB prerequisites and return step-by-step setup guidance. Ready means host Platform-Tools only; then call mobile_list_devices before guiding missing phone setup. Guide Platform-Tools installation, Developer options, and USB/Wireless debugging only as needed. Never installs software, pairs, changes settings, lists, or controls devices.",
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => safely(async () => result({
    ...await service.doctor(ctx.mcpReq.signal), scope: "host", setup: phoneSetup,
  })));

  server.registerTool("mobile_start_adb_server", {
    description: "Only after the user explicitly approves starting the local ADB server: reuse a compatible server at 127.0.0.1:5037 or start a missing one, verify readiness, and retry read-only device discovery. The shared server may remain running after this plugin exits and may initialize standard local ADB host keys. Never kills, replaces, or restarts a server, changes settings, pairs, approves phone trust, or controls devices. Conflicts fail explicitly. Never automatically retry uncertain startup.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (_input, ctx) => safely(async () => {
    const started = await service.startAdbServer(ctx.mcpReq.signal);
    return result({ ...started, setup: setupForDevices(started.devices) });
  }));

  server.registerTool("mobile_list_devices", {
    description: "After mobile_doctor, list local ADB endpoints with online/unauthorized/offline states and the next setup steps. Empty inventory prompts Developer options/USB debugging guidance; unauthorized/offline entries need user setup. USB and Wi-Fi may be the same phone. Do not silently select a device or confuse endpoint identity with physical identity.",
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => safely(async () => {
    const devices = await service.listDevices(ctx.mcpReq.signal);
    return result({ devices, setup: setupForDevices(devices) });
  }));

  server.registerTool("mobile_select_device", {
    description: "Select exactly the endpoint the user chose from mobile_list_devices. Verify a real Android 11+ device and modern paired wireless when applicable. Does not pair or connect devices. Every selection invalidates prior target/observation tokens.",
    inputSchema: z.strictObject({ endpointId: z.string().min(1).max(512) }),
    annotations: readOnly,
  }, (input, ctx) => safely(async () => result(await service.selectDevice(input.endpointId, ctx.mcpReq.signal))));

  server.registerTool("mobile_observe", {
    description: "Read the selected device's native UI hierarchy and independently verified display geometry, optionally with a primary display PNG. includeScreenshot defaults to true; set false for hierarchy-only observation that never captures a screenshot, including subsequent mobile_act revalidation and results. Screenshot status is skipped in that mode, and coordinate taps/swipes are blocked; use elementRef taps. Unverified display state blocks input. Only observe user-approved non-sensitive content; results can be sent to the configured model service.",
    inputSchema: z.strictObject({ targetToken, includeScreenshot: z.boolean().default(true) }),
    annotations: readOnly,
  }, (input, ctx) => safely(async () => observationResult(await service.observe(input.targetToken, ctx.mcpReq.signal, input.includeScreenshot))));

  server.registerTool("mobile_wake", {
    description: "Only when explicitly requested, wake the selected phone and dismiss an unsecured lock screen. Requires a target token but no screen observation; invalidates previous observations. Never enters credentials, bypasses authentication, or captures the lock screen. Secure or unrecognized lock states require manual unlocking. After success, observe approved non-sensitive content before subsequent mobile_act input. Never automatically replay an uncertain result.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (input, ctx) => safely(async () => result(await service.wake(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_prepare_gestures", {
    description: "Only after explicit approval to upload and run the bundled gesture helper on this selected device: deploy its embedded DEX to a new private /data/local/tmp/mobile-use-gestures-* directory, make the DEX read-only, verify SHA-256, and check its input API compatibility without injecting any input. No APK, permissions, service, network connection, or daemon is installed. Files remain on the device; no automatic deletion is performed. Requires a target token, invalidates old observations, and must be repeated with fresh approval after reselection/server restart. Never automatically retry uncertain preparation. Required before double_tap, not other actions.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, ctx) => safely(async () => result(await service.prepareGestures(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_prepare_text_input", {
    description: "Only after explicit approval to upload and run the bundled Unicode text helper on this selected device: deploy its pinned read-only DEX to a new private /data/local/tmp/mobile-use-text-* directory and check UiAutomation compatibility without reading screen content or entering text.     No APK, IME change, clipboard, permissions, network service, or daemon is installed; existing accessibility services are not suppressed. Once prepared, hierarchy observations also use the hash-checked helper to preserve exact Unicode, including emoji and whitespace, without a lossy stock-dump fallback. Files remain on the device. Invalidates old observations; fresh approval/preparation is required after reselection/server restart. Never automatically deploy or replay uncertain preparation. Required for text outside the original ASCII letters/digits/space/period/comma/underscore/hyphen subset.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, ctx) => safely(async () => result(await service.prepareTextInput(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_act", {
    description: "Perform ONE explicitly authorized bounded action on the selected transport using the latest observation (consumed on attempt, expires after 30 seconds). Coordinate taps/swipes require an unchanged full-width interaction band around the target or swipe path; bounded pixel changes elsewhere are allowed only with matching app/activity/user and hierarchy context. Large screen changes, changed target pixels/controls, and geometry changes reject input. A stale-observation error is a local revalidation failure, not proof of an app security block or an ad. double_tap requires prior approved mobile_prepare_gestures; it verifies the helper hash and injects both taps in ONE Android process, checking all four injection acknowledgements. Optional integer delayMs (0-250, default 50) requests the first-UP to second-DOWN event-time interval. Scheduling can increase it; gestureTiming reports the actual injected event-time gap, not proof of recognition. No automatic helper deployment or two-process fallback. Preserve the observation's screenshot setting during revalidation and the returned observation; hierarchy-only mode never captures screenshots and rejects coordinate taps/swipes. Then verify the requested state.     Text requires one unchanged focused enabled non-password native EditText. The original ASCII subset uses ADB input. Unicode, emoji, other punctuation, tabs and line breaks require prior approved mobile_prepare_text_input and append to the end of the actual value using ACTION_SET_TEXT, without inserting placeholder text, clearing existing content, or sending Enter.     Maximum 256 UTF-16 code units per action; the helper's resulting value plus exposed label/hint is capped at 4096. Unpaired surrogates and other control characters are unsupported. Custom fields/input filters may reject text; uncertain results are never replayed. No blind batches, arbitrary shell, or endpoint fallback. Never replay uncertain input. Generic taps/keys can have consequences: installation/debugging trust is not user consent.",
    inputSchema: z.strictObject({ targetToken, observationId: z.string().uuid(), action: actionSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (input, ctx) => safely(async () => {
    const action = await service.act(input.targetToken, input.observationId, input.action, ctx.mcpReq.signal);
    return result({
      dispatchStatus: action.dispatchStatus,
      verificationStatus: action.verificationStatus,
      after: action.after?.observation ?? null,
      error: action.error,
      ...(action.gestureTiming ? { gestureTiming: action.gestureTiming } : {}),
    }, action.after?.image ?? null, action.verificationStatus === "unverified");
  }));

  server.registerTool("mobile_list_apps", {
    description: "List all installed Android packages, including system apps, for the current Android user on the explicitly selected device. Requires a target token, not a screen observation. Returns package names, not app labels. App inventory may be sensitive; use only for the user's authorized task.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: readOnly,
  }, (input, ctx) => safely(async () => result(await service.listApps(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_get_foreground_app", {
    description: "Read the foreground app's package, activity, and Android user on the selected device's primary display, without a screenshot. Requires a target token. Returns null only when Android explicitly reports no resumed activity; ambiguous or unsupported diagnostics are errors.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: readOnly,
  }, (input, ctx) => safely(async () => result({
    foregroundApp: await service.getForegroundApp(input.targetToken, ctx.mcpReq.signal),
  })));

  const appMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const packageInput = z.strictObject({ targetToken, packageName: packageNameSchema });

  server.registerTool("mobile_launch_app", {
    description: "Launch the specifically requested installed Android package for the current Android user, then verify it is in the foreground on the primary display. Requires an explicitly selected target, not a screen observation. Invalidates earlier observations and never installs an app, captures a screen, or retries an uncertain launch.",
    inputSchema: packageInput,
    annotations: appMutation,
  }, (input, ctx) => safely(async () => result(await service.launchApp(input.targetToken, input.packageName, ctx.mcpReq.signal))));

  server.registerTool("mobile_terminate_app", {
    description: "Only with specific user authorization, force-stop the requested installed Android package, including its activities and services, for the current Android user. May discard unsaved app state. Requires a selected target, not a screen observation. Verifies the package is stopped, invalidates prior observations, and never retries uncertain termination.",
    inputSchema: packageInput,
    annotations: appMutation,
  }, (input, ctx) => safely(async () => result(await service.terminateApp(input.targetToken, input.packageName, ctx.mcpReq.signal))));

  server.registerTool("mobile_install_app", {
    description: "Only after explicit approval for this APK and selected device, install one existing local .apk file for the current Android user. filePath must be an absolute Windows drive path to a regular 1-byte to 512-MiB file. No URLs, UNC paths, .ipa/.app/.zip, split bundles, automatic permission grants, downgrade flags, or automatic launch. Requires a target token, not an observation; invalidates prior observations. Bounded to 120 seconds; never retry uncertain installation.",
    inputSchema: z.strictObject({ targetToken, filePath: z.string().min(1).max(32_767) }),
    annotations: appMutation,
  }, (input, ctx) => safely(async () => result(await service.installApp(input.targetToken, input.filePath, ctx.mcpReq.signal))));

  server.registerTool("mobile_uninstall_app", {
    description: "Only after explicit approval naming this package and selected device, uninstall an Android app for the current Android user and delete that user's app data. Other Android users are not targeted. Verifies package removal, invalidates prior observations, and never retries uncertain deletion or bypasses protected-app/device policy. Requires a target token, not a screen observation.",
    inputSchema: packageInput,
    annotations: appMutation,
  }, (input, ctx) => safely(async () => result(await service.uninstallApp(input.targetToken, input.packageName, ctx.mcpReq.signal))));

  server.server.onclose = () => service.stop();
  return server;
}
