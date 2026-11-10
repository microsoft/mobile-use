import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { publicError } from "./errors.js";
import type { MobileService } from "./mobile-service.js";
import { createMobileUseServer } from "./tools.js";

export function startMobileUseServer(createService: () => MobileService): void {
  try {
    const service = createService();
    const handle = serveStdio(() => createMobileUseServer(service), {
      onerror: () => process.stderr.write("mobile-use: MCP protocol/transport error.\n"),
    });
    const stop = (): Promise<void> => Promise.resolve(service.stop()).catch(() => {
      process.stderr.write("mobile-use: device session cleanup failed; check the owned session on the device.\n");
      process.exitCode = 1;
    });
    const shutdown = (): void => {
      void stop().then(() => handle.close()).catch(() => {
        process.stderr.write("mobile-use: MCP shutdown failed.\n");
        process.exitCode = 1;
      });
    };
    process.stdin.once("end", () => { void stop(); });
    process.stdin.once("close", () => { void stop(); });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    process.stderr.write(`mobile-use: MCP server initialization failed (${publicError(error).code}).\n`);
    process.exitCode = 1;
  }
}
