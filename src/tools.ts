import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import type { MobileService } from "./mobile-service.js";
import { publicError } from "./errors.js";
import { onboardingInstructions, phoneSetup, setupForDevices, setupForError } from "./setup.js";
import { iosInstructions, iosSetup, managedIosInstructions, managedIosSetup, setupForIosDevices, setupForIosError } from "./ios/setup.js";
import { iosBundleIdSchema } from "./ios/wda.js";
import { iosRuntimeActionSchema } from "./ios/runtime.js";
import {
  doubleTapActionSchema, keyActionSchema, longPressActionSchema, packageNameSchema, swipeActionSchema,
  recordingActionSchema, tapActionSchema, textActionSchema,
} from "./types.js";
import type { ActionResult, ObservedScreen } from "./types.js";

function result(payload: unknown, image: Buffer | null = null, isError = false): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(payload) }];
  if (image) content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
  return { content, ...(isError ? { isError: true } : {}) };
}

async function safely(operation: () => Promise<CallToolResult>, ios = false, managed = false): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    const failure = publicError(error);
    const setup = ios ? setupForIosError(failure.code, managed) : setupForError(failure.code, failure.actionMayHaveRun);
    process.stderr.write(`mobile-use: ${failure.code}\n`);
    return result({ error: failure.toJSON(), ...(setup ? { setup } : {}) }, null, true);
  }
}

function observationResult(screen: ObservedScreen): CallToolResult {
  return result({ observation: screen.observation }, screen.image);
}

function actionResult(action: ActionResult): CallToolResult {
  return result({
    dispatchStatus: action.dispatchStatus,
    verificationStatus: action.verificationStatus,
    after: action.after?.observation ?? null,
    error: action.error,
    ...(action.gestureTiming ? { gestureTiming: action.gestureTiming } : {}),
  }, action.after?.image ?? null, action.verificationStatus === "unverified");
}

