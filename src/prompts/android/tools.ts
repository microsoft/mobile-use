import { joinPrompt, type AndroidPromptPack, type CoreToolName, type ToolPrompt } from "../contracts.js";
import { androidServerInstructions } from "./instructions.js";
import { deviceSelectionInstructions } from "./setup.js";

export const androidToolPrompts: Readonly<Record<CoreToolName, ToolPrompt>> = {
  mobile_doctor: {
    title: "Check mobile setup",
    description: joinPrompt([
      "Start here on first use: diagnose Windows/ADB prerequisites and return step-by-step setup guidance.",
      "Ready means host Platform-Tools only; then call mobile_list_devices before guiding missing phone setup.",
      "Guide Platform-Tools installation, Developer options, and USB/Wireless debugging only as needed.",
      "Never installs software, pairs, changes settings, lists, or controls devices.",
    ]),
  },
  mobile_start_adb_server: {
    title: "Start ADB server",
    description: joinPrompt([
      "For the user's Android task, reuse a compatible local ADB server at 127.0.0.1:5037 or start a missing one, verify readiness, and retry read-only device discovery.",
      "No separate conversational approval is required; Copilot's native permissions still apply.",
      "The shared server may remain running after this plugin exits and may initialize standard local ADB host keys.",
      "Never kills, replaces, or restarts a server, changes settings, pairs, approves phone trust, or controls devices.",
      "Conflicts fail explicitly. Never automatically retry uncertain startup.",
    ]),
  },
  mobile_list_devices: {
    title: "List devices",
    description: joinPrompt([
      "After mobile_doctor, list local ADB endpoints with online/unauthorized/offline states and the next setup steps.",
      "Empty inventory prompts Developer options/USB debugging guidance; unauthorized/offline entries need user setup.",
      "Discovery itself never selects a device.",
      deviceSelectionInstructions,
    ]),
  },
  mobile_select_device: {
    title: "Select device",
    description: joinPrompt([
      deviceSelectionInstructions,
      "Use the exact endpointId returned by discovery.",
      "Verify a real Android 11+ device and modern paired wireless when applicable.",
      "Does not pair or connect devices. Every selection invalidates prior target/observation tokens.",
    ]),
  },
  mobile_observe: {
    title: "Observe screen",
    description: joinPrompt([
      "Read primary-display interactive windows and their native UI elements, including non-focused floating controls where Android exposes them, plus independently verified display geometry and optionally a PNG.",
      "hierarchyScope and windows report actual coverage; missing roots and active-only OEM responses are explicit.",
      "Native clickable and scrollable flags are preserved; pointerTarget marks enabled native buttons eligible for guarded pointer gestures.",
      "captureTiming reports total, screenshot and hierarchy read durations; these sources remain non-atomic.",
      "includeScreenshot defaults to true; false never captures a screenshot, including subsequent input revalidation/results.",
      "Coordinate taps/swipes are blocked in that mode; use eligible elementRef taps. Unverified display state blocks input.",
      "Only observe user-approved non-sensitive content; results can be sent to the configured model service.",
    ]),
  },
  mobile_wake: {
    title: "Wake device",
    description: joinPrompt([
      "Wake the selected Android phone and dismiss only a verified unsecured lock screen when needed for the user's authorized task.",
      "Task permission covers this preparation; no separate wake-specific request or conversational approval is needed.",
      "Ask permission only if the task or target has not been authorized.",
      "Use this tool before asking the user to wake or dismiss an unsecured lock screen manually.",
      "Requires a target token but no screen observation; invalidates previous observations.",
      "Never enters credentials, bypasses authentication, or captures the lock screen.",
      "MANUAL_UNLOCK_REQUIRED requires user authentication; KEYGUARD_STATE_UNAVAILABLE or WAKE_FAILED requires manual assistance after reporting the actual error.",
      "After success, observe approved non-sensitive content before subsequent input.",
      "Respect Copilot's native permissions. Never automatically replay an uncertain result.",
    ]),
  },
  mobile_tap: {
    title: "Taps",
    description: joinPrompt([
      "Tap, long-press, or double-tap one observed target. action.kind is tap, long_press, double_tap, or prepare.",
      "Input actions require action.observationId (latest, at most 30 seconds old, consumed on attempt) and target: an enabled clickable or pointerTarget elementRef, or screenshot coordinates.",
      "Metadata-first guards validate the unique unchanged control, window/app context and potential occlusion, without a pixel veto for unrelated video or timer changes.",
      "Coordinates identifying one potential control use that metadata at the exact requested point; ambiguous, disabled or changed controls are rejected, never bypassed with visual bounds.",
      "Automatic identification requires native button/editor semantics or nonempty text/description; an unlabeled generic clickable container alone does not identify a custom-drawn control.",
      "With no actionable metadata, target must include bounds: {x,y,width,height} around the complete visible control; visual fallback requires unchanged decoded pixels and exposed metadata throughout those bounds plus a clipped margin (8% of the shorter display dimension, at least 8 pixels).",
      "There is no whole-screen pixel-change threshold. Missing app context blocks pointer input even with identical images. Visual rejections include visualGuard pixel counts, changed bounds, protectedRegion and capture timing.",
      "Floating-window elements require unchanged unique window context and an uncovered target. pointerTarget preserves clickable=false and requires an enabled native Button/ImageButton with package, resource ID and owning window. A stale-observation error is not proof of an app security block.",
      "long_press uses one native primary-display stationary gesture with the system long-press timeout, no MOVE events, helper, or configurable duration; recognition is OEM-dependent. Never substitute it for tap automatically; a long press can open a context menu.",
      "Double-tap uses one verified helper process, exactly two taps at the same point, and optional delayMs (0-250, default 50); gestureTiming is not proof of recognition. Both taps use the same point even if the first changes the UI; use the pair only when both taps are safe.",
      "prepare requires explicit approval or matching scoped session consent to upload and run the bundled read-only DEX; no APK, permissions, service, or daemon is installed, and files remain on the device. Preparation invalidates observations and needs no observationId; observe again afterward.",
      "Never prepare implicitly, replace a changed helper, or replay uncertain input. Preserve screenshot-free mode; coordinates require a screenshot. Reuse authorization for ordinary navigation within the user's safe task; consequential gestures still require specific authorization.",
    ]),
  },
  mobile_swipe: {
    title: "Swipes",
    description: joinPrompt([
      "Perform one bounded swipe using the latest observationId (at most 30 seconds old, consumed on attempt), screenshot from/to coordinates and optional durationMs (100-2000, default 400).",
      "Metadata-first guards use an optional scrollable elementRef or one uniquely identified scrollable surface containing the start; both endpoints must remain inside that unchanged enabled surface with matching app/window context and no potentially covering window along the path.",
      "Actionable controls and competing scrollable surfaces at the initial touch must retain their metadata and owning-window context, including with an explicit reference, but child-content changes elsewhere and video pixels do not veto a verified surface. Changed, disabled or ambiguous metadata never falls back to pixels.",
      "If no scrollable surface is exposed, supply bounds: {x,y,width,height} around the complete visible swipe surface containing both endpoints. Visual fallback protects that surface plus a clipped margin (8% of the shorter display dimension, at least 8 pixels), checking decoded pixels and exposed metadata.",
      "Changes outside it have no whole-screen percentage limit. Missing foreground context and changed hierarchy coverage block visual input. Visual rejections include structured visualGuard diagnostics. Hierarchy-only observations reject swipes without capturing an image.",
      "Return the next observation in the same screenshot mode and verify the intended state. Reuse the user's safe navigation task authorization; never replay an uncertain swipe.",
    ]),
  },
  mobile_press_key: {
    title: "Back / Home / Enter",
    description: joinPrompt([
      "Press exactly one BACK, HOME, or ENTER key using the latest observationId (at most 30 seconds old, consumed on attempt).",
      "Revalidate display state and return the next observation, preserving screenshot-free mode.",
      "Ordinary safe navigation needs no repeated conversational approval within the authorized task.",
      "ENTER can submit a field: require specific authorization for any consequential action, and never enter credentials or replay uncertain input.",
    ]),
  },
  mobile_input_text: {
    title: "Input text",
    description: joinPrompt([
      "Append text to one unchanged focused enabled non-password native EditText. In multi-window observations, only the active, focused application window is eligible; background node focus is not input focus.",
      "The editor package, unique window context and foreground app/activity/user must match. action.kind is type_text or prepare.",
      "type_text requires action.observationId (latest, at most 30 seconds old, consumed on attempt) and 1-256 UTF-16 code units of text.",
      "ASCII letters/digits/space/period/comma/underscore/hyphen use ADB input; Unicode, emoji, other punctuation, tabs and line breaks require the prepared helper.",
      "prepare requires explicit approval or matching scoped session consent to upload and run the pinned read-only DEX; no APK, keyboard change, clipboard, permissions, service, or daemon is installed, and files remain.",
      "Preparation invalidates observations and needs no observationId; observe again afterward.",
      "The helper appends at the end of the actual value, excluding hints, using ACTION_SET_TEXT and exact readback in the same window; the result plus exposed label/hint is capped at 4096. It never clears or submits.",
      "Preserve screenshot-free mode. Never prepare implicitly, replace a changed helper, fall back, or replay uncertain input.",
    ]),
  },
  mobile_screen_recording: {
    title: "Screen recording",
    description: joinPrompt([
      "Check native capabilities, start, inspect, or stop a silent primary-display MP4 on the selected device. Requires targetToken, not observationId.",
      "action.kind: capabilities reads native help without capture, returning unlimitedSupported, maxTimeLimitSeconds and nativeDefaultTimeLimitSeconds (source: device-help). Check it before requesting recording approval; Android version alone is not authoritative.",
      "AOSP Android 11-13 allow only 1-180 seconds; Android 14-16 allow longer durations and unlimited. OEM builds/backports can differ.",
      "start rechecks capabilities before mutation; unsupported duration is RECORDING_DURATION_UNSUPPORTED (actionMayHaveRun: false), unknown help is RECORDING_CAPABILITIES_UNAVAILABLE. Ask for approval of a supported duration; never silently shorten, segment or replay.",
      "start requires an explicit absolute local Windows .mp4 filePath; optional timeLimitSeconds is a positive integer (maximum 4294967295, additionally restricted by device capabilities). Omit timeLimitSeconds for unlimited recording until stopped where supported; never substitute Android's native 180-second default.",
      "start returns starting with recordingId after dispatch, without waiting for readiness. status returns idle/starting/recording/completed/saved, timeLimitSeconds: null for unlimited; each request checks startup once while starting.",
      "stop requires recordingId, sends one signal to the exact owned recorder, waits up to ten seconds for native completion, saves to the approved path without overwriting, and removes only its temporary device files.",
      "No startup/exit polling, automatic retries or race reconciliation: the caller handles timing, status checks and recovery decisions. Command errors are not replaced with inferred success.",
      "Obtain explicit consent for device, non-sensitive content, duration/unlimited capture and destination. Choose a restricted Windows destination; staging/final files inherit folder permissions. Screenshot-free observation consent never authorizes recording.",
      "Start only awake/unlocked; never record authentication or bypass protected capture.",
      "Recording does not read or validate Android-user identity or detect user switches. Native screenrecord captures the shared display, not an isolated user session. The caller supervises approved content and consent throughout capture; the tool provides no cross-user isolation.",
      "Unlimited capture can fill storage. The native ADB recorder is not the phone's Quick Settings recorder: no audio, helper install or streaming. One active/unsaved recording per selection. Timed completion still needs stop to export.",
      "Start/stop invalidate observations; capabilities/status do not. Device loss/reselection/shutdown cancels the attached ADB command and invalidates handles; capture/files may remain, with no fallback deadline for unlimited recording. Verify capture stopped on the phone; never reconnect or export automatically. Results contain metadata/path only, never video bytes.",
    ]),
  },
  mobile_app_management: {
    title: "App management",
    description: joinPrompt([
      "Manage apps on the selected device for the current Android user, without screenshots or observationId.",
      "action.kind: list returns installed package names (including system apps, not labels); foreground returns package/activity/user or null only for explicitly absent resumed activity; launch verifies a requested installed package is foreground; terminate force-stops its activities/services and verifies stopped state (may lose unsaved work); install accepts one existing local Windows .apk filePath (1 byte to 512 MiB, 120-second limit); uninstall deletes package and current-user app data and verifies removal.",
      "launch/terminate/uninstall require packageName. App metadata can be sensitive.",
      "Termination requires specific authorization or matching scoped session consent for that package/device/user.",
      "Each install/uninstall requires explicit one-action approval naming the APK/package and device, including app-data deletion for uninstall; never offer blanket session approval for them. Reuse an already explicit exact authorization rather than asking twice.",
      "No downloads, permission/downgrade flags, automatic launch after install, user switching, or policy bypass. Installation returns packageName: null, never inferred from filenames.",
      "Mutations invalidate observations even on failure; never retry an uncertain mutation. Tool-level annotations conservatively cover all operations.",
    ]),
  },
};

export const androidPromptPack: AndroidPromptPack = {
  instructions: androidServerInstructions,
  tools: androidToolPrompts,
};
