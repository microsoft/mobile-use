import {
  joinPrompt,
  type CoreToolName,
  type MultiPlatformPromptPack,
  type ToolPrompt,
} from "../contracts.js";
import { androidToolPrompts } from "../android/tools.js";
import { multiPlatformServerInstructions } from "./instructions.js";
import { iosRuntimeToolPrompt } from "./ios-tools.js";
import { multiPlatformDeviceSelectionInstructions } from "./setup.js";

export const multiPlatformToolPrompts: Readonly<Record<CoreToolName | "mobile_ios_runtime", ToolPrompt>> = {
  mobile_ios_runtime: iosRuntimeToolPrompt,
  mobile_doctor: {
    title: "Check mobile setup",
    description: joinPrompt([
      "Start here on first use: diagnose Android (Platform-Tools/ADB) and iOS (managed go-ios v1.3.2 USB runtime or configured local WDA) host readiness and return next-step setup guidance.",
      "Read-only host/status check only: never starts servers/tunnels, installs software, pairs, signs, captures screens, or creates device sessions.",
      "One unconfigured platform does not block a ready platform; follow with mobile_list_devices.",
    ]),
  },
  mobile_start_adb_server: androidToolPrompts.mobile_start_adb_server,
  mobile_list_devices: {
    title: "List devices",
    description: joinPrompt([
      "List connected Android ADB endpoints and available iOS USB/WDA endpoints with platform labels, states, and setup guidance.",
      "Discovery is read-only: never starts runtimes, installs Runners, pairs devices, or creates sessions. Unready USB iOS endpoints require explicit mobile_ios_runtime startup before selection.",
      multiPlatformDeviceSelectionInstructions,
    ]),
  },
  mobile_select_device: {
    title: "Select device",
    description: joinPrompt([
      multiPlatformDeviceSelectionInstructions,
      "Select an exact endpointId from mobile_list_devices and return an isolated targetToken without invalidating other distinct physical devices.",
      "Qualifies real Android 11+ hardware/wireless transport on Android, or creates an exclusive owned WDA session on physical iOS 17+ hardware (rejecting foreign sessions). Re-selecting the same physical device invalidates only its prior token.",
    ]),
  },
  mobile_observe: {
    title: "Observe screen",
    description: joinPrompt([
      "Capture UI hierarchy, foreground app context, verified display geometry, and optional PNG screenshot for the selected Android or iOS targetToken.",
      "All element bounds and coordinates are in screenshot pixels. includeScreenshot defaults to true; false never captures images during observation or subsequent input revalidation/results and blocks coordinate gestures.",
      "Android reports interactive windows (capture-local window IDs, clickable/scrollable/pointerTarget flags); iOS reports active-App roles while omitting secure editor subtrees (screenshots remain unredacted). Observe only approved non-sensitive content.",
    ]),
  },
  mobile_wake: {
    title: "Wake device",
    description: joinPrompt([
      "Android targets only: wake the selected Android phone and dismiss only a verified unsecured lock screen within the user's authorized task without a separate wake approval prompt.",
      "Requires targetToken without observationId and invalidates that device's prior observations. MANUAL_UNLOCK_REQUIRED requires manual user authentication. Fails with UNSUPPORTED_OPERATION on iOS targets; never attempt WDA unlock.",
    ]),
  },
  mobile_tap: {
    title: "Taps",
    description: joinPrompt([
      "Tap, long_press, or double_tap one observed control or guarded coordinate on the targetToken's device (plus Android-only action.kind=prepare for the double-tap DEX helper).",
      "Input actions consume the latest action.observationId (<= 30s old) for that targetToken, enforce metadata-first target/window guards or explicit complete target.bounds local visual fallback, preserve screenshot-free mode, and return a fresh observation.",
      "Android double_tap requires explicit user/session-approved prepare; iOS executes double_tap natively via W3C touch actions and rejects prepare. Never substitute long_press for tap automatically or replay uncertain input.",
    ]),
  },
  mobile_swipe: {
    title: "Swipes",
    description: joinPrompt([
      "Perform one bounded swipe on the targetToken's device using its latest observationId (<= 30s old, consumed on attempt), screenshot-pixel from/to points, and optional durationMs (100-2000, default 400).",
      "Requires both endpoints within an unchanged enabled scrollable elementRef/surface, or explicit full-surface bounds for local visual fallback. Rejected in screenshot-free mode without capturing an image. Never replay uncertain swipes.",
    ]),
  },
  mobile_press_key: {
    title: "Press hardware / navigation key",
    description: joinPrompt([
      "Press one key on the targetToken's device using its latest observationId (<= 30s old, consumed on attempt) and return the next observation in the same screenshot mode.",
      "Android supports BACK, HOME, and ENTER (require specific authorization before consequential ENTER submissions). iOS supports HOME (and hardware volume keys where enabled) and rejects BACK/ENTER; never substitute a guessed swipe for BACK.",
    ]),
  },
  mobile_input_text: {
    title: "Input text",
    description: joinPrompt([
      "Enter 1-256 UTF-16 code units into one unchanged, enabled, focused non-password native editor on the targetToken's device (plus Android-only action.kind=prepare for the Unicode/punctuation DEX helper).",
      "Consumes latest action.observationId (<= 30s old), preserves screenshot-free mode, and never clears, submits, or uses clipboard.",
      "Android requires the active focused application window (background floating-window focus is rejected) and appends at field end when using the explicitly approved text helper; iOS types Unicode natively at the current cursor without prepare and rejects control characters/line breaks. Never replay uncertain input.",
    ]),
  },
  mobile_screen_recording: {
    title: "Screen recording",
    description: joinPrompt([
      "Android targets only: check native capabilities, start, inspect status, or stop/export a silent primary-display MP4 for the selected Android targetToken (unsupported on iOS targets).",
      androidToolPrompts.mobile_screen_recording.description,
    ]),
  },
  mobile_app_management: {
    title: "App management",
    description: joinPrompt([
      "Manage apps on the selected targetToken without screenshots or observationId; mutations invalidate that target's prior observations.",
      "Android supports list, foreground, launch, terminate (requires specific or scoped session consent), install (local .apk, one-action explicit approval), and uninstall (deletes current-user app data, one-action explicit approval) using Android packageName.",
      "iOS supports foreground and launch only using exact iOS Bundle ID in packageName; list, terminate, install, and uninstall fail explicitly on iOS. Never retry uncertain mutations.",
    ]),
  },
};

export const multiPlatformPromptPack: MultiPlatformPromptPack = {
  instructions: multiPlatformServerInstructions,
  tools: multiPlatformToolPrompts,
};
