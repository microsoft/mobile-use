import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/client";

export async function assertMobileIcons(
  client: Client,
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
): Promise<void> {
  const png = await readFile(new URL("../assets/mobile-use.png", import.meta.url));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
  assert.ok(png.length <= 8192, "Keep repeated tool icon metadata compact.");
  const icons = [{
    src: `data:image/png;base64,${png.toString("base64")}`,
    mimeType: "image/png",
    sizes: ["64x64"],
  }];
  assert.deepEqual(client.getServerVersion()?.icons, icons);
  for (const tool of tools) assert.deepEqual(tool.icons, icons, tool.name);
}
