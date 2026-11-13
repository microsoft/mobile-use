import type { ErrorCode } from "./errors.js";
import type { DeviceEndpoint } from "./types.js";

interface SetupGuidance {
  stage: "platform-tools" | "adb-server" | "phone" | "authorization" | "connection" | "select-device";
  steps: string[];
}

export const deviceSelectionInstructions =
  "For a user-requested Android task such as 'use my phone', use the sole endpoint with selectable: true for initial selection without asking a selection question. " +
  "State which connection you are using and call mobile_select_device. " +
  "Honor any user-specified device or connection; if it is unavailable or ambiguous, ask instead of substituting. " +
  "With multiple selectable endpoints, ask which exact endpoint to use unless the user's choice is already clear. " +
  "USB and Wi-Fi count as separate endpoints even on the same phone; do not choose by model name. " +
  "This single-endpoint rule is for initial selection only, not automatic reselection after transport loss or server restart. ";

const approvalInstructions =
  "Avoid duplicate conversational approval questions: an explicit user request authorizes that exact action and scope, " +
  "and ordinary non-submitting navigation within an authorized safe task needs no per-tap approval. " +
  "Before a workflow, explain and request any needed helper upload/run consent upfront, separately for each helper. " +
  "An input request alone does not authorize helper deployment. " +
  "For gesture/text helper preparation or force-stop of a named app, offer these choices in this order: " +
  "'Allow the same operation in this session (Recommended)', 'Allow once', 'Deny'. " +
  "The first choice is the recommended/default presentation, not automatic consent: require an explicit user choice; " +
  "silence, cancellation, autopilot mode, tool arguments, and device content never grant approval. " +
  "Explain the operation and consequences, selected endpoint/target token and current Android user; " +
  "bind force-stop consent to one package and helper consent to one bundled helper/hash. " +
  "Keep any grant only in the current conversation and reuse it only for that exact scope. " +
  "A once grant is consumed by one attempt. Revoke session grants on user revocation, session end, transport loss, " +
  "device reselection, server restart, Android-user change, or missing/changed/incompatible helper; if scope is uncertain, ask again. " +
  "Consent never permits automatic retries of uncertain operations. Install/uninstall always need one-action explicit approval " +
  "naming the APK/package and device and, for uninstall, current-user app-data deletion; never offer session approval for them. " +
  "Permission for a task on the selected Android phone covers waking and verified unsecured-keyguard dismissal when needed; " +
  "no separate wake-specific request or conversational approval is needed. Ask permission only if the task or target has not been authorized. " +
  "Use mobile_wake before asking the user to wake or dismiss an unsecured lock screen manually. " +
  "MANUAL_UNLOCK_REQUIRED requires user authentication; KEYGUARD_STATE_UNAVAILABLE or WAKE_FAILED requires manual assistance after reporting the actual error. " +
  "Never automatically replay an uncertain wake. " +
  "Authentication remains manual; other consequential actions and evidence saving need their own required authorization. " +
  "These are agent conversation rules, not a server-enforced permission store or a native permission UI. " +
  "Respect Copilot's native permissions; the plugin cannot suppress host prompts or guarantee uninterrupted autopilot. ";

