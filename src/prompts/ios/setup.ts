import type { IosSetupStage, SetupGuidance } from "../contracts.js";

export type IosSetupGuidance = SetupGuidance<IosSetupStage>;

export const iosSetup: IosSetupGuidance = {
  stage: "connection",
  steps: [
    "Use a real, manually unlocked iOS 17+ iPhone/iPad and a dedicated, user-built and signed Appium WebDriverAgent Runner. Complete Apple device trust and Developer Mode yourself; no signing materials or credentials belong in chat.",
    "Start the Runner and its forwarding in your own terminal. Set MOBILE_USE_PLATFORM=ios and MOBILE_USE_WDA_URL to its exact http://127.0.0.1:<port> endpoint, then fully restart Copilot. There is no default port or implicit device selection.",
    "Do not share this Runner with Appium or another controller. An existing foreign WDA session is rejected, never replaced. The plugin does not deploy, sign, pair, start, stop, or uninstall the Runner or forwarding.",
    "Rerun mobile_doctor and mobile_list_devices, then explicitly select the returned endpoint. Doctor reads status/device metadata only; selection creates an owned WDA session without launching an App or capturing a screen.",
  ],
};

export const managedIosSetup: IosSetupGuidance = {
  stage: "connection",
  steps: [
    "Use Windows with Apple USB services or macOS, go-ios v1.3.2, and a physical iOS 17.4.1+ device for userspace tunnels. The user supplies an already signed/validated Runner and completes pairing, Developer Mode and developer trust manually.",
    "Configure MOBILE_USE_PLATFORM=ios, MOBILE_USE_IOS_RUNTIME=managed and MOBILE_USE_IOS_RUNNER_BUNDLE_ID with the full .xctrunner ID. Do not set MOBILE_USE_WDA_URL. See docs/ios-mvp.md for optional go-ios, signed IPA and state-directory configuration.",
    "Run mobile_doctor and mobile_list_devices. After explicit approval for the exact USB endpoint, call mobile_ios_runtime with action.kind=start. installRunner defaults to false; true explicitly installs/replaces the configured signed IPA.",
    "start returns preparing with a runtimeToken; poll action.kind=status. When awaiting-developer-trust, ask the user to verify Developer App trust on that device. Only after confirmation call confirm_trust with this token, then poll starting until ready. Never confirm for the user or silently install during discovery.",
    "Once ready, select the USB endpoint and follow the normal mobile_* observation/input flow. Stop with this runtimeToken; invalidate old selections. Runner installation and local pairing/log/image caches are retained.",
  ],
};

export function buildIosSelectDeviceSetup(managed: boolean): IosSetupGuidance {
  return {
    stage: "select-device",
    steps: [
      managed
        ? "Show the USB UDIDs and select only the user's explicitly chosen, ready managed endpoint."
        : "Show the configured WDA endpoint and ask which endpoint to use unless the user's choice is already explicit. This is user-managed forwarding, not independently verified USB discovery.",
      "Call mobile_select_device to create an exclusive WDA session. Selection is not permission to capture or control content; obtain a safe task scope and observe approved non-sensitive content before input.",
    ],
  };
}
