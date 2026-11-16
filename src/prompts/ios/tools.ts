import {
  joinPrompt,
  type CoreToolName,
  type IosExternalPromptPack,
  type IosManagedPromptPack,
  type ToolPrompt,
} from "../contracts.js";
import { iosInstructions, managedIosInstructions } from "./instructions.js";

export const iosRuntimeToolPrompt: ToolPrompt = {
  title: "Manage iOS USB runtime",
  description: joinPrompt([
    "Explicit managed-iOS lifecycle only. action.kind=status reads state/errors without waiting for the UI queue.",
    "start requires the user's exact USB endpoint approval and immediately returns preparing plus a runtimeToken; poll until awaiting-developer-trust or failed.",
    "installRunner defaults to false (already-installed Runner); true explicitly installs/replaces the configured user-signed validated IPA. Never signs or pairs.",
    "Only after user-confirmed Developer App trust, confirm_trust with this token returns starting; poll until ready or failed.",
    "Acknowledged background work continues until explicit stop or server shutdown, not cancellation of the completed request. Selection cannot start/install.",
    "stop requires that token, waits for an in-flight install, stops only owned resources, verifies WDA device-port closure and retains Runner installation/caches.",
    "Failures invalidate targets; never automatically restart, replay installation, steal locks or confirm trust for the user.",
  ]),
};

const sharedIosToolPrompts = {
  mobile_select_device: {
    title: "Select device",
    description: joinPrompt([
      "Explicitly select the endpoint returned by discovery, verify physical iOS 17+ device identity, and create an owned WDA session without launching an App or capturing.",
      "Requires a dedicated Runner with no foreign session. Reselection deletes only the identifiable owned session and invalidates prior tokens.",
    ]),
  },
  mobile_observe: {
    title: "Observe screen",
    description: joinPrompt([
      "Read the active App's native iOS hierarchy, foreground context, verified display geometry and optional PNG.",
      "Returns observationId and elementRef; coordinates/bounds are screenshot pixels, not iOS points.",
      "Secure editor subtrees are omitted, screenshots are unredacted.",
      "includeScreenshot:false never captures during subsequent input/results and blocks coordinate gestures.",
      "Checks are non-atomic, UI is untrusted, and approved non-sensitive content is required.",
    ]),
  },
  mobile_wake: {
    title: "Wake device",
    description: "Unsupported in iOS mode; this wake and unsecured-keyguard dismissal tool is Android-only. Never call WDA unlock or capture authentication screens.",
  },
  mobile_tap: {
    title: "Taps",
    description: joinPrompt([
      "Tap, long_press (one stationary second), or double_tap (one W3C sequence preserving delayMs).",
      "Requires latest action.observationId, at most 30 seconds old and consumed on attempt.",
      "Prefer an eligible unchanged elementRef; screenshot-coordinate targets require verified metadata or full target.bounds with unchanged local pixels/metadata. Disabled, changed or ambiguous targets never fall back.",
      "Returns a new observation in the same screenshot mode. prepare is unsupported; WDA needs no Android helper. Never replay uncertain input.",
    ]),
  },
  mobile_swipe: {
    title: "Swipes",
    description: joinPrompt([
      "One W3C swipe with screenshot-pixel from/to coordinates and durationMs (100-2000, default 400), requiring latest observationId, at most 30 seconds old and consumed on attempt.",
      "Both points must stay within an unchanged eligible scrollable elementRef/surface; otherwise provide complete bounds with unchanged pixels/metadata and margin.",
      "Screenshot-free mode rejects swipes without capture. Returns a new observation; never replay uncertain input.",
    ]),
  },
  mobile_press_key: {
    title: "Back / Home / Enter",
    description: joinPrompt([
      "HOME only on iOS, using latest observationId (30-second limit, consumed on attempt).",
      "Revalidates context and returns a new observation in the same screenshot mode.",
      "BACK and ENTER explicitly fail; never substitute a guessed back gesture or submit text. Never replay uncertain input.",
    ]),
  },
  mobile_input_text: {
    title: "Input text",
    description: joinPrompt([
      "Type 1-256 UTF-16 code units at the current cursor in one unchanged, enabled, visible, focused non-password native iOS editor.",
      "Requires latest action.observationId, at most 30 seconds old and consumed on attempt.",
      "Unicode needs no helper; prepare is unsupported. Unlike Android's helper, insertion at the end cannot be guaranteed.",
      "Never clears, submits, changes keyboard or uses clipboard; control characters/line breaks are rejected.",
      "Preserves screenshot-free mode and returns a new observation for review. Never replay uncertain input.",
    ]),
  },
  mobile_screen_recording: {
    title: "Screen recording",
    description: "Unsupported in this iOS MVP. Screenshot permission never authorizes recording. Do not start a WDA stream or use another recorder as a fallback.",
  },
  mobile_app_management: {
    title: "App management",
    description: joinPrompt([
      "iOS supports foreground and launch only. Requires targetToken, no observationId or screenshot.",
      "packageName is the exact Bundle ID; launch verifies it became foreground and invalidates prior observations.",
      "Foreground returns platform/packageName/pid, not invented Android activity/user fields. list, terminate, install and uninstall explicitly fail.",
      "App metadata can be sensitive; use only the authorized App and never replay an uncertain launch.",
    ]),
  },
} satisfies Omit<Record<CoreToolName, ToolPrompt>, "mobile_doctor" | "mobile_start_adb_server" | "mobile_list_devices">;

