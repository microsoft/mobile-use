import { AdbClient } from "./adb.js";
import { MobileUseService } from "./device-session.js";
import { MobileUseError } from "./errors.js";
import { IosMobileUseService } from "./ios/device-session.js";
import type { MobileService } from "./mobile-service.js";
import { ManagedIosRuntimePool, readRuntimeConfig } from "./ios/runtime.js";
import { runtimeFailure } from "./ios/runtime-process.js";

export function createMobileService(environment: NodeJS.ProcessEnv = process.env): MobileService {
  const platform = environment.MOBILE_USE_PLATFORM ?? "android";
  if (platform === "android") return new MobileUseService(new AdbClient());
  if (platform === "ios") {
    const mode = environment.MOBILE_USE_IOS_RUNTIME ?? "external";
    if (mode === "external") return new IosMobileUseService(environment.MOBILE_USE_WDA_URL);
    return new IosMobileUseService(
      environment.MOBILE_USE_WDA_URL,
      Date.now,
      new ManagedIosRuntimePool(() => {
        if (mode !== "managed") throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
        return readRuntimeConfig(environment);
      }),
    );
  }
  throw new MobileUseError("INVALID_INPUT", "MOBILE_USE_PLATFORM must be android or ios.",
    "Correct the plugin environment and restart Copilot.");
}
