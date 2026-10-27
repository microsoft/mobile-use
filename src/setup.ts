import type { ErrorCode } from "./errors.js";
import type { DeviceEndpoint } from "./types.js";

interface SetupGuidance {
  stage: "platform-tools" | "adb-server" | "phone" | "authorization" | "connection" | "select-device";
  steps: string[];
}

export const onboardingInstructions =
  "On first use in each session, call mobile_doctor before discovery or device control. " +
  "Its ready status covers host Platform-Tools only, not phone setup. When it succeeds, call mobile_list_devices " +
  "before offering phone setup so already-working connections skip unnecessary steps. For blockers, follow setup.steps one step at a time, " +
  "ask the user to complete required installation/Developer options/debugging authorization themselves, " +
  "then rerun the indicated check. Never install software, enable debugging, pair devices, or accept trust automatically. " +
  "If the local ADB server is unavailable, ask for explicit permission to use mobile_start_adb_server. " +
  "Only after approval, use that tool to start a missing local server, verify readiness, and retry discovery. " +
  "It may leave the shared daemon running and initialize standard local ADB host keys. Never call it automatically from doctor/discovery, " +
  "kill or restart an existing server, or replay uncertain startup. A conflict requires user resolution, not another start attempt. " +
  "Use mobile_list_devices to verify connectivity, preserve unauthorized/offline states and discovery errors, " +
  "and ask which exact endpoint to select. Do not repeat setup steps already verified by current diagnostics. " +
  "No screen observation or control until an explicit target and safe task are authorized. " +
  "When the user requests no screenshots, call mobile_observe with includeScreenshot: false. " +
  "This reads only the UI hierarchy and display state; mobile_act preserves that mode without screen capture. " +
  "Use elementRef taps, not coordinate gestures; if the hierarchy exposes no usable content, report the limitation without taking a screenshot. " +
  "App-management tools require the selected target token but no screen observation. " +
  "List/foreground reads may expose sensitive app metadata. Launch only the requested installed package. " +
  "Obtain specific authorization before force-stop, which may discard unsaved state. " +
  "Ask for explicit approval before installing a specified local APK or uninstalling a specified package and its current-user data. " +
  "Installation supports Android .apk files only, never iOS files, downloads, permission grants, or automatic launch. " +
  "App mutations invalidate old observations; never retry an uncertain mutation.";

const platformToolsSetup: SetupGuidance = {
  stage: "platform-tools",
  steps: [
    "Download Android SDK Platform-Tools for Windows from https://developer.android.com/tools/releases/platform-tools and review Google's download terms yourself. Only Platform-Tools (adb.exe) is needed; Android Studio and the full SDK are not required.",
    "Extract the platform-tools folder under %LOCALAPPDATA%\\Android\\Sdk so adb.exe is at %LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe, or add its folder to PATH / set MOBILE_USE_ADB_PATH to its absolute adb.exe path. Correct a stale explicit override if one is already set.",
    "Fully quit and reopen Copilot after changing its environment, then rerun mobile_doctor. Do not continue to device control while this check fails.",
  ],
};

const adbServerSetup: SetupGuidance = {
  stage: "adb-server",
  steps: [
    "The local ADB server is unavailable; this does not establish whether a phone is connected.",
    "Ask for explicit permission to start a missing local ADB server using mobile_start_adb_server. Explain that it uses 127.0.0.1:5037, may remain running after the plugin exits, and may initialize standard local ADB host keys. If approval is declined, stop this setup step without starting anything.",
    "Only after approval, call mobile_start_adb_server; it verifies readiness, reuses a compatible existing server, and retries read-only discovery. Follow the returned device setup/selection steps. It never kills/restarts a shared server or authorizes a phone. If it fails or reports a conflict, stop and report the error rather than retrying startup or changing firewall/remote-server settings.",
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
    "Use a real Android 11+ phone. An empty inventory does not prove Developer options/debugging is disabled; check only incomplete steps. Ask whether the user wants USB (recommended for first setup) or modern paired wireless; do not choose a device or connection silently.",
    "On the phone, open Settings > About phone and locate Build number (some brands use Software information or an OS-version entry). Tap it seven times to enable Developer options. Menu names vary: ask for the model if the path is unclear. Enter any phone PIN only on the phone; never send it to Copilot. Official guide: https://developer.android.com/studio/debug/dev-options",
    "For USB, enable USB debugging in Developer options yourself, connect a data-capable cable, unlock the phone, and accept only the intended computer's RSA debugging prompt. Developer options alone is not enough. Do not enable OEM unlocking or unrelated security options.",
    "For modern wireless instead, enable Wireless debugging, then pair/connect from your own terminal following https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi. Enter pairing codes only into adb's local prompt, never into Copilot; pairing and connection ports differ. Do not use legacy adb tcpip.",
    "Rerun mobile_list_devices. If USB inventory remains empty, check the cable/USB port and the manufacturer's Windows USB-driver guidance at https://developer.android.com/studio/run/oem-usb. Do not install drivers automatically or bypass managed-device restrictions.",
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
  if (devices.some((device) => device.selectable)) {
    return {
      stage: "select-device",
      steps: [
        "Show all endpoint IDs and transport/state information, including unavailable entries. Ask which exact endpoint the user wants unless their choice is already explicit; USB and Wi-Fi can be the same phone.",
        "Call mobile_select_device for that endpoint to qualify real Android 11+ hardware and wireless evidence when applicable. Discovery alone is not completed device qualification or permission to observe/control the phone.",
      ],
    };
  }
  if (devices.length === 0) return phoneSetup;
  if (devices.some((device) => device.state === "unauthorized")) return authorizationSetup;
  return connectionSetup;
}
