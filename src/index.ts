import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AdbClient } from "./adb.js";
import { MobileUseService } from "./device-session.js";
import { createMobileUseServer } from "./tools.js";

try {
  const service = new MobileUseService(new AdbClient());
  const handle = serveStdio(() => createMobileUseServer(service), {
    onerror: () => process.stderr.write("mobile-use: MCP protocol/transport error.\n"),
  });
  const shutdown = (): void => {
    service.stop();
    void handle.close().catch(() => {
      process.stderr.write("mobile-use: MCP shutdown failed.\n");
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", () => service.stop());
  process.stdin.once("close", () => service.stop());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  process.stderr.write("mobile-use: MCP server initialization failed.\n");
  process.exitCode = 1;
}
