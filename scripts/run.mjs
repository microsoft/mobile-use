import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "demo" && mode !== "test") {
  throw new Error("Usage: node . <demo|test>");
}
const target = mode === "demo"
  ? new URL("../.test-build/src/msmt/demo.js", import.meta.url)
  : new URL("../.test-build/test/msmt.test.js", import.meta.url);
const args = [...(mode === "test" ? ["--test"] : []), fileURLToPath(target)];
const child = spawnSync(process.execPath, args, { stdio: "inherit" });
if (child.error) throw child.error;
if (child.status === null) throw new Error(`MSMT ${mode} process terminated: ${child.signal}`);
process.exitCode = child.status;
