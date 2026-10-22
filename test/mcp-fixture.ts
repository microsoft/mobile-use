import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MobileUseService } from "../src/device-session.js";
import { createMobileUseServer } from "../src/tools.js";
import { chunk, FakeAdb, FakeMonitors, hierarchy, node } from "./helpers.js";

const adb = new FakeAdb();
const monitors = new FakeMonitors(adb);
if (process.env.MOBILE_USE_FIXTURE_SCENARIO === "secure-keyguard") {
  Object.assign(adb.keyguard, { showing: true, secure: true, inputRestricted: true });
}
if (process.env.MOBILE_USE_FIXTURE_SCENARIO === "uncertain-input") {
  adb.handler = (call) => {
    if (call.options.mutating) throw new Error("private fixture-only dispatch details");
    return undefined;
  };
}
if (process.env.MOBILE_USE_FIXTURE_SCENARIO === "large-observation") {
  const padding = Buffer.alloc(5 * 1024 * 1024 - adb.image.length - 12, 65);
  Buffer.from("fixture\0").copy(padding);
  adb.image = Buffer.concat([adb.image.subarray(0, -12), chunk("tEXt", padding), adb.image.subarray(-12)]);
  adb.xml = hierarchy(node({ text: "A".repeat(1600) }).repeat(280));
}
const service = new MobileUseService(adb, monitors.factory);
const server = serveStdio(() => createMobileUseServer(service));
const stop = (): void => {
  service.stop();
  void server.close().catch(() => {
    process.stderr.write("mobile-use fixture: shutdown failed.\n");
    process.exitCode = 1;
  });
};
process.stdin.once("end", () => service.stop());
process.stdin.once("close", () => service.stop());
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
