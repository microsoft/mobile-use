import { startMobileUseServer } from "./server-main.js";
import { AdbClient } from "./adb.js";
import { MobileUseService } from "./device-session.js";

startMobileUseServer(() => new MobileUseService(new AdbClient()));