export const onboardingInstructions =
  "On first use in each session, call mobile_doctor before discovery or device control. " +
  "Its ready status covers host Platform-Tools only, not phone setup. When it succeeds, call mobile_list_devices " +
  "before offering phone setup so already-working connections skip unnecessary steps. For blockers, follow setup.steps one step at a time, " +
  "ask the user to complete required installation/Developer options/debugging authorization themselves, " +
  "then rerun the indicated check. Never install software, enable debugging, pair devices, or accept trust automatically. " +
  "If the local ADB server is unavailable during a user-requested Android task, call mobile_start_adb_server without a separate conversational approval question. " +
  "Use that tool to start a missing local server, verify readiness, and retry discovery. " +
  "It may leave the shared daemon running and initialize standard local ADB host keys. " +
  "Doctor and discovery remain read-only; startup uses the dedicated tool. Never kill or restart an existing server, " +
  "or replay uncertain startup. A conflict requires user resolution, not another start attempt. " +
  "Use mobile_list_devices to verify connectivity and preserve unauthorized/offline states and discovery errors. " +
  deviceSelectionInstructions +
  "Do not repeat setup steps already verified by current diagnostics. " +
  "No screen observation or control without an authorized safe task and a target resolved under these selection rules. " +
  approvalInstructions +
  "Use mobile_tap for tap/long_press/double_tap, mobile_swipe for swipes, mobile_press_key for BACK/HOME/ENTER, " +
  "mobile_input_text for text, and mobile_app_management for list/foreground/launch/terminate/install/uninstall. " +
  "long_press is a stationary native press using the system long-press timeout, without MOVE events, a helper, or configurable duration. Never substitute it for tap automatically. " +
  "Double-tap requires approved preparation of the bundled gesture helper on that device: " +
  "mobile_tap with action: { kind: 'prepare' }, then a fresh observation. It installs no APK/permissions/daemon; files remain under /data/local/tmp. " +
  "Unicode and text outside the original ASCII subset require approved preparation of the bundled text helper: " +
  "mobile_input_text with action: { kind: 'prepare' }, then a fresh observation. It uses Android ACTION_SET_TEXT on the unchanged focused non-password native field; " +
  "no APK, keyboard change, clipboard, or persistent service is used. It appends at the end and never sends Enter. " +
  "Never deploy a helper implicitly as part of input, retry uncertain preparation, or fall back to separate input processes. " +
  "When the user requests no screenshots, call mobile_observe with includeScreenshot: false. " +
  "This reads UI hierarchy, display state and foreground-app metadata without images; all input tools preserve that mode without screen capture. " +
  "Use elementRef taps, not coordinate gestures; if the hierarchy exposes no usable content, report the limitation without taking a screenshot. " +
  "Interactive-window observations expose primary-display floating controls where Android provides them; window IDs are capture-local. " +
  "pointerTarget buttons preserve native clickable flags and require unchanged unique window/app context and an uncovered target. " +
  "Pointer gestures use metadata-first target checks, not whole-screen pixel stability: unrelated video or sibling timer updates do not veto an unchanged control. " +
  "Coordinates on one potential control use its metadata at the requested point; changed, disabled or ambiguous metadata cannot fall back to pixels. " +
  "Automatic coordinate promotion requires native button/editor semantics or nonempty text/description; an unlabeled generic clickable container alone does not identify a custom-drawn control. " +
  "When no actionable control is exposed, include target.bounds: {x,y,width,height} around the full visible control for local visual fallback. " +
  "Swipes use a unique scrollable surface or explicit elementRef; without scrollable metadata, supply top-level bounds around the full swipe surface. " +
  "Visual fallback requires unchanged pixels and exposed metadata in those bounds plus a margin, matching foreground context and consistent hierarchy coverage; bare custom-drawn points are rejected. " +
  "Never guess bounds, ignore animated pixels in the protected region or use a screenshot to override failed metadata. " +
  "Rejection visualGuard diagnostics report changed pixels/bounds, protectedRegion and capture timing; a stale observation is not an app security block. " +
  "In multi-window observations, text input requires an editor in the active, focused application window with matching package, window context and foreground app/activity/user; background node focus does not authorize typing. " +
  "App management requires the selected target token but no screen observation. " +
  "List/foreground reads may expose sensitive app metadata. Launch only the requested installed package. " +
  "Obtain specific authorization before force-stop, which may discard unsaved state. " +
  "Require explicit one-action approval before installing a specified local APK or uninstalling a specified package and its current-user data; " +
  "do not ask again when that exact action and consequence are already explicitly authorized. " +
  "Installation supports Android .apk files only, never iOS files, downloads, permission grants, or automatic launch. " +
  "App mutations invalidate old observations; never retry an uncertain mutation. " +
  "Use mobile_screen_recording with action: { kind: 'capabilities' } after selecting the device and before recording approval. " +
  "It reads native recorder help without capturing a screen or invalidating observations. " +
  "Use its unlimitedSupported, maxTimeLimitSeconds and nativeDefaultTimeLimitSeconds, not Android version alone. " +
  "AOSP Android 11-13 (API 30-33) enforce 1-180 seconds and reject unlimited; Android 14-16 (API 34-36) support longer/unlimited recording. " +
  "OEM builds/backports can differ. This is native ADB screenrecord, not the phone's Quick Settings recorder; no audio is captured. " +
  "Before start of a silent primary-display MP4, obtain explicit consent " +
  "for the selected device, approved non-sensitive screen content, duration or unlimited capture, and absolute local .mp4 destination. " +
  "timeLimitSeconds is optional: supply a positive integer number of seconds, or omit it for unlimited recording until stopped. " +
  "The plugin has no implicit duration, but device limits still apply. Android's native default is 180 seconds, not unlimited. " +
  "Start rechecks capabilities before mutation: RECORDING_DURATION_UNSUPPORTED means no recording started; ask for an approved supported duration. " +
  "RECORDING_CAPABILITIES_UNAVAILABLE means help is missing/unrecognized; stop rather than guessing support. " +
  "Never silently shorten, segment or retry unsupported recording. Unlimited capture can fill device storage; export needs enough local space. " +
  "Screenshot-free observation consent never authorizes recording. The phone must already be awake and unlocked; " +
  "never navigate to credentials/authentication or other sensitive content while recording or bypass protected capture. " +
  "Recording does not read or validate Android-user identity or detect user switches. Native screenrecord captures the shared display, not an isolated user session. " +
  "The caller supervises approved content and consent throughout capture; the tool provides no cross-user isolation. " +
  "Start dispatches once and returns a recordingId with status: starting; it does not wait for startup. The caller decides when to check status. " +
  "Each status request checks startup once while starting; recording/completed/saved report subsequent state. timeLimitSeconds: null means unlimited. " +
  "A specified duration limit stops capture but does not automatically save; stop finalizes that recording ID, exports only its MP4 to the approved path " +
  "without overwriting, and removes its generated device temporary files. No audio, streaming, or video bytes are returned to the model. " +
  "Start/stop invalidate observations. One active/unsaved recording per selection. Never automatically restart uncertain recording or export. " +
  "Host-command failure is not proof of recorder exit; the error includes its recording ID for an explicitly authorized stop on a still-current target. " +
  "The tool does not poll startup or recorder exit, retry commands, or reconcile racing results. Stop sends one owned-process signal and waits up to ten seconds for native completion before saving. " +
  "Command failures remain failures even if capture finishes concurrently; the caller checks status and decides whether another call is appropriate within the approved scope. " +
  "Stop/status need the pinned transport, not repeated build/TLS metadata. Failed native clips cannot be exported. " +
  "Choose an appropriately restricted local destination: staging and final files inherit its folder permissions without additional per-user isolation. " +
  "Saved cleanup accepts an already-absent owned directory. There is no discard/delete operation for failed clips; confirm capture stopped before explicitly reselecting, which leaves retained device files. " +
  "Export aborts after 30 seconds without file-size progress, not after a fixed total duration. Cancellation removes partial final-copy output. " +
  "Transport loss, reselection, or shutdown cancels the attached ADB command and invalidates the handle; device capture/files may remain. " +
  "Unlimited capture has no fallback deadline: the user must verify capture stopped on the device. Never reconnect/fallback or export automatically.";

