import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import { LocalAdbServer, localAdbAddress, serverStartupError } from "./adb-server.js";
import { checkCancelled, MobileUseError } from "./errors.js";
import type { AdbServerResult, DeviceEndpoint, TransportKind } from "./types.js";

export interface RunOptions {
  signal?: AbortSignal;
  mutating?: boolean;
  timeoutMs?: number;
}

export interface AdbConnection {
  executable(): string;
  run(args: readonly string[], options?: RunOptions): Promise<Buffer>;
  startServer(signal?: AbortSignal): Promise<AdbServerResult>;
  stop(): void;
}

export interface CommandOptions extends RunOptions {
  env: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<Buffer>;

export function parseAdbVersion(output: string): { platformToolsVersion: string; serverVersion: number } {
  const tools = /^Version (\d+)\.(\d+)\.(\d+)(?:-\S+)?\s*$/m.exec(output);
  const protocol = /^Android Debug Bridge version 1\.0\.(\d+)\s*$/m.exec(output);
  const serverVersion = Number(protocol?.[1]);
  if (!tools?.[1] || !tools[2] || !tools[3] || Number(tools[1]) < 30 ||
    !Number.isSafeInteger(serverVersion) || serverVersion < 1 || serverVersion > 0xffff) {
    throw new MobileUseError(
      "ADB_VERSION_UNSUPPORTED", "Modern Android Platform-Tools and its server protocol version could not be confirmed.",
      "Use current official Platform-Tools supporting paired Wireless debugging and transport IDs.",
    );
  }
  return { platformToolsVersion: `${tools[1]}.${tools[2]}.${tools[3]}`, serverVersion };
}

export function resolveAdbExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    throw new MobileUseError("UNSUPPORTED_HOST", "The POC supports Windows hosts only.", "Use a Windows host.");
  }
  const configured = env.MOBILE_USE_ADB_PATH;
  if (configured) {
    if (!path.isAbsolute(configured) || path.extname(configured).toLowerCase() !== ".exe") {
      throw new MobileUseError(
        "ADB_CONFIG_UNSUPPORTED",
        "MOBILE_USE_ADB_PATH must be an absolute path to adb.exe.",
        "Set the optional local override to the installed Android Platform-Tools adb.exe.",
      );
    }
    if (!existsSync(configured) || !statSync(configured).isFile()) {
      throw new MobileUseError("ADB_NOT_FOUND", "The configured adb.exe is missing.", "Correct MOBILE_USE_ADB_PATH.");
    }
    return configured;
  }

  const userSdk = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, "Android", "Sdk")
    : env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Local", "Android", "Sdk") : undefined;
  const toolDirectories = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, userSdk]
    .filter((sdk): sdk is string => typeof sdk === "string" && path.isAbsolute(sdk))
    .map((sdk) => path.join(sdk, "platform-tools"));
  const searchPath = (env.PATH ?? env.Path ?? "").split(path.delimiter).map((entry) => {
    return entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
  });
  const visited = new Set<string>();
  for (const directory of [...toolDirectories, ...searchPath]) {
    if (!path.isAbsolute(directory)) continue;
    const executable = path.join(directory, "adb.exe");
    const key = executable.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    if (existsSync(executable) && statSync(executable).isFile()) return executable;
  }
  throw new MobileUseError(
    "ADB_NOT_FOUND",
    "Android Platform-Tools adb.exe was not found.",
    "Install Platform-Tools yourself and add its directory to PATH, or set MOBILE_USE_ADB_PATH. Restart the plugin after changing its environment.",
  );
}

function adbEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "USERPROFILE", "HOME", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA"]) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return result;
}

