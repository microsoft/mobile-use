import type { ErrorCode } from "./errors.js";
import {
  adbServerSetup,
  authorizationSetup,
  buildAndroidSelectDeviceSetup,
  connectionSetup,
  deviceSelectionInstructions,
  phoneSetup,
  platformToolsSetup,
  serverConflictSetup,
  type AndroidSetupGuidance,
} from "./prompts/android/setup.js";
import { androidServerInstructions } from "./prompts/android/instructions.js";
import type { DeviceEndpoint } from "./types.js";

export { deviceSelectionInstructions, phoneSetup };
export const onboardingInstructions = androidServerInstructions;

export function setupForError(code: ErrorCode, actionMayHaveRun = false): AndroidSetupGuidance | undefined {
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

export function setupForDevices(devices: readonly DeviceEndpoint[]): AndroidSetupGuidance {
  const selectableCount = devices.filter((device) => device.selectable).length;
  if (selectableCount > 0) return buildAndroidSelectDeviceSetup(selectableCount);
  if (devices.length === 0) return phoneSetup;
  if (devices.some((device) => device.state === "unauthorized")) return authorizationSetup;
  return connectionSetup;
}