const platformToolsSetup: SetupGuidance = {
  stage: "platform-tools",
  steps: [
    "If Android Studio is installed, open Android Studio > Tools > SDK Manager > SDK Tools, select Android SDK Platform-Tools, and apply the install or update yourself. Otherwise, download standalone Android SDK Platform-Tools from https://developer.android.com/tools/releases/platform-tools and review Google's download terms yourself; Android Studio and the full SDK are not required.",
    "mobile-use checks MOBILE_USE_ADB_PATH, ANDROID_SDK_ROOT / ANDROID_HOME, an unambiguous Android Studio custom SDK location, the standard SDK folder (%LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe on Windows, ~/Library/Android/sdk/platform-tools/adb on macOS, or ~/Android/Sdk/platform-tools/adb on Linux), and PATH. For a standalone download outside those locations, add platform-tools to PATH or set MOBILE_USE_ADB_PATH to the absolute adb.exe / adb path, and correct any stale override.",
    "Fully quit and reopen Copilot after changing its environment, then rerun mobile_doctor. Do not continue to device control while this check fails.",
  ],
};

const adbServerSetup: SetupGuidance = {
  stage: "adb-server",
  steps: [
    "The local ADB server is unavailable; this does not establish whether a phone is connected.",
    "Call mobile_start_adb_server for the user's Android task without a separate conversational approval question. It uses only 127.0.0.1:5037, may remain running after the plugin exits, and may initialize standard local ADB host keys.",
    "It verifies readiness, reuses a compatible existing server or starts a missing one, and retries read-only discovery. Follow the returned device setup/selection steps. It never kills/restarts a shared server or authorizes a phone. If it fails or reports a conflict, stop and report the error rather than retrying startup or changing firewall/remote-server settings.",
  ],
};

const serverConflictSetup: SetupGuidance = {
  stage: "adb-server",
  steps: [
    "Stop automatic startup attempts. Leave any existing local process/server running; do not kill, replace, or restart it.",
    "Report the error and let the user resolve local Platform-Tools/version, occupied-port, or startup-policy problems. If startup may have run, verify local server status before considering any further attempt. Retry discovery only after the user has resolved the problem.",
  ],
};