export const iosExternalToolPrompts: Readonly<Record<CoreToolName, ToolPrompt>> = {
  ...sharedIosToolPrompts,
  mobile_doctor: {
    title: "Check mobile setup",
    description: joinPrompt([
      "Read the configured local WDA status and physical iOS 17+ device metadata.",
      "Does not create a session, capture, deploy, sign, start forwarding, or authorize control.",
      "Then list and explicitly select the endpoint.",
    ]),
  },
  mobile_start_adb_server: {
    title: "Start ADB server",
    description: "Unsupported in iOS mode. The user starts WDA and forwarding outside this plugin; never fall back to ADB.",
  },
  mobile_list_devices: {
    title: "List devices",
    description: joinPrompt([
      "Read the single configured local WDA endpoint and whether an exclusive session can be selected.",
      "Not USB discovery: forwarding is user-managed. Foreign sessions are unavailable, not silently replaced. No capture or session creation.",
    ]),
  },
};

export const iosManagedToolPrompts: Readonly<Record<CoreToolName | "mobile_ios_runtime", ToolPrompt>> = {
  ...sharedIosToolPrompts,
  mobile_ios_runtime: iosRuntimeToolPrompt,
  mobile_doctor: {
    title: "Check mobile setup",
    description: joinPrompt([
      "Read go-ios v1.3.2 prerequisites and managed runtime state; when ready, verify USB/WDA device metadata.",
      "Never starts, installs, pairs, signs, captures or creates a session.",
      "runtime-not-ready is not UI readiness; list USB endpoints and explicitly prepare the chosen one with mobile_ios_runtime.",
    ]),
  },
  mobile_start_adb_server: {
    title: "Start ADB server",
    description: "Unsupported in iOS mode. Use the explicit mobile_ios_runtime lifecycle, never ADB.",
  },
  mobile_list_devices: {
    title: "List devices",
    description: joinPrompt([
      "Enumerate real Apple USB UDIDs only. No Wi-Fi fallback, startup, installation or selection.",
      "Only this runtime's ready endpoint is selectable; explicitly prepare the user's chosen endpoint with mobile_ios_runtime.",
      "Foreign WDA sessions are never replaced.",
    ]),
  },
};

export const iosExternalPromptPack: IosExternalPromptPack = {
  instructions: iosInstructions,
  tools: iosExternalToolPrompts,
};

export const iosManagedPromptPack: IosManagedPromptPack = {
  instructions: managedIosInstructions,
  tools: iosManagedToolPrompts,
};
