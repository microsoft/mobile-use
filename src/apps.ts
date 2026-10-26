import { access, constants, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { checkCancelled, MobileUseError } from "./errors.js";
import { packageNameSchema } from "./types.js";
import type { ForegroundApp, InstalledApps } from "./types.js";

export function validatePackageName(packageName: string): void {
  if (!packageNameSchema.safeParse(packageName).success) {
    throw new MobileUseError("INVALID_INPUT", "The Android package name is invalid.", "Use the exact requested app's Android package name.");
  }
}

export function parseAndroidUser(output: string): number {
  const value = output.trim();
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new MobileUseError("APP_STATE_UNAVAILABLE", "The current Android user could not be established.", "Check the selected device's active user before managing apps.");
  }
  return Number(value);
}

export function parseInstalledApps(output: string, userId: number): InstalledApps {
  const unavailable = (): never => {
    throw new MobileUseError("APP_LIST_UNAVAILABLE", "Android did not return a complete supported app inventory.", "Check the selected device's package-manager access. Malformed or oversized inventories are not truncated.");
  };
  if (Buffer.byteLength(output) > 1024 * 1024) unavailable();
  const packages = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const name = line.startsWith("package:") ? line.slice(8) : "";
    if (!packageNameSchema.safeParse(name).success || packages.has(name) || packages.size >= 10_000) unavailable();
    packages.add(name);
  }
  return { userId, apps: [...packages].sort().map((packageName) => ({ packageName })) };
}

export function parseForegroundApp(output: string): ForegroundApp | null {
  const unavailable = (): never => {
    throw new MobileUseError("APP_FOREGROUND_UNAVAILABLE", "The foreground app on the primary display could not be established.", "Check the phone manually. Unrecognized or ambiguous activity diagnostics cannot identify a foreground app.");
  };
  if (Buffer.byteLength(output) > 2 * 1024 * 1024) unavailable();
  let lines = output.split(/\r?\n/);
  const displays = lines.flatMap((line, index) => {
    const match = /^\s*Display #(\d+)\b/.exec(line);
    return match ? [{ id: match[1], index }] : [];
  });
  if (displays.length) {
    const primary = displays.filter((display) => display.id === "0");
    const start = primary.length === 1 ? primary[0]?.index : undefined;
    if (start === undefined) return unavailable();
    lines = lines.slice(start + 1, displays.find((display) => display.index > start)?.index);
  }
  const top = lines.filter((line) => /^\s*topResumedActivity\s*[=:]/.test(line));
  const resumed = top.length ? top : lines.filter((line) => /^\s*(?:mResumedActivity|ResumedActivity)\s*[=:]/.test(line));
  if (!resumed.length) unavailable();
  const apps = new Map<string, ForegroundApp>();
  let noActivity = false;
  for (const line of resumed) {
    const value = line.replace(/^\s*(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[=:]\s*/, "").trim();
    if (value === "null") {
      noActivity = true;
      continue;
    }
    const match = /^ActivityRecord\{\S+\s+u(0|[1-9]\d*)\s+([^/\s]+)\/(\.?[A-Za-z0-9_.$]+)\s+[^{}\r\n]*\}$/.exec(value);
    const packageName = match?.[2];
    const activityName = match?.[3];
    const userId = Number(match?.[1]);
    if (!packageName || !activityName || !packageNameSchema.safeParse(packageName).success ||
      !Number.isSafeInteger(userId)) return unavailable();
    const app = { packageName, activityName, userId };
    apps.set(JSON.stringify(app), app);
  }
  if (apps.size > 1 || (apps.size && noActivity)) unavailable();
  return apps.values().next().value ?? null;
}

export function parsePackageStopped(output: string, userId: number): boolean {
  const unavailable = (): never => {
    throw new MobileUseError("APP_STATE_UNAVAILABLE", "The app's stopped state could not be verified.", "Check the requested app before repeating a termination.");
  };
  if (Buffer.byteLength(output) > 1024 * 1024) unavailable();
  // Package dumps also contain user headings in unrelated diagnostic sections.
  const users = output.split(/\r?\n/).filter((line) =>
    new RegExp(`^\\s*User ${userId}:`).test(line) && /\b(?:installed|stopped)=/.test(line));
  const state = users.length === 1 ? users[0] : undefined;
  const stopped = state ? [...state.matchAll(/\bstopped=(\S+)/g)] : [];
  const installed = state ? [...state.matchAll(/\binstalled=(\S+)/g)] : [];
  if (installed.length !== 1 || installed[0]?.[1] !== "true" || stopped.length !== 1 ||
    !["true", "false"].includes(stopped[0]?.[1] ?? "")) unavailable();
  return stopped[0]?.[1] === "true";
}

export async function localApkFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const invalid = (): never => {
    throw new MobileUseError("INVALID_APP_FILE", "Installation requires a readable local .apk file, between 1 byte and 512 MiB, at an absolute drive path.", "Choose an existing local Android APK. URLs, UNC/device paths, directories, .ipa, .app, .zip, and split APK bundles are unsupported.");
  };
  const validPath = (value: string): boolean => /^[A-Za-z]:[\\]/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value) && !value.slice(2).includes(":") &&
    path.extname(value).toLowerCase() === ".apk";
  checkCancelled(signal);
  if (!validPath(filePath)) invalid();
  try {
    const resolved = await realpath(filePath);
    if (!validPath(resolved)) invalid();
    const info = await stat(resolved);
    if (!info.isFile() || info.size < 1 || info.size > 512 * 1024 * 1024) invalid();
    await access(resolved, constants.R_OK);
    checkCancelled(signal);
    return resolved;
  } catch (error) {
    if (error instanceof MobileUseError) throw error;
    return invalid();
  }
}
