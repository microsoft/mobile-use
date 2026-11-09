import { AdbClient } from "./adb.js";
import { MobileUseService } from "./device-session.js";
import { MobileUseError } from "./errors.js";
import { IosMobileUseService } from "./ios/device-session.js";
import type { MobileService } from "./mobile-service.js";

export function createMobileService(environment: NodeJS.ProcessEnv = process.env): MobileService {
  const platform = environment.MOBILE_USE_PLATFORM ?? "android";
  if (platform === "android") return new MobileUseService(new AdbClient());
  if (platform === "ios") return new IosMobileUseService(environment.MOBILE_USE_WDA_URL);
  throw new MobileUseError("INVALID_INPUT", "MOBILE_USE_PLATFORM must be android or ios.",
    "Correct the plugin environment and restart Copilot.");
}
