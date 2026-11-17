import type { ErrorCode } from "../errors.js";
import { iosInstructions, managedIosInstructions } from "../prompts/multi-platform/ios-instructions.js";
import {
  buildIosSelectDeviceSetup,
  iosSetup,
  managedIosSetup,
  type IosSetupGuidance,
} from "../prompts/multi-platform/ios-setup.js";
import type { DeviceEndpoint } from "../types.js";

export { iosInstructions, iosSetup, managedIosInstructions, managedIosSetup };

const iosErrorCodes = new Set<ErrorCode>([
  "WDA_CONFIG_INVALID",
  "WDA_UNAVAILABLE",
  "WDA_RESPONSE_INVALID",
  "WDA_SESSION_CONFLICT",
  "TRANSPORT_LOST",
  "DEVICE_NOT_FOUND",
  "DEVICE_UNSUPPORTED",
  "UNSUPPORTED_HOST",
  "IOS_RUNTIME_CONFIG_INVALID",
  "IOS_RUNTIME_NOT_READY",
  "IOS_RUNTIME_CONFLICT",
  "IOS_RUNTIME_FAILED",
  "IOS_RUNTIME_CLEANUP_FAILED",
  "IOS_USB_UNAVAILABLE",
]);

export function setupForIosError(code: ErrorCode, managed = false): IosSetupGuidance | undefined {
  if (!iosErrorCodes.has(code)) return undefined;
  return managed ? managedIosSetup : iosSetup;
}

export function setupForIosDevices(devices: readonly DeviceEndpoint[], managed = false): IosSetupGuidance {
  if (devices.some((device) => device.selectable)) {
    return buildIosSelectDeviceSetup(managed);
  }
  return managed ? managedIosSetup : iosSetup;
}