export const executeCommand: CommandRunner = (executable, args, options) => new Promise((resolve, reject) => {
  checkCancelled(options.signal);
  let spawned = false;
  const child = execFile(executable, [...args], {
    encoding: "buffer",
    windowsHide: true,
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
  }, (error, stdout, stderr) => {
    if (!error) {
      resolve(stdout);
      return;
    }
    const mayHaveRun = options.mutating === true && spawned;
    const details = `${stderr.toString("utf8")}\n${stdout.toString("utf8")}`.toLowerCase();
    let code: ConstructorParameters<typeof MobileUseError>[0] = "ADB_FAILED";
    let message = "ADB could not complete the requested operation.";
    let remediation = "Check the selected device and local ADB setup. Do not replay uncertain input.";
    if (error.code === "ENOENT") {
      code = "ADB_NOT_FOUND";
      message = "adb.exe could not be started.";
      remediation = "Check the installed Platform-Tools path.";
    } else if (options.signal?.aborted) {
      code = "CANCELLED";
      message = "The ADB operation was cancelled.";
    } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      code = "ADB_OUTPUT_LIMIT";
      message = "ADB output exceeded the POC's bounded buffer.";
    } else if (error.killed) {
      code = "ADB_TIMEOUT";
      message = "The ADB operation exceeded its command deadline.";
    } else if (/cannot connect to (?:daemon|(?:adb )?server)|cannot start server|failed to start (?:adb )?(?:daemon|server)|(?:daemon|server) (?:didn't ack|failed to start)/.test(details)) {
      code = "ADB_SERVER_UNAVAILABLE";
      message = "The local ADB server is unavailable.";
      remediation = "Use mobile_start_adb_server for the requested Android task, then retry discovery. Do not kill/restart a shared server or infer the phone's connection state from this failure.";
    } else if (/failure \[install_[a-z0-9_]+/.test(details)) {
      code = "APP_INSTALL_FAILED";
      message = "Android rejected the APK installation.";
      remediation = "Check the APK, signatures, existing app version, and device policy. Do not automatically retry or grant permissions.";
    } else if (/failure \[delete_[a-z0-9_]+/.test(details)) {
      code = "APP_UNINSTALL_FAILED";
      message = "Android rejected the app uninstallation.";
      remediation = "Check the package and device policy. Do not bypass protected-app restrictions or automatically retry.";
    } else if (details.includes("unauthorized")) {
      code = "DEVICE_UNAUTHORIZED";
      message = "The selected device has not authorized this host.";
      remediation = "The user must accept the intended debugging key on the unlocked phone.";
    } else if (details.includes("offline")) {
      code = "DEVICE_OFFLINE";
      message = "The selected device is offline.";
      remediation = "Restore the connection, rediscover, and explicitly reselect.";
    } else if (/not found|no devices|closed|cannot connect|connection reset/.test(details)) {
      code = "TRANSPORT_LOST";
      message = "The selected ADB transport is unavailable.";
      remediation = "Restore the connection, rediscover, and explicitly reselect. No fallback was attempted.";
    }
    if (code === "ADB_FAILED" && args.includes("dev.mobileuse.text.TextMain")) {
      const exit = typeof error.code === "number" ? error.code : "unknown";
      const marker = /^MOBILE_USE_TEXT_V1_(OK|READY|FAILED|UNSUPPORTED|ERROR_(?:REQUEST|CONNECT|CONFIGURE|ROOT|WINDOW|HIERARCHY|TARGET|WRITE|VERIFY|DISCONNECT))\r?$/m.exec(stdout.toString("utf8"))?.[1] ?? "missing";
      const exception = /\bjava\.lang\.(IllegalStateException|IllegalArgumentException|SecurityException|NullPointerException|NoSuchMethodError|NoClassDefFoundError|RuntimeException)\b/.exec(stderr.toString("utf8"))?.[1] ?? "unavailable";
      message = `The text helper process failed (exit ${exit}; result ${marker}; exception ${exception}).`;
    }
    reject(new MobileUseError(code, message, remediation, !mayHaveRun, mayHaveRun));
  });
  child.once("spawn", () => { spawned = true; });
});

export class AdbClient implements AdbConnection {
  private readonly shutdown = new AbortController();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly runner: CommandRunner = executeCommand,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly server: LocalAdbServer = new LocalAdbServer(),
  ) {}

  executable(): string {
    return resolveAdbExecutable(this.env, this.platform);
  }

  async startServer(signal?: AbortSignal): Promise<AdbServerResult> {
    const version = parseAdbVersion((await this.run(["version"], signal ? { signal } : {})).toString("utf8"));
    const combined = signal ? AbortSignal.any([this.shutdown.signal, signal]) : this.shutdown.signal;
    const started = await this.server.ensureRunning(this.executable(), adbEnvironment(this.env), version.serverVersion, combined);
    try {
      return {
        status: "ready", serverAddress: localAdbAddress, startupAttempted: started.startupAttempted,
        devices: parseDeviceList(started.inventory.toString("utf8"), false),
      };
    } catch (error) {
      throw serverStartupError(error, started.startupAttempted);
    }
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
    if (this.shutdown.signal.aborted) {
      throw new MobileUseError("SERVER_STOPPED", "The mobile-use server is stopped.", "Start a new plugin session.");
    }
    const socket = this.env.ADB_SERVER_SOCKET;
    const address = this.env.ANDROID_ADB_SERVER_ADDRESS;
    const port = this.env.ANDROID_ADB_SERVER_PORT;
    if (
      (socket && socket !== "tcp:127.0.0.1:5037" && socket !== "tcp:localhost:5037") ||
      (address && address !== "127.0.0.1" && address !== "localhost") ||
      (port && port !== "5037")
    ) {
      throw new MobileUseError(
        "ADB_CONFIG_UNSUPPORTED",
        "The POC requires the local ADB server on port 5037.",
        "Use the default local server. Remote or non-default server overrides are not supported.",
      );
    }
    const signal = options.signal
      ? AbortSignal.any([this.shutdown.signal, options.signal])
      : this.shutdown.signal;
    checkCancelled(signal);
    const executable = this.executable();
    // Native client discovery can start or replace a daemon; inventory must remain read-only.
    if (args.length === 2 && args[0] === "devices" && args[1] === "-l") {
      return Buffer.concat([Buffer.from("List of devices attached\n"), await this.server.inventory(signal)]);
    }
    return this.runner(executable, ["-H", "127.0.0.1", "-P", "5037", ...args], {
      ...options,
      signal,
      env: adbEnvironment(this.env),
    });
  }

  stop(): void {
    this.shutdown.abort();
  }
}

function transportKind(serial: string, fields: readonly string[]): TransportKind {
  if (serial.startsWith("emulator-")) return "emulator";
  if (serial.endsWith("._adb-tls-connect._tcp")) return "paired-wireless";
  if (/:\d+$/.test(serial)) return "network";
  if (fields.some((field) => field.startsWith("usb:"))) return "usb";
  if (/^[A-Za-z0-9_-]+$/.test(serial)) return "usb";
  return "unknown";
}

export function parseDeviceList(output: string, requireHeader = true): DeviceEndpoint[] {
  if (Buffer.byteLength(output) > 512 * 1024) {
    throw new MobileUseError("INVALID_DEVICE_LIST", "The ADB inventory exceeds the POC's size limit.", "Use a bounded local device inventory.");
  }
  const lines = output.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (requireHeader && lines.shift() !== "List of devices attached") {
    throw new MobileUseError("INVALID_DEVICE_LIST", "ADB did not return a device inventory.", "Check local Platform-Tools.");
  }
  const devices: DeviceEndpoint[] = [];
  const seen = new Set<string>();
  const transports = new Set<string>();
  for (const line of lines) {
    const columns = line.split(/\s+/);
    const endpointId = columns[0] === "(no" && columns[1] === "serial" && columns[2] === "number)"
      ? columns.splice(0, 3).join(" ") : columns.shift();
    const state = columns[0] === "no" && columns[1] === "permissions"
      ? columns.splice(0, 2).join(" ") : columns.shift();
    if (!endpointId || !state || seen.has(endpointId)) {
      throw new MobileUseError("INVALID_DEVICE_LIST", "The ADB inventory is malformed or ambiguous.", "Refresh the device inventory.");
    }
    if (endpointId.length > 512 || state.length > 32 || devices.length >= 256) {
      throw new MobileUseError("INVALID_DEVICE_LIST", "The ADB inventory exceeds the POC's endpoint limits.", "Use a bounded local device inventory.");
    }
    // ADB appends the authoritative ID last; product/device values can contain the same text.
    const finalField = columns.at(-1);
    const transportId = finalField?.startsWith("transport_id:") ? finalField.slice("transport_id:".length) : null;
    if (transportId !== null &&
      (!/^[1-9]\d{0,19}$/.test(transportId) || BigInt(transportId) > 0xffff_ffff_ffff_ffffn)) {
      throw new MobileUseError("INVALID_DEVICE_LIST", "ADB reported an invalid transport ID.", "Refresh the inventory; zero and non-canonical IDs cannot be routed safely.");
    }
    if (transportId && transports.has(transportId)) {
      throw new MobileUseError("INVALID_DEVICE_LIST", "ADB reported duplicate transport IDs.", "Refresh the device inventory.");
    }
    seen.add(endpointId);
    if (transportId) transports.add(transportId);
    const kind = transportKind(endpointId, columns);
    const selectable = state === "device" && transportId !== null && kind !== "emulator" && kind !== "unknown";
    let reason: string | null = null;
    if (state !== "device") reason = `ADB state: ${state}. User setup or recovery is required.`;
    else if (!transportId) reason = "No exact transport ID; update Platform-Tools before selection.";
    else if (kind === "emulator") reason = "Emulators are outside this physical-device POC.";
    else if (kind === "unknown") reason = "Transport kind is unknown and cannot be selected safely.";
    else if (kind === "network" || kind === "paired-wireless") reason = "Modern Wireless debugging will be verified on selection.";
    devices.push({
      endpointId, transportId, kind, state,
      model: columns.find((field) => field.startsWith("model:"))?.slice("model:".length).replaceAll("_", " ") || null,
      selectable, reason,
    });
  }
  return devices;
}

export interface TransportMonitor {
  initial: DeviceEndpoint[];
  close(): void;
}

export type MonitorFactory = (
  onInventory: (inventory: DeviceEndpoint[]) => void,
  onLost: () => void,
  signal: AbortSignal,
) => Promise<TransportMonitor>;

export class AdbTrackParser {
  private pending: Buffer = Buffer.alloc(0);
  private accepted = false;

  push(chunk: Buffer): DeviceEndpoint[][] {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > 1024 * 1024) {
      throw new MobileUseError("INVALID_DEVICE_LIST", "ADB tracking exceeded its buffer limit.", "Rediscover and reselect.");
    }
    if (!this.accepted) {
      if (this.pending.length < 4) return [];
      if (this.pending.subarray(0, 4).toString("ascii") !== "OKAY") {
        throw new MobileUseError("ADB_SERVER_UNAVAILABLE", "The local ADB server rejected transport monitoring.", "Use compatible Platform-Tools.");
      }
      this.accepted = true;
      this.pending = this.pending.subarray(4);
    }
    const frames: DeviceEndpoint[][] = [];
    while (this.pending.length >= 4) {
      const prefix = this.pending.subarray(0, 4).toString("ascii");
      if (!/^[0-9a-f]{4}$/i.test(prefix)) {
        throw new MobileUseError("INVALID_DEVICE_LIST", "ADB tracking returned an invalid frame.", "Rediscover and reselect.");
      }
      const size = Number.parseInt(prefix, 16);
      if (this.pending.length < size + 4) break;
      frames.push(parseDeviceList(this.pending.subarray(4, size + 4).toString("utf8"), false));
      this.pending = this.pending.subarray(size + 4);
    }
    return frames;
  }
}

