import { createMobileService } from "./service-factory.js";
import { startMobileUseServer } from "./server-main.js";

startMobileUseServer(createMobileService);
