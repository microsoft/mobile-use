import { joinPrompt, type MultiPlatformSetupStage, type SetupGuidance } from "../contracts.js";

export type MultiPlatformSetupGuidance = SetupGuidance<MultiPlatformSetupStage>;

export const multiPlatformDeviceSelectionInstructions = joinPrompt([
  "For a user-requested task targeting one phone when only a single endpoint across enabled platforms has selectable: true, state which device/connection you are using and call mobile_select_device without asking a redundant selection question, unless the user requested a different platform, device, or connection.",
  "Honor any user-specified platform, device, or connection; if it is unavailable or ambiguous, ask instead of substituting across platforms or transports.",
  "When the user wants to control both an Android device and an iOS device (or multiple devices simultaneously), call mobile_select_device for each requested endpoint and keep their targetTokens strictly separate.",
  "With multiple candidate endpoints for a single-device request, ask which exact endpoint to use unless the user's choice is already clear; USB and Wi-Fi count separately even on the same phone.",
  "Never automatically reselect or fail over across endpoints or platforms after transport loss, runtime stop, or server restart.",
]);

export const multiPlatformHostSetup: MultiPlatformSetupGuidance = {
  stage: "host-setup",
  steps: [
    "Clarify whether the user wants to connect an Android 11+ device, an iOS 17+ device, or both simultaneously, and guide only the missing host prerequisites for their requested platform(s).",
    "For Android: install Android SDK Platform-Tools (or locate Android Studio's SDK platform-tools) so adb is available, enable Developer options and USB or modern Wireless debugging on the phone, and use mobile_start_adb_server if the local ADB server at 127.0.0.1:5037 is not running.",
    "For iOS (managed USB): use Apple USB services on Windows or macOS with go-ios v1.3.2, a physical iOS 17.4.1+ device with Developer Mode enabled, and MOBILE_USE_IOS_RUNNER_BUNDLE_ID set to a user-signed WebDriverAgent .xctrunner bundle ID; then prepare the chosen ios:usb:<UDID> endpoint via mobile_ios_runtime.",
    "For iOS (external WDA): start a dedicated user-signed WebDriverAgent Runner and local port forwarding, set MOBILE_USE_WDA_URL to its http://127.0.0.1:<port> endpoint, and reopen Copilot.",
  ],
};

export function buildMultiPlatformSelectDeviceSetup(selectableCount: number): MultiPlatformSetupGuidance {
  return {
    stage: "select-device",
    steps: [
      "Show discovered Android and iOS endpoint IDs, platform labels, and transport/readiness states, including unready entries.",
      selectableCount === 1
        ? "Only one endpoint is currently selectable. If it matches the user's requested platform/device, state the connection and call mobile_select_device without an extra selection question; if the user asked for a different device or platform, guide setup for that device instead of substituting."
        : "Multiple endpoints are selectable. Select each explicitly requested device, or ask which exact endpoint(s) to use when ambiguous; keep each selected device's targetToken isolated.",
      "Discovery alone is not permission to observe or control screen content; confirm a safe task scope and observe approved non-sensitive content before dispatching UI input.",
    ],
  };
}
