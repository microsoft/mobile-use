import type { ErrorCode } from "../errors.js";
import { iosInstructions, managedIosInstructions } from "../prompts/multi-platform/ios-instructions.js";
import {
  buildIosSelectDeviceSetup,
  iosRuntimeSetup,
  iosSetup,
  managedIosSetup,
  type IosSetupGuidance,
} from "../prompts/multi-platform/ios-setup.js";
import type { DeviceEndpoint } from "../types.js";

export { iosInstructions, iosRuntimeSetup, iosSetup, managedIosInstructions, managedIosSetup };

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

const iosRuntimeErrorCodes = new Set<ErrorCode>([
  "IOS_RUNTIME_CONFIG_INVALID",
  "IOS_RUNTIME_NOT_READY",
  "IOS_RUNTIME_CONFLICT",
  "IOS_RUNTIME_FAILED",
  "IOS_RUNTIME_CLEANUP_FAILED",
]);

export function setupForIosError(code: ErrorCode, managed = false): IosSetupGuidance | undefined {
  if (!iosErrorCodes.has(code)) return undefined;
  if (code === "IOS_RUNTIME_CONFIG_INVALID" || (managed && iosRuntimeErrorCodes.has(code))) {
    return iosRuntimeSetup;
  }
  return managed ? managedIosSetup : iosSetup;
}

export function setupForIosDevices(devices: readonly DeviceEndpoint[], managed = false): IosSetupGuidance {
  if (devices.some((device) => device.selectable)) {
    return buildIosSelectDeviceSetup(managed);
  }
  if (managed && devices.some((device) => device.reason?.includes("MOBILE_USE_IOS_RUNNER_BUNDLE_ID"))) {
    return iosRuntimeSetup;
  }
  return managed ? managedIosSetup : iosSetup;
}
