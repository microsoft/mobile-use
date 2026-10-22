import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "mobile-use");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const packageInfo = await readJson(path.join(root, "package.json"));
const manifest = await readJson(path.join(root, "plugin", "plugin.json"));
const mcp = await readJson(path.join(root, "plugin", "mcp.json"));

if (
  manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
  manifest.name !== "mobile-use" ||
  manifest.version !== packageInfo.version ||
  manifest.license !== "MIT" || packageInfo.license !== "MIT" ||
  mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
) {
  throw new Error("Plugin manifest, schema, or package version is inconsistent.");
}

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "server"), { recursive: true });
await cp(path.join(root, "plugin"), output, { recursive: true });
await cp(path.join(root, "LICENSE"), path.join(output, "LICENSE"));

const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "src", "index.ts")],
  outfile: path.join(output, "server", "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "eof",
  metafile: true,
  banner: {
    js: 'import { createRequire as mobileUseCreateRequire } from "node:module"; const require = mobileUseCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});

for (const bundle of Object.values(result.metafile.outputs)) {
  for (const dependency of bundle.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) {
      throw new Error(`Plugin runtime dependency was not bundled: ${dependency.path}.`);
    }
  }
}

const dependencies = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = path.resolve(root, input).split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0) continue;
  const count = parts[index + 1]?.startsWith("@") ? 3 : 2;
  const directory = parts.slice(0, index + count).join(path.sep);
  dependencies.set(directory, await readJson(path.join(directory, "package.json")));
}

let notices = await readFile(path.join(root, "THIRD_PARTY_NOTICES"), "utf8");
for (const [directory, dependency] of [...dependencies].sort((a, b) =>
  a[1].name.localeCompare(b[1].name),
)) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(licen[cs]e|notice)(?:[._-].*)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  notices += `\n\n=== ${dependency.name}@${dependency.version} (${dependency.license}) ===\n`;
  if (!files.some((file) => /^licen[cs]e/i.test(file))) {
    const fallback = path.join(root, "third_party", "npm-licenses", ...dependency.name.split("/"), dependency.version, "LICENSE");
    if (!existsSync(fallback)) {
      throw new Error(`License text missing for bundled dependency ${dependency.name}@${dependency.version}.`);
    }
    await cp(path.dirname(fallback), path.join(output, "licenses", "npm-licenses", ...dependency.name.split("/"), dependency.version), {
      recursive: true,
    });
    notices += `\n--- Version-pinned upstream LICENSE; see licenses/npm-licenses provenance ---\n${await readFile(fallback, "utf8")}`;
  }
  for (const file of files) {
    notices += `\n--- ${file} ---\n${await readFile(path.join(directory, file), "utf8")}`;
  }
}
await writeFile(path.join(output, "THIRD_PARTY_NOTICES"), notices);

for (const relative of [
  "plugin.json",
  "mcp.json",
  path.join("server", "index.mjs"),
  path.join("skills", "mobile-use", "SKILL.md"),
  "LICENSE",
  "THIRD_PARTY_NOTICES",
]) {
  if (!existsSync(path.join(output, relative))) {
    throw new Error(`Plugin artifact is incomplete: ${relative}.`);
  }
}
console.log(`Built dist\\mobile-use (${dependencies.size} bundled dependencies).`);