export function createTransportMonitor(connect: () => Socket): MonitorFactory {
  return (onInventory, onLost, signal) => new Promise((resolve, reject) => {
    checkCancelled(signal);
    const socket = connect();
    const parser = new AdbTrackParser();
    let intentional = false;
    let ready = false;
    let failed = false;
    const close = (): void => {
      intentional = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancelled);
      socket.destroy();
    };
    const fail = (error: MobileUseError): void => {
      if (failed || intentional) return;
      failed = true;
      close();
      if (!ready) reject(error);
      else onLost();
    };
    const cancelled = (): void => fail(new MobileUseError("CANCELLED", "Transport monitoring was cancelled.", "Select a new target."));
    const deadline = setTimeout(() => fail(new MobileUseError(
      "ADB_SERVER_UNAVAILABLE", "Local ADB transport monitoring did not become ready.", "Check Platform-Tools and reselect.",
    )), 5000);
    signal.addEventListener("abort", cancelled, { once: true });
    socket.on("connect", () => {
      socket.setKeepAlive(true);
      const request = "host:track-devices-l";
      socket.write(`${Buffer.byteLength(request).toString(16).padStart(4, "0")}${request}`);
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const inventory of parser.push(chunk)) {
          if (!ready) {
            ready = true;
            clearTimeout(deadline);
            resolve({ initial: inventory, close });
          }
          onInventory(inventory);
        }
      } catch (error) {
        fail(error instanceof MobileUseError ? error : new MobileUseError(
          "INVALID_DEVICE_LIST", "ADB tracking could not be parsed.", "Rediscover and reselect.",
        ));
      }
    });
    socket.on("error", () => fail(new MobileUseError(
      "ADB_SERVER_UNAVAILABLE", "The local ADB monitoring connection failed.", "Check local ADB setup and reselect.",
    )));
    socket.on("close", () => fail(new MobileUseError(
      "TRANSPORT_LOST", "The ADB server connection closed.", "Rediscover and explicitly reselect.",
    )));
  });
}

export const startTransportMonitor = createTransportMonitor(() =>
  createConnection({ host: "127.0.0.1", port: 5037 }),
);
