import { joinPrompt, type AndroidSetupStage, type SetupGuidance } from "../contracts.js";

export type AndroidSetupGuidance = SetupGuidance<AndroidSetupStage>;

export const deviceSelectionInstructions = joinPrompt([
  "For a user-requested Android task such as 'use my phone', use the sole endpoint with selectable: true for initial selection without asking a selection question.",
  "State which connection you are using and call mobile_select_device.",
  "Honor any user-specified device or connection; if it is unavailable or ambiguous, ask instead of substituting.",
  "With multiple selectable endpoints, ask which exact endpoint to use unless the user's choice is already clear.",
  "USB and Wi-Fi count as separate endpoints even on the same phone; do not choose by model name.",
  "This single-endpoint rule is for initial selection only, not automatic reselection after transport loss or server restart.",
]);

export const platformToolsSetup: AndroidSetupGuidance = {
  stage: "platform-tools",
  steps: [
    "Download Android SDK Platform-Tools for Windows from https://developer.android.com/tools/releases/platform-tools and review Google's download terms yourself. Only Platform-Tools (adb.exe) is needed; Android Studio and the full SDK are not required.",
    "Extract the platform-tools folder under %LOCALAPPDATA%\\Android\\Sdk so adb.exe is at %LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe, or add its folder to PATH / set MOBILE_USE_ADB_PATH to its absolute adb.exe path. Correct a stale explicit override if one is already set.",
    "Fully quit and reopen Copilot after changing its environment, then rerun mobile_doctor. Do not continue to device control while this check fails.",
  ],
};

export const adbServerSetup: AndroidSetupGuidance = {
  stage: "adb-server",
  steps: [
    "The local ADB server is unavailable; this does not establish whether a phone is connected.",
    "Call mobile_start_adb_server for the user's Android task without a separate conversational approval question. It uses only 127.0.0.1:5037, may remain running after the plugin exits, and may initialize standard local ADB host keys.",
    "It verifies readiness, reuses a compatible existing server or starts a missing one, and retries read-only discovery. Follow the returned device setup/selection steps. It never kills/restarts a shared server or authorizes a phone. If it fails or reports a conflict, stop and report the error rather than retrying startup or changing firewall/remote-server settings.",
  ],
};

export const serverConflictSetup: AndroidSetupGuidance = {
  stage: "adb-server",
  steps: [
    "Stop automatic startup attempts. Leave any existing local process/server running; do not kill, replace, or restart it.",
    "Report the error and let the user resolve local Platform-Tools/version, occupied-port, or startup-policy problems. If startup may have run, verify local server status before considering any further attempt. Retry discovery only after the user has resolved the problem.",
  ],
};

export const phoneSetup: AndroidSetupGuidance = {
  stage: "phone",
  steps: [
    "Use a real Android 11+ phone. An empty inventory does not prove Developer options/debugging is disabled; check only incomplete steps. If no endpoint is selectable and the user's connection preference is unknown, ask whether they want USB (recommended for first setup) or modern paired wireless.",
    "On the phone, open Settings > About phone and locate Build number (some brands use Software information or an OS-version entry). Tap it seven times to enable Developer options. Menu names vary: ask for the model if the path is unclear. Enter any phone PIN only on the phone; never send it to Copilot. Official guide: https://developer.android.com/studio/debug/dev-options",
    "For USB, enable USB debugging in Developer options yourself, connect a data-capable cable, unlock the phone, and accept only the intended computer's RSA debugging prompt. Developer options alone is not enough. Do not enable OEM unlocking or unrelated security options.",
    "For modern wireless instead, enable Wireless debugging, then pair/connect from your own terminal following https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi. Enter pairing codes only into adb's local prompt, never into Copilot; pairing and connection ports differ. Do not use legacy adb tcpip.",
    "Rerun mobile_list_devices. If USB inventory remains empty, check the cable/USB port and the manufacturer's Windows USB-driver guidance at https://developer.android.com/studio/run/oem-usb. Do not install drivers automatically or bypass managed-device restrictions.",
  ],
};

export const authorizationSetup: AndroidSetupGuidance = {
  stage: "authorization",
  steps: [
    "The phone is visible but unauthorized. Unlock it manually and accept only the intended computer's RSA USB-debugging prompt. Do not send a PIN or ADB key to Copilot, or automatically revoke existing debugging trust.",
    "If the prompt does not appear, check USB debugging and reconnect the data cable yourself. Rerun mobile_list_devices and wait for state device before explicitly selecting the endpoint.",
  ],
};

export const connectionSetup: AndroidSetupGuidance = {
  stage: "connection",
  steps: [
    "Restore the chosen connection yourself: unlock the phone, check USB debugging and the data cable/port, or restore the already paired modern wireless connection. Do not silently switch endpoints, revoke trust, or restart the shared ADB server.",
    "Rerun mobile_list_devices. Offline, unauthorized, missing-transport, emulator, and unsupported endpoints are not ready. A real Android 11+ endpoint must be explicitly chosen and qualified by mobile_select_device before use.",
  ],
};

export function buildAndroidSelectDeviceSetup(selectableCount: number): AndroidSetupGuidance {
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
