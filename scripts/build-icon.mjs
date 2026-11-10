import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: 'import icon from "./assets/mobile-use.png"; export { icon as mobileUseIcon };',
    loader: "ts",
    resolveDir: root,
    sourcefile: "mobile-use-icon.ts",
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  loader: { ".png": "dataurl" },
  minify: true,
  write: false,
  logLevel: "warning",
});
const output = result.outputFiles[0];
if (!output) throw new Error("Icon data URI generation produced no output.");
await writeFile(path.join(root, "src", "mobile-use-icon.generated.ts"), output.contents);