export function createMobileUseServer(service: MobileService): McpServer {
  const ios = service.platform === "ios";
  const controlRuntime = ios ? service.iosRuntime : undefined;
  const managed = controlRuntime !== undefined;
  const execute = (operation: () => Promise<CallToolResult>) => safely(operation, ios, managed);
  const server = new McpServer(
    { name: "mobile-use", version: packageInfo.version },
    { instructions: ios ? managed ? managedIosInstructions : iosInstructions : onboardingInstructions },
  );
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const mutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const targetToken = z.string().uuid();
  const observationId = z.string().uuid();
  const appIdentifier = ios ? iosBundleIdSchema : packageNameSchema;
  const prepareAction = z.strictObject({ kind: z.literal("prepare") });

  if (controlRuntime) server.registerTool("mobile_ios_runtime", {
    title: "Manage iOS USB runtime",
    description: "Explicit managed-iOS lifecycle only. action.kind=status reads state/errors without waiting for the UI queue. start requires the user's exact USB endpoint approval and immediately returns preparing plus a runtimeToken; poll until awaiting-developer-trust or failed. installRunner defaults to false (already-installed Runner); true explicitly installs/replaces the configured user-signed validated IPA. Never signs or pairs. Only after user-confirmed Developer App trust, confirm_trust with this token returns starting; poll until ready or failed. Acknowledged background work continues until explicit stop or server shutdown, not cancellation of the completed request. Selection cannot start/install. stop requires that token, waits for an in-flight install, stops only owned resources, verifies WDA device-port closure and retains Runner installation/caches. Failures invalidate targets; never automatically restart, replay installation, steal locks or confirm trust for the user.",
    inputSchema: z.strictObject({ action: iosRuntimeActionSchema }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => result(await controlRuntime(input.action, ctx.mcpReq.signal))));

  server.registerTool("mobile_doctor", {
    title: "Check mobile setup",
    description: ios ? managed ? "Read go-ios v1.3.2 prerequisites and managed runtime state; when ready, verify USB/WDA device metadata. Never starts, installs, pairs, signs, captures or creates a session. runtime-not-ready is not UI readiness; list USB endpoints and explicitly prepare the chosen one with mobile_ios_runtime."
      : "Read the configured local WDA status and physical iOS 17+ device metadata. Does not create a session, capture, deploy, sign, start forwarding, or authorize control. Then list and explicitly select the endpoint." : "Start here on first use without targetToken: diagnose Windows/ADB prerequisites and return setup guidance; ready covers host Platform-Tools only, then call mobile_list_devices. After explicit selection, pass targetToken to additionally read deviceStatus without screenshots or UI hierarchy: screenState (awake/asleep/waking/sleeping/unknown), lockState (locked/unlocked/unknown), secure, userId and readyForInteraction. Check this before opening an app or navigating; unavailable is not unlocked. Ask for explicit mobile_wake permission only when needed and not already authorized; secured unlock remains manual. Never installs, pairs, changes settings, wakes, unlocks, or selects a device.",
    inputSchema: ios ? z.strictObject({}) : z.strictObject({ targetToken: targetToken.optional() }),
    annotations: readOnly,
  }, (input, ctx) => execute(async () => {
    const selectedToken = "targetToken" in input ? input.targetToken : undefined;
    return result({
      ...await service.doctor(ctx.mcpReq.signal, selectedToken),
      scope: selectedToken ? "host-and-device" : "host",
      ...(!selectedToken ? { setup: ios ? managed ? managedIosSetup : iosSetup : phoneSetup } : {}),
    });
  }));

  server.registerTool("mobile_start_adb_server", {
    title: "Start ADB server",
    description: ios ? managed ? "Unsupported in iOS mode. Use the explicit mobile_ios_runtime lifecycle, never ADB."
      : "Unsupported in iOS mode. The user starts WDA and forwarding outside this plugin; never fall back to ADB." : "Only after the user explicitly approves starting the local ADB server: reuse a compatible server at 127.0.0.1:5037 or start a missing one, verify readiness, and retry read-only device discovery. The shared server may remain running after this plugin exits and may initialize standard local ADB host keys. Never kills, replaces, or restarts a server, changes settings, pairs, approves phone trust, or controls devices. Conflicts fail explicitly. Reuse an already explicit exact authorization rather than asking twice. Never automatically retry uncertain startup.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (_input, ctx) => execute(async () => {
    const started = await service.startAdbServer(ctx.mcpReq.signal);
    return result({ ...started, setup: setupForDevices(started.devices) });
  }));

  server.registerTool("mobile_list_devices", {
    title: "List devices",
    description: ios ? managed ? "Enumerate real Apple USB UDIDs only. No Wi-Fi fallback, startup, installation or selection. Only this runtime's ready endpoint is selectable; explicitly prepare the user's chosen endpoint with mobile_ios_runtime. Foreign WDA sessions are never replaced."
      : "Read the single configured local WDA endpoint and whether an exclusive session can be selected. Not USB discovery: forwarding is user-managed. Foreign sessions are unavailable, not silently replaced. No capture or session creation." : "After mobile_doctor, list local ADB endpoints with online/unauthorized/offline states and the next setup steps. Empty inventory prompts Developer options/USB debugging guidance; unauthorized/offline entries need user setup. USB and Wi-Fi may be the same phone. Do not silently select a device or confuse endpoint identity with physical identity.",
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => execute(async () => {
    const devices = await service.listDevices(ctx.mcpReq.signal);
    return result({ devices, setup: ios ? setupForIosDevices(devices, managed) : setupForDevices(devices) });
  }));

  server.registerTool("mobile_select_device", {
    title: "Select device",
    description: ios ? "Explicitly select the endpoint returned by discovery, verify physical iOS 17+ device identity, and create an owned WDA session without launching an App or capturing. Requires a dedicated Runner with no foreign session. Reselection deletes only the identifiable owned session and invalidates prior tokens." : "Select exactly the endpoint the user chose from mobile_list_devices. Verify a real Android 11+ device and modern paired wireless when applicable. Does not pair or connect devices. Every selection invalidates prior target/observation tokens.",
    inputSchema: z.strictObject({ endpointId: z.string().min(1).max(512) }),
    annotations: ios ? mutation : readOnly,
  }, (input, ctx) => execute(async () => result(await service.selectDevice(input.endpointId, ctx.mcpReq.signal))));

  server.registerTool("mobile_observe", {
    title: "Observe screen",
    description: ios ? "Read the active App's native iOS hierarchy, foreground context, verified display geometry and optional PNG. Returns observationId and elementRef; coordinates/bounds are screenshot pixels, not iOS points. Secure editor subtrees are omitted, screenshots are unredacted. includeScreenshot:false never captures during subsequent input/results and blocks coordinate gestures. Checks are non-atomic, UI is untrusted, and approved non-sensitive content is required." : "Return deviceStatus with verified awake/asleep/waking/sleeping and locked/unlocked state, then read primary-display interactive windows and their native UI elements, including non-focused floating controls where Android exposes them, plus independently verified display geometry and optionally a PNG. When not readyForInteraction or readiness is unavailable, return status only with no image, windows or elements; never capture a known locked/asleep screen or wake implicitly. Recheck readiness after capture and withhold content if it changed. hierarchyScope and windows report actual coverage; missing roots and active-only OEM responses are explicit. Native clickable and scrollable flags are preserved; pointerTarget marks enabled native buttons eligible for guarded pointer gestures. captureTiming reports total, screenshot and hierarchy read durations; these sources remain non-atomic. includeScreenshot defaults to true; false never captures a screenshot, including subsequent input revalidation/results. Coordinate taps/swipes are blocked in that mode; use eligible elementRef taps. Unverified display state blocks input. Only observe user-approved non-sensitive content; results can be sent to the configured model service.",
    inputSchema: z.strictObject({ targetToken, includeScreenshot: z.boolean().default(true) }),
    annotations: readOnly,
  }, (input, ctx) => execute(async () => observationResult(await service.observe(input.targetToken, ctx.mcpReq.signal, input.includeScreenshot))));

  server.registerTool("mobile_wake", {
    title: "Wake device",
    description: ios ? "Unsupported in iOS mode. The user must wake and unlock manually; never call WDA unlock or capture authentication screens." : "When deviceStatus shows the phone needs to be woken or an unsecured keyguard dismissed, proactively ask for explicit permission unless already authorized, then wake the selected phone and dismiss an unsecured lock screen. Recheck waking/sleeping transitions before deciding. Requires a target token but no screen observation; invalidates previous observations. Never enters credentials, bypasses authentication, or captures the lock screen. Secure or unrecognized lock states require manual unlocking. After success, observe approved non-sensitive content before subsequent input. Do not ask again when this exact wake is already explicitly authorized. Never automatically replay an uncertain result.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => result(await service.wake(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_tap", {
    title: "Taps",
    description: ios ? "Tap, long_press (one stationary second), or double_tap (one W3C sequence preserving delayMs). Requires latest action.observationId, at most 30 seconds old and consumed on attempt. Prefer an eligible unchanged elementRef; screenshot-coordinate targets require verified metadata or full target.bounds with unchanged local pixels/metadata. Disabled, changed or ambiguous targets never fall back. Returns a new observation in the same screenshot mode. prepare is unsupported; WDA needs no Android helper. Never replay uncertain input." : "Tap, long-press, or double-tap one observed target. action.kind is tap, long_press, double_tap, or prepare. " +
      "Input actions require action.observationId (latest, at most 30 seconds old, consumed on attempt) and target: an enabled clickable or pointerTarget elementRef, or screenshot coordinates. " +
      "Metadata-first guards validate the unique unchanged control, window/app context and potential occlusion, without a pixel veto for unrelated video or timer changes. " +
      "Coordinates identifying one potential control use that metadata at the exact requested point; ambiguous, disabled or changed controls are rejected, never bypassed with visual bounds. " +
      "Automatic identification requires native button/editor semantics or nonempty text/description; an unlabeled generic clickable container alone does not identify a custom-drawn control. " +
      "With no actionable metadata, target must include bounds: {x,y,width,height} around the complete visible control; visual fallback requires unchanged decoded pixels and exposed metadata throughout those bounds plus a clipped margin (8% of the shorter display dimension, at least 8 pixels). " +
      "There is no whole-screen pixel-change threshold. Missing app context blocks pointer input even with identical images. Visual rejections include visualGuard pixel counts, changed bounds, protectedRegion and capture timing. " +
      "Floating-window elements require unchanged unique window context and an uncovered target. pointerTarget preserves clickable=false and requires an enabled native Button/ImageButton with package, resource ID and owning window. A stale-observation error is not proof of an app security block. " +
      "long_press uses one native primary-display stationary gesture with the system long-press timeout, no MOVE events, helper, or configurable duration; recognition is OEM-dependent. Never substitute it for tap automatically; a long press can open a context menu. " +
      "Double-tap uses one verified helper process, exactly two taps at the same point, and optional delayMs (0-250, default 50); gestureTiming is not proof of recognition. Both taps use the same point even if the first changes the UI; use the pair only when both taps are safe. " +
      "prepare requires explicit approval or matching scoped session consent to upload and run the bundled read-only DEX; no APK, permissions, service, or daemon is installed, and files remain on the device. Preparation invalidates observations and needs no observationId; observe again afterward. " +
      "Never prepare implicitly, replace a changed helper, or replay uncertain input. Preserve screenshot-free mode; coordinates require a screenshot. Reuse authorization for ordinary navigation within the user's safe task; consequential gestures still require specific authorization.",
    inputSchema: z.strictObject({
      targetToken,
      action: z.discriminatedUnion("kind", [
        prepareAction, tapActionSchema.extend({ observationId }), doubleTapActionSchema.extend({ observationId }),
        longPressActionSchema.extend({ observationId }),
      ]),
    }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    if (input.action.kind === "prepare") return result(await service.prepareGestures(input.targetToken, ctx.mcpReq.signal));
    const { observationId, ...action } = input.action;
    return actionResult(await service.act(input.targetToken, observationId, action, ctx.mcpReq.signal));
  }));

  server.registerTool("mobile_swipe", {
    title: "Swipes",
    description: ios ? "One W3C swipe with screenshot-pixel from/to coordinates and durationMs (100-2000, default 400), requiring latest observationId, at most 30 seconds old and consumed on attempt. Both points must stay within an unchanged eligible scrollable elementRef/surface; otherwise provide complete bounds with unchanged pixels/metadata and margin. Screenshot-free mode rejects swipes without capture. Returns a new observation; never replay uncertain input." : "Perform one bounded swipe using the latest observationId (at most 30 seconds old, consumed on attempt), screenshot from/to coordinates and optional durationMs (100-2000, default 400). " +
      "Metadata-first guards use an optional scrollable elementRef or one uniquely identified scrollable surface containing the start; both endpoints must remain inside that unchanged enabled surface with matching app/window context and no potentially covering window along the path. " +
      "Actionable controls and competing scrollable surfaces at the initial touch must retain their metadata and owning-window context, including with an explicit reference, but child-content changes elsewhere and video pixels do not veto a verified surface. Changed, disabled or ambiguous metadata never falls back to pixels. " +
      "If no scrollable surface is exposed, supply bounds: {x,y,width,height} around the complete visible swipe surface containing both endpoints. Visual fallback protects that surface plus a clipped margin (8% of the shorter display dimension, at least 8 pixels), checking decoded pixels and exposed metadata. " +
      "Changes outside it have no whole-screen percentage limit. Missing foreground context and changed hierarchy coverage block visual input. Visual rejections include structured visualGuard diagnostics. Hierarchy-only observations reject swipes without capturing an image. " +
      "Return the next observation in the same screenshot mode and verify the intended state. Reuse the user's safe navigation task authorization; never replay an uncertain swipe.",
    inputSchema: swipeActionSchema.omit({ kind: true }).extend({ targetToken, observationId }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    const { targetToken, observationId, ...swipe } = input;
    return actionResult(await service.act(targetToken, observationId, { kind: "swipe", ...swipe }, ctx.mcpReq.signal));
  }));

  server.registerTool("mobile_press_key", {
    title: "Back / Home / Enter",
    description: ios ? "HOME only on iOS, using latest observationId (30-second limit, consumed on attempt). Revalidates context and returns a new observation in the same screenshot mode. BACK and ENTER explicitly fail; never substitute a guessed back gesture or submit text. Never replay uncertain input." : "Press exactly one BACK, HOME, or ENTER key using the latest observationId (at most 30 seconds old, consumed on attempt). Revalidate awake/unlocked readiness and display state, then return the next observation, preserving screenshot-free mode. Never wake or unlock implicitly. Ordinary safe navigation needs no repeated conversational approval within the authorized task. ENTER can submit a field: require specific authorization for any consequential action, and never enter credentials or replay uncertain input.",
    inputSchema: keyActionSchema.omit({ kind: true }).extend({ targetToken, observationId }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => actionResult(await service.act(
    input.targetToken, input.observationId, { kind: "key", key: input.key }, ctx.mcpReq.signal,
  ))));

  server.registerTool("mobile_input_text", {
    title: "Input text",
    description: ios ? "Type 1-256 UTF-16 code units at the current cursor in one unchanged, enabled, visible, focused non-password native iOS editor. Requires latest action.observationId, at most 30 seconds old and consumed on attempt. Unicode needs no helper; prepare is unsupported. Unlike Android's helper, insertion at the end cannot be guaranteed. Never clears, submits, changes keyboard or uses clipboard; control characters/line breaks are rejected. Preserves screenshot-free mode and returns a new observation for review. Never replay uncertain input." : "Append text to one unchanged focused enabled non-password native EditText. In multi-window observations, only the active, focused application window is eligible; background node focus is not input focus. The editor package, unique window context and foreground app/activity/user must match. action.kind is type_text or prepare. type_text requires action.observationId (latest, at most 30 seconds old, consumed on attempt) and 1-256 UTF-16 code units of text. ASCII letters/digits/space/period/comma/underscore/hyphen use ADB input; Unicode, emoji, other punctuation, tabs and line breaks require the prepared helper. prepare requires explicit approval or matching scoped session consent to upload and run the pinned read-only DEX; no APK, keyboard change, clipboard, permissions, service, or daemon is installed, and files remain. Preparation invalidates observations and needs no observationId; observe again afterward. The helper appends at the end of the actual value, excluding hints, using ACTION_SET_TEXT and exact readback in the same window; the result plus exposed label/hint is capped at 4096. It never clears or submits. Preserve screenshot-free mode. Never prepare implicitly, replace a changed helper, fall back, or replay uncertain input.",
    inputSchema: z.strictObject({
      targetToken,
      action: z.discriminatedUnion("kind", [prepareAction, textActionSchema.extend({ observationId })]),
    }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    if (input.action.kind === "prepare") return result(await service.prepareTextInput(input.targetToken, ctx.mcpReq.signal));
    const { observationId, ...action } = input.action;
    return actionResult(await service.act(input.targetToken, observationId, action, ctx.mcpReq.signal));
  }));

  server.registerTool("mobile_screen_recording", {
    title: "Screen recording",
    description: ios ? "Unsupported in this iOS MVP. Screenshot permission never authorizes recording. Do not start a WDA stream or use another recorder as a fallback." : "Check native capabilities, start, inspect, or stop a silent primary-display MP4 on the selected device. Requires targetToken, not observationId. action.kind: capabilities reads native help without capture, returning unlimitedSupported, maxTimeLimitSeconds and nativeDefaultTimeLimitSeconds (source: device-help). Check it before requesting recording approval; Android version alone is not authoritative. AOSP Android 11-13 allow only 1-180 seconds; Android 14-16 allow longer durations and unlimited. OEM builds/backports can differ. start rechecks capabilities before mutation; unsupported duration is RECORDING_DURATION_UNSUPPORTED (actionMayHaveRun: false), unknown help is RECORDING_CAPABILITIES_UNAVAILABLE. Ask for approval of a supported duration; never silently shorten, segment or replay. start requires an explicit absolute local Windows .mp4 filePath; optional timeLimitSeconds is a positive integer (maximum 4294967295, additionally restricted by device capabilities). Omit timeLimitSeconds for unlimited recording until stopped where supported; never substitute Android's native 180-second default. start returns starting with recordingId after dispatch, without waiting for readiness. status returns idle/starting/recording/completed/saved, timeLimitSeconds: null for unlimited; each request checks startup once while starting. stop requires recordingId, sends one signal to the exact owned recorder, waits up to ten seconds for native completion, saves to the approved path without overwriting, and removes only its temporary device files. No startup/exit polling, automatic retries or race reconciliation: the caller handles timing, status checks and recovery decisions. Command errors are not replaced with inferred success. Obtain explicit consent for device, non-sensitive content, duration/unlimited capture and destination. Choose a restricted Windows destination; staging/final files inherit folder permissions. Screenshot-free observation consent never authorizes recording. Start only awake/unlocked; never record authentication or bypass protected capture. Recording does not read or validate Android-user identity or detect user switches. Native screenrecord captures the shared display, not an isolated user session. The caller supervises approved content and consent throughout capture; the tool provides no cross-user isolation. Unlimited capture can fill storage. The native ADB recorder is not the phone's Quick Settings recorder: no audio, helper install or streaming. One active/unsaved recording per selection. Timed completion still needs stop to export. Start/stop invalidate observations; capabilities/status do not. Device loss/reselection/shutdown cancels the attached ADB command and invalidates handles; capture/files may remain, with no fallback deadline for unlimited recording. Verify capture stopped on the phone; never reconnect or export automatically. Results contain metadata/path only, never video bytes.",
    inputSchema: z.strictObject({ targetToken, action: recordingActionSchema }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => result(await service.screenRecording(input.targetToken, input.action, ctx.mcpReq.signal))));

  server.registerTool("mobile_app_management", {
    title: "App management",
    description: ios ? "iOS supports foreground and launch only. Requires targetToken, no observationId or screenshot. packageName is the exact Bundle ID; launch verifies it became foreground and invalidates prior observations. Foreground returns platform/packageName/pid, not invented Android activity/user fields. list, terminate, install and uninstall explicitly fail. App metadata can be sensitive; use only the authorized App and never replay an uncertain launch." : "Manage apps on the selected device for the current Android user, without screenshots or observationId. Before launch, check fresh deviceStatus or mobile_doctor with targetToken; launch rejects sleeping, locked, transitioning or unknown readiness without implicitly waking/unlocking. List/foreground reads remain usable while locked. action.kind: list returns installed package names (including system apps, not labels); foreground returns package/activity/user or null only for explicitly absent resumed activity; launch verifies a requested installed package is foreground; terminate force-stops its activities/services and verifies stopped state (may lose unsaved work); install accepts one existing local Windows .apk filePath (1 byte to 512 MiB, 120-second limit); uninstall deletes package and current-user app data and verifies removal. launch/terminate/uninstall require packageName. App metadata can be sensitive. Termination requires specific authorization or matching scoped session consent for that package/device/user. Each install/uninstall requires explicit one-action approval naming the APK/package and device, including app-data deletion for uninstall; never offer blanket session approval for them. Reuse an already explicit exact authorization rather than asking twice. No downloads, permission/downgrade flags, automatic launch after install, user switching, or policy bypass. Installation returns packageName: null, never inferred from filenames. Mutations invalidate observations even on failure; never retry an uncertain mutation. Tool-level annotations conservatively cover all operations.",
    inputSchema: z.strictObject({
      targetToken,
      action: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("list") }),
        z.strictObject({ kind: z.literal("foreground") }),
        z.strictObject({ kind: z.literal("launch"), packageName: appIdentifier }),
        z.strictObject({ kind: z.literal("terminate"), packageName: appIdentifier }),
        z.strictObject({ kind: z.literal("install"), filePath: z.string().min(1).max(32_767) }),
        z.strictObject({ kind: z.literal("uninstall"), packageName: appIdentifier }),
      ]),
    }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    const { targetToken, action } = input;
    const signal = ctx.mcpReq.signal;
    switch (action.kind) {
      case "list": return result(await service.listApps(targetToken, signal));
      case "foreground": return result({ foregroundApp: await service.getForegroundApp(targetToken, signal) });
      case "launch": return result(await service.launchApp(targetToken, action.packageName, signal));
      case "terminate": return result(await service.terminateApp(targetToken, action.packageName, signal));
      case "install": return result(await service.installApp(targetToken, action.filePath, signal));
      case "uninstall": return result(await service.uninstallApp(targetToken, action.packageName, signal));
    }
  }));

  server.server.onclose = () => {
    void Promise.resolve(service.stop()).catch(() => {
      process.stderr.write("mobile-use: device session cleanup failed; check the owned session on the device.\n");
      process.exitCode = 1;
    });
  };
  return server;
}