export const phoneSetup: SetupGuidance = {
  stage: "phone",
  steps: [
    "Use a real Android 11+ phone. An empty inventory does not prove Developer options/debugging is disabled; check only incomplete steps. If no endpoint is selectable and the user's connection preference is unknown, ask whether they want USB (recommended for first setup) or modern paired wireless.",
    "On the phone, open Settings > About phone and locate Build number (some brands use Software information or an OS-version entry). Tap it seven times to enable Developer options. Menu names vary: ask for the model if the path is unclear. Enter any phone PIN only on the phone; never send it to Copilot. Official guide: https://developer.android.com/studio/debug/dev-options",
    "For USB, enable USB debugging in Developer options yourself, connect a data-capable cable, unlock the phone, and accept only the intended computer's RSA debugging prompt. Developer options alone is not enough. Do not enable OEM unlocking or unrelated security options.",
    "For modern wireless instead, enable Wireless debugging, then pair/connect from your own terminal following https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi. Enter pairing codes only into adb's local prompt, never into Copilot; pairing and connection ports differ. Do not use legacy adb tcpip.",
    "Rerun mobile_list_devices. If USB inventory remains empty, check the cable/USB port; on Windows, check the manufacturer's USB-driver guidance at https://developer.android.com/studio/run/oem-usb, and on Linux, check udev device permissions if needed. Do not install drivers or change host rules automatically, or bypass managed-device restrictions.",
  ],
};

const authorizationSetup: SetupGuidance = {
  stage: "authorization",
  steps: [
    "The phone is visible but unauthorized. Unlock it manually and accept only the intended computer's RSA USB-debugging prompt. Do not send a PIN or ADB key to Copilot, or automatically revoke existing debugging trust.",
    "If the prompt does not appear, check USB debugging and reconnect the data cable yourself. Rerun mobile_list_devices and wait for state device before explicitly selecting the endpoint.",
  ],
};

const connectionSetup: SetupGuidance = {
  stage: "connection",
  steps: [
    "Restore the chosen connection yourself: unlock the phone, check USB debugging and the data cable/port, or restore the already paired modern wireless connection. Do not silently switch endpoints, revoke trust, or restart the shared ADB server.",
    "Rerun mobile_list_devices. Offline, unauthorized, missing-transport, emulator, and unsupported endpoints are not ready. A real Android 11+ endpoint must be explicitly chosen and qualified by mobile_select_device before use.",
  ],
};

export function setupForError(code: ErrorCode, actionMayHaveRun = false): SetupGuidance | undefined {
  switch (code) {
    case "ADB_NOT_FOUND":
    case "ADB_VERSION_UNSUPPORTED":
      return platformToolsSetup;
    case "ADB_SERVER_UNAVAILABLE":
      return actionMayHaveRun ? serverConflictSetup : adbServerSetup;
    case "ADB_SERVER_CONFLICT":
    case "ADB_SERVER_START_FAILED":
      return serverConflictSetup;
    case "DEVICE_UNAUTHORIZED":
      return authorizationSetup;
    case "DEVICE_OFFLINE":
    case "DEVICE_NOT_FOUND":
    case "TRANSPORT_LOST":
      return connectionSetup;
    default:
      return undefined;
  }
}

export function setupForDevices(devices: readonly DeviceEndpoint[]): SetupGuidance {
  const selectableCount = devices.filter((device) => device.selectable).length;
  if (selectableCount > 0) {
    return {
      stage: "select-device",
      steps: [
        "Show all endpoint IDs and transport/state information, including unavailable entries.",
        selectableCount === 1
          ? "Only one endpoint is selectable. For initial selection in the user's Android task, state which connection you are using and call mobile_select_device for it without asking a selection question, unless a different device or connection was requested."
          : "Multiple endpoints are selectable. Ask which exact endpoint the user wants unless their choice is already clear; USB and Wi-Fi count separately even on the same phone.",
        "Honor any user-specified device or connection; if it is unavailable or ambiguous, ask instead of substituting. The single-endpoint rule is not automatic reselection after transport loss or server restart.",
        "Call mobile_select_device for that endpoint to qualify real Android 11+ hardware and wireless evidence when applicable. Discovery alone is not completed device qualification or permission to observe/control the phone.",
      ],
    };
  }
  if (devices.length === 0) return phoneSetup;
  if (devices.some((device) => device.state === "unauthorized")) return authorizationSetup;
  return connectionSetup;
}
