import { build } from "esbuild";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "mobile-use");
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--check" && arg !== "--marketplace")) {
  throw new Error("Usage: node scripts\\build-plugin.mjs [--check | --marketplace]");
}
const check = args.includes("--check");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const packageInfo = await readJson(path.join(root, "package.json"));
const manifest = await readJson(path.join(pluginRoot, "plugin.json"));
const mcp = await readJson(path.join(pluginRoot, "mcp.json"));

if (
  manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
  manifest.name !== "mobile-use" ||
  manifest.version !== packageInfo.version ||
  manifest.license !== "MIT" || packageInfo.license !== "MIT" ||
  mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
) {
  throw new Error("Plugin manifest, schema, or package version is inconsistent.");
}

for (const relative of [
  "plugin.json",
  "mcp.json",
  path.join("assets", "mobile-use.png"),
  path.join("skills", "mobile-use", "SKILL.md"),
  path.join("skills", "mobile-use", "references", "screen-recording.md"),
]) {
  if (!existsSync(path.join(pluginRoot, relative))) {
    throw new Error(`Plugin artifact is incomplete: ${relative}.`);
  }
}

const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "src", "index.ts")],
  outfile: path.join(pluginRoot, "server", "index.mjs"),
  write: false,
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
if (result.outputFiles.length !== 1) {
  throw new Error("Plugin build did not produce exactly one server bundle.");
}

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

// esbuild cannot see dependencies that the published SDK has already bundled.
for (const dependency of [...dependencies.values()]) {
  if (dependency.name !== "@modelcontextprotocol/server") continue;
  const relative = path.join("npm-licenses", ...dependency.name.split("/"), dependency.version);
  const auditDirectory = path.join(root, "third_party", relative);
  const auditFile = path.join(auditDirectory, "embedded-dependencies.json");
  if (!existsSync(auditFile) || !existsSync(path.join(auditDirectory, "PROVENANCE"))) {
    throw new Error(`Embedded dependency audit/provenance missing for ${dependency.name}@${dependency.version}.`);
  }
  const embeddedDependencies = await readJson(auditFile);
  for (const embedded of embeddedDependencies) {
    const embeddedRelative = path.join("npm-licenses", ...embedded.name.split("/"), embedded.version);
    const directory = path.join(root, "third_party", embeddedRelative);
    if (!existsSync(path.join(directory, "LICENSE")) || !existsSync(path.join(directory, "PROVENANCE"))) {
      throw new Error(`License/provenance missing for embedded dependency ${embedded.name}@${embedded.version}.`);
    }
    dependencies.set(directory, embedded);
  }
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
    notices += `\n--- Version-pinned upstream LICENSE; provenance retained in the source repository ---\n${await readFile(fallback, "utf8")}`;
  }
  for (const file of files) {
    notices += `\n--- ${file} ---\n${await readFile(path.join(directory, file), "utf8")}`;
  }
}
// The tracked plugin uses LF even when source files are checked out with CRLF.
const generated = [
  [path.join("server", "index.mjs"), result.outputFiles[0].text],
  ["LICENSE", await readFile(path.join(root, "LICENSE"), "utf8")],
  ["THIRD_PARTY_NOTICES", notices],
].map(([relative, contents]) => [relative, contents.replace(/\r\n/g, "\n")]);

if (check) {
  const expectedEntries = new Set(["plugin.json", "mcp.json", "assets", "skills", "server", "LICENSE", "THIRD_PARTY_NOTICES"]);
  const differences = (await readdir(pluginRoot)).filter((entry) => !expectedEntries.has(entry));
  try {
    for (const entry of await readdir(path.join(pluginRoot, "server"))) {
      if (entry !== "index.mjs") differences.push(path.join("server", entry));
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    differences.push("server");
  }
  for (const [relative, expected] of generated) {
    try {
      const actual = await readFile(path.join(pluginRoot, relative), "utf8");
      if (actual.replace(/\r\n/g, "\n") !== expected) differences.push(relative);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      differences.push(relative);
    }
  }
  if (differences.length > 0) {
    throw new Error(
      `Plugin package is out of date: ${differences.join(", ")}. Run npm run build:plugin and commit the regenerated assets in plugins\\mobile-use.`,
    );
  }
  console.log(`Verified plugins\\mobile-use (${dependencies.size} bundled dependencies).`);
} else {
  await rm(path.join(pluginRoot, "server"), { recursive: true, force: true });
  await rm(path.join(pluginRoot, "licenses"), { recursive: true, force: true });
  await mkdir(path.join(pluginRoot, "server"), { recursive: true });
  for (const [relative, contents] of generated) {
    await writeFile(path.join(pluginRoot, relative), contents);
  }
  console.log(`Built plugins\\mobile-use (${dependencies.size} bundled dependencies). Authored manifests, assets, and skills are unchanged.`);
}
