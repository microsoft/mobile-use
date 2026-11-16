import { joinPrompt } from "../contracts.js";
import { androidApprovalInstructions } from "../shared/consent.js";
import { multiPlatformDeviceSelectionInstructions } from "./setup.js";

const multiPlatformOnboardingPrelude = joinPrompt([
  "This server supports simultaneous Android 11+ and iOS 17+ device sessions in the same conversation.",
  "On first use in each session, call mobile_doctor and mobile_list_devices before device control.",
  "A missing host stack on one platform does not block ready devices on the other platform: guide setup only for the platform(s) the user actually wants to use.",
  "Never install host software, sign or pair iOS Runners, enable debugging, or accept device trust prompts automatically.",
  "For Android ADB daemon unavailability during an Android task, call mobile_start_adb_server without a separate conversational approval question; it affects only local ADB (127.0.0.1:5037) and never disturbs active iOS sessions.",
  "For USB iOS endpoints (ios:usb:<UDID>) requiring managed WebDriverAgent startup, obtain explicit approval for that exact endpoint before calling mobile_ios_runtime (action.kind: start), poll status, wait for explicit user confirmation of Developer App trust before confirm_trust, and select the endpoint once ready.",
]);

const multiDeviceIsolationInstructions = joinPrompt([
  "Multiple Android and iOS devices can be selected concurrently. Each mobile_select_device call returns a distinct targetToken bound to that exact physical endpoint.",
  "Keep targetTokens and observationIds strictly paired per device: never send one device's observationId to another device's targetToken, and never fail over from iOS to Android or across USB/Wi-Fi transports on error.",
  "Re-selecting the same physical device replaces and invalidates only that device's prior targetToken while preserving other active device sessions.",
]);

const platformCapabilityInstructions = joinPrompt([
  "Use mobile_observe, mobile_tap, mobile_swipe, mobile_press_key, mobile_input_text, and mobile_app_management across selected targets according to each target's platform capabilities.",
  "Android targets support tap/long_press/double_tap (with approved gesture-helper prepare), swipe, BACK/HOME/ENTER, ASCII and prepared-helper Unicode text input (appended at end of active focused EditText; window IDs are capture-local and pointerTarget buttons preserve native clickable flags; background node focus does not authorize typing), mobile_wake (waking and verified unsecured-keyguard dismissal), mobile_screen_recording (capabilities/start/status/stop silent MP4), and mobile_app_management (list/foreground/launch/terminate/install/uninstall).",
  "iOS targets use WebDriverAgent over screenshot-pixel coordinates (converted to iOS points), support tap/long_press/double_tap and Unicode text input at the current cursor without helper prepare, support HOME (and hardware volume keys where exposed, never BACK or ENTER), and support mobile_app_management foreground/launch by exact Bundle ID.",
  "mobile_wake, mobile_screen_recording, helper prepare, BACK/ENTER, and app list/terminate/install/uninstall are Android-only and fail explicitly on iOS targets; never simulate iOS BACK with a guessed swipe or start unapproved recording streams.",
  "In screenshot-free mode (includeScreenshot: false), neither platform captures images during observation, input revalidation, or post-action results; coordinate gestures are blocked without screenshots.",
  "Pointer gestures enforce metadata-first guards and local visual fallback bounds ({x,y,width,height}) where supported; changed, disabled, or ambiguous controls never fall back to pixels, and stale observations are never proof of an app security block. Never replay uncertain mutations or inputs.",
]);

export const multiPlatformServerInstructions = joinPrompt([
  multiPlatformOnboardingPrelude,
  multiPlatformDeviceSelectionInstructions,
  multiDeviceIsolationInstructions,
  androidApprovalInstructions,
  platformCapabilityInstructions,
]);
