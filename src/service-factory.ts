import { AdbClient } from "./adb.js";
import { MobileUseService } from "./device-session.js";
import { MobileUseError } from "./errors.js";
import { IosMobileUseService } from "./ios/device-session.js";
import type { MobileService } from "./mobile-service.js";
import { ManagedIosRuntime, readRuntimeConfig } from "./ios/runtime.js";

export function createMobileService(environment: NodeJS.ProcessEnv = process.env): MobileService {
  const platform = environment.MOBILE_USE_PLATFORM ?? "android";
  if (platform === "android") return new MobileUseService(new AdbClient());
  if (platform === "ios") {
    const mode = environment.MOBILE_USE_IOS_RUNTIME ?? "external";
    if (mode === "external") return new IosMobileUseService(environment.MOBILE_USE_WDA_URL);
    if (mode === "managed" && !environment.MOBILE_USE_WDA_URL) {
      return new IosMobileUseService(undefined, Date.now, new ManagedIosRuntime(readRuntimeConfig(environment)));
    }
    throw new MobileUseError("IOS_RUNTIME_CONFIG_INVALID",
      "Use MOBILE_USE_IOS_RUNTIME=external or managed; managed mode cannot also configure MOBILE_USE_WDA_URL.",
      "Use one explicit runtime mode and restart Copilot.");
  }
  throw new MobileUseError("INVALID_INPUT", "MOBILE_USE_PLATFORM must be android or ios.",
    "Correct the plugin environment and restart Copilot.");
}
