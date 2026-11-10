import { cp } from "node:fs/promises";

await cp(
  new URL("../plugins/mobile-use/assets", import.meta.url),
  new URL("../.test-build/assets", import.meta.url),
  { recursive: true },
);
