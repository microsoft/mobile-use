import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer, type Server } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { checkCancelled, MobileUseError, publicError, type ErrorInfo } from "../errors.js";
import type { DeviceEndpoint } from "../types.js";
import { iosBundleIdSchema, WdaClient, wdaFailure } from "./wda.js";
import { AppleUsbBackend, udidSchema, UsbProxy, usbMuxEndpoint, type UsbBackend } from "./usb.js";
import { NativeUsbBridge } from "./usbmux-bridge.js";
import { runtimeCommands, runtimeFailure, type OwnedProcess, type RuntimeCommands } from "./runtime-process.js";

export const iosRuntimeActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("status"),
    endpointId: z.string().min(1).max(512).optional(),
    runtimeToken: z.string().uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal("start"),
    endpointId: z.string().min(1).max(512),
    installRunner: z.boolean().default(false),
  }),
  z.strictObject({ kind: z.literal("confirm_trust"), runtimeToken: z.string().uuid() }),
  z.strictObject({ kind: z.literal("stop"), runtimeToken: z.string().uuid() }),
]);
export type IosRuntimeAction = z.infer<typeof iosRuntimeActionSchema>;
export interface IosRuntimeStatus {
  mode: "managed";
  state: "idle" | "preparing" | "awaiting-developer-trust" | "starting" | "ready" | "failed" | "stopping" | "stopped" | "cleanup-failed";
  runtimeToken: string | null;
  udid: string | null;
  wdaUrl: string | null;
  runnerBundleId: string;
  installedThisRun: boolean;
  runnerRetained: true;
  wdaPortClosed: boolean | null;
  error: ErrorInfo | null;
  runtimes?: IosRuntimeStatus[];
}
export interface IosRuntimeLostEvent {
  udid?: string;
  runtimeToken?: string;
}
export interface IosRuntimeStatusFilter {
  endpointId?: string;
  runtimeToken?: string;
}
export interface RuntimeBinding { udid: string; url: string; token: string }
export interface IosRuntime {
  onLost: (event?: IosRuntimeLostEvent) => void;
  status(filter?: IosRuntimeStatusFilter): IosRuntimeStatus;
  prerequisites(signal?: AbortSignal): Promise<string>;
  devices(signal?: AbortSignal): Promise<DeviceEndpoint[]>;
  binding(endpointId?: string): RuntimeBinding;
  bindings?(): RuntimeBinding[];
  verify(token: string, signal?: AbortSignal): Promise<void>;
  control(action: IosRuntimeAction, signal?: AbortSignal, priorCleanupFailed?: boolean): Promise<IosRuntimeStatus>;
  cancelPending(token?: string): void;
  close(priorCleanupFailed?: boolean | ReadonlySet<string>): Promise<void>;
}
export interface ManagedIosRuntimeOptions {
  platform?: NodeJS.Platform;
  tunnelCheck?: (port: number, udid: string, signal: AbortSignal) => Promise<void>;
  readinessTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  occupiedTunnelPorts?: () => ReadonlySet<number>;
  allocateTunnelPort?: (requestedPort: number, signal?: AbortSignal) => Promise<number>;
  releaseTunnelPort?: () => void;
  portProber?: (port: number) => Promise<number>;
}
export interface RuntimeConfig {
  executable: string;
  bundleId: string;
  ipaPath?: string;
  stateDirectory: string;
  devicePort: number;
  tunnelPort: number;
}

const maxTunnelPort = 65534;

export function readRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const config = z.object({
    MOBILE_USE_GO_IOS_PATH: z.string().min(1).max(4096).default("ios"),
    MOBILE_USE_IOS_RUNNER_BUNDLE_ID: iosBundleIdSchema.refine((value) => value.endsWith(".xctrunner")),
    MOBILE_USE_IOS_RUNNER_IPA: z.string().optional(),
    MOBILE_USE_IOS_STATE_DIR: z.string().default(join(homedir(), ".mobile-use", "ios-runtime")),
    MOBILE_USE_IOS_WDA_PORT: z.coerce.number().int().min(1).max(65535).default(8100),
    MOBILE_USE_IOS_TUNNEL_PORT: z.coerce.number().int().min(0).max(maxTunnelPort).default(0),
  }).safeParse(environment);
  if (!config.success || !isAbsolute(config.data.MOBILE_USE_IOS_STATE_DIR) ||
    (config.data.MOBILE_USE_IOS_RUNNER_IPA !== undefined &&
      (!isAbsolute(config.data.MOBILE_USE_IOS_RUNNER_IPA) || !/\.ipa$/i.test(config.data.MOBILE_USE_IOS_RUNNER_IPA)))) {
    throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
  }
  return {
    executable: config.data.MOBILE_USE_GO_IOS_PATH, bundleId: config.data.MOBILE_USE_IOS_RUNNER_BUNDLE_ID,
    ...(config.data.MOBILE_USE_IOS_RUNNER_IPA ? { ipaPath: config.data.MOBILE_USE_IOS_RUNNER_IPA } : {}),
    stateDirectory: config.data.MOBILE_USE_IOS_STATE_DIR,
    devicePort: config.data.MOBILE_USE_IOS_WDA_PORT, tunnelPort: config.data.MOBILE_USE_IOS_TUNNEL_PORT,
  };
}

async function listenPort(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(runtimeFailure("IOS_RUNTIME_CONFLICT")));
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw runtimeFailure("IOS_RUNTIME_FAILED");
  return address.port;
}

async function reservePortPair(port: number): Promise<number> {
  const primary = createServer((socket) => socket.destroy());
  const adjacent = createServer((socket) => socket.destroy());
  try {
    const candidate = await listenPort(primary, port);
    if (candidate <= maxTunnelPort) await listenPort(adjacent, candidate + 1);
    return candidate;
  } finally {
    await Promise.all([primary, adjacent].filter((server) => server.listening).map((server) =>
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(runtimeFailure("IOS_RUNTIME_FAILED")) : resolve()))));
  }
}

export async function availableTunnelPort(
  port: number,
  reserve: (port: number) => Promise<number> = reservePortPair,
  occupied?: ReadonlySet<number>,
): Promise<number> {
  if (!Number.isInteger(port) || port < 0 || port > maxTunnelPort) throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
  // go-ios derives its first userspace listener as tunnel-info port + 1.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const candidate = await reserve(port);
      if (occupied && (occupied.has(candidate) || occupied.has(candidate + 1))) {
        if (port !== 0) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
        continue;
      }
      if (candidate > 0 && candidate <= maxTunnelPort) return candidate;
    } catch (error) {
      if (port !== 0 || !(error instanceof MobileUseError) || error.code !== "IOS_RUNTIME_CONFLICT") throw error;
    }
  }
  throw runtimeFailure("IOS_RUNTIME_CONFLICT");
}

function assertMountedImage(output: string): void {
  let mounted = false;
  for (const line of output.split(/\r?\n/).filter((entry) => entry.trim())) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw runtimeFailure("IOS_RUNTIME_FAILED", true); }
    const entry = z.object({ level: z.string(), msg: z.string(), signature: z.string().optional() }).safeParse(value);
    if (!entry.success || entry.data.level === "ERROR") throw runtimeFailure("IOS_RUNTIME_FAILED", true);
    if (entry.data.level === "INFO" && entry.data.msg === "image signature" &&
      /^(?:[a-fA-F0-9]{2})+$/.test(entry.data.signature ?? "")) mounted = true;
  }
  if (!mounted) throw runtimeFailure("IOS_RUNTIME_FAILED", true);
}

async function checkTunnel(port: number, udid: string, signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/tunnels`, {
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    if (!response.ok || !response.body) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if ((size += chunk.value.length) > 1024 * 1024) throw runtimeFailure("IOS_RUNTIME_FAILED");
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel(); }
    const parsed = z.array(z.object({ udid: udidSchema })).nullable().safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success || parsed.data?.filter((entry) => entry.udid === udid).length !== 1) {
      throw runtimeFailure("IOS_RUNTIME_NOT_READY");
    }
  } catch (error) {
    checkCancelled(signal);
    if (error instanceof MobileUseError) throw error;
    throw runtimeFailure("IOS_RUNTIME_NOT_READY");
  }
}

function parseUsbEndpointUdid(endpointId: string): string | undefined {
  if (!endpointId.startsWith("ios:usb:")) return undefined;
  const parsed = udidSchema.safeParse(endpointId.slice("ios:usb:".length));
  return parsed.success ? parsed.data : undefined;
}

function idleRuntimeStatus(bundleId: string, udid: string | null = null): IosRuntimeStatus {
  return {
    mode: "managed",
    state: "idle",
    runtimeToken: null,
    udid,
    wdaUrl: null,
    runnerBundleId: bundleId,
    installedThisRun: false,
    runnerRetained: true,
    wdaPortClosed: null,
    error: null,
  };
}

async function checkGoIosPrerequisites(
  executable: string,
  commands: RuntimeCommands,
  platform: NodeJS.Platform | undefined,
  signal?: AbortSignal,
): Promise<string> {
  usbMuxEndpoint(platform);
  let output: string;
  try {
    output = await commands.run(executable, ["version"], 30000, signal);
  } catch (error) {
    checkCancelled(signal);
    if (error instanceof MobileUseError && error.code === "CANCELLED") throw error;
    throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
  }
  let version: unknown;
  try { version = JSON.parse(output); } catch { throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID"); }
  const parsed = z.object({ version: z.enum(["v1.3.2", "1.3.2"]) }).safeParse(version);
  if (!parsed.success) throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
  return parsed.data.version;
}

export class ManagedIosRuntime implements IosRuntime {
  onLost: (event?: IosRuntimeLostEvent) => void = () => {};
  private state: IosRuntimeStatus["state"] = "idle";
  private token: string | undefined;
  private udid: string | undefined;
  private proxy: UsbProxy | undefined;
  private nativeUsb: NativeUsbBridge | undefined;
  private tunnel: OwnedProcess | undefined;
  private tunnelPort = 0;
  private wda: OwnedProcess | undefined;
  private lockPath: string | undefined;
  private installed = false;
  private mutated = false;
  private wdaPortClosed: boolean | null = null;
  private failure: ErrorInfo | null = null;
  private controller = new AbortController();
  private pending: Promise<unknown> = Promise.resolve();
  private cleaning: Promise<void> | undefined;
  private retiring = false;
  private priorCleanupFailed = false;

  constructor(private readonly config: RuntimeConfig, private readonly usb: UsbBackend = new AppleUsbBackend(),
    private readonly commands: RuntimeCommands = runtimeCommands,
    private readonly options: ManagedIosRuntimeOptions = {}) {}

  get activeTunnelPorts(): readonly number[] {
    if (!this.tunnelPort) return [];
    return [this.tunnelPort, this.tunnelPort + 1];
  }

  status(filter?: IosRuntimeStatusFilter): IosRuntimeStatus {
    if (filter?.endpointId !== undefined) {
      const udid = parseUsbEndpointUdid(filter.endpointId);
      if (!udid) throw wdaFailure("INVALID_INPUT");
      if (filter.runtimeToken !== undefined && (this.udid !== udid || this.token !== filter.runtimeToken)) {
        throw runtimeFailure("IOS_RUNTIME_CONFLICT");
      }
      if (this.udid && this.udid !== udid) return idleRuntimeStatus(this.config.bundleId, udid);
      return {
        mode: "managed", state: this.state, runtimeToken: this.token ?? null, udid: this.udid ?? udid,
        wdaUrl: this.state === "ready" ? this.proxy?.url ?? null : null,
        runnerBundleId: this.config.bundleId, installedThisRun: this.installed, runnerRetained: true,
        wdaPortClosed: this.wdaPortClosed, error: this.failure,
      };
    }
    if (filter?.runtimeToken !== undefined && filter.runtimeToken !== this.token) {
      throw runtimeFailure("IOS_RUNTIME_CONFLICT");
    }
    return {
      mode: "managed", state: this.state, runtimeToken: this.token ?? null, udid: this.udid ?? null,
      wdaUrl: this.state === "ready" ? this.proxy?.url ?? null : null,
      runnerBundleId: this.config.bundleId, installedThisRun: this.installed, runnerRetained: true,
      wdaPortClosed: this.wdaPortClosed, error: this.failure,
    };
  }

  async prerequisites(signal?: AbortSignal): Promise<string> {
    return checkGoIosPrerequisites(this.config.executable, this.commands, this.options.platform, signal);
  }

  async devices(signal?: AbortSignal): Promise<DeviceEndpoint[]> {
    const devices = await this.usb.list(signal);
    if (this.state === "ready" && !devices.some((entry) => entry.udid === this.udid)) {
      this.fail(usbFailureForLoss());
      throw usbFailureForLoss();
    }
    return devices.map((entry) => ({
      platform: "ios", endpointId: `ios:usb:${entry.udid}`, transportId: entry.udid, kind: "usb", state: "device",
      model: null, selectable: this.state === "ready" && entry.udid === this.udid,
      reason: this.state === "ready" && entry.udid === this.udid ? "Managed WDA bound to this USB UDID."
        : "Explicitly start mobile_ios_runtime for this endpoint, confirm developer trust, then select it when ready.",
    }));
  }

  handleUsbDisconnected(): void {
    this.fail(usbFailureForLoss());
  }

  binding(endpointId?: string): RuntimeBinding {
    if (this.retiring || this.state !== "ready" || !this.proxy || !this.udid || !this.token) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
    if (endpointId !== undefined && endpointId !== `ios:usb:${this.udid}`) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
    this.assertRunning();
    return { udid: this.udid, url: this.proxy.url, token: this.token };
  }

  bindings(): RuntimeBinding[] {
    if (this.retiring || this.state !== "ready" || !this.proxy || !this.udid || !this.token) return [];
    return [this.binding()];
  }

  async verify(token: string, signal?: AbortSignal): Promise<void> {
    const binding = this.binding();
    if (token !== binding.token) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
    if (!(await this.usb.list(signal)).some((entry) => entry.udid === binding.udid)) {
      this.fail(usbFailureForLoss());
      throw usbFailureForLoss();
    }
    if (this.binding().token !== token) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
    checkCancelled(signal);
  }

  private assertRunning() {
    this.tunnel?.assertRunning();
    this.wda?.assertRunning();
  }

  private lostEvent(): IosRuntimeLostEvent {
    return {
      ...(this.udid ? { udid: this.udid } : {}),
      ...(this.token ? { runtimeToken: this.token } : {}),
    };
  }

  private fail(error: unknown) {
    if (this.retiring || this.state === "failed") return;
    const failure = publicError(error);
    this.failure = new MobileUseError(failure.code, failure.message, failure.remediation, failure.retryable,
      failure.actionMayHaveRun || this.mutated || this.installed || this.wda !== undefined).toJSON();
    this.state = "failed";
    this.controller.abort();
    this.onLost(this.lostEvent());
  }

  private watch(process: OwnedProcess) {
    const token = this.token;
    void process.exited.then(async () => {
      if (this.retiring || token !== this.token) return;
      this.fail(runtimeFailure("IOS_RUNTIME_FAILED"));
      // Background failures are recorded/logged; cleanup must wait for installation to settle.
      try { await this.pending; } catch { /* Recorded in runtime status. */ }
      try { await this.cleanup(); }
      catch { processStderr("IOS_RUNTIME_CLEANUP_FAILED"); }
    });
  }

  private async wait(check: () => Promise<void>, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 120000);
    while (Date.now() < deadline) {
      checkCancelled(signal);
      this.assertRunning();
      try { await check(); this.assertRunning(); checkCancelled(signal); return; }
      catch (error) {
        checkCancelled(signal);
        if (!(error instanceof MobileUseError) ||
          !["IOS_RUNTIME_NOT_READY", "WDA_UNAVAILABLE", "WDA_RESPONSE_INVALID"].includes(error.code)) throw error;
      }
      await delay(this.options.pollMs ?? 500, undefined, { signal }).catch(() => checkCancelled(signal));
    }
    throw runtimeFailure("IOS_RUNTIME_FAILED");
  }

  async control(action: IosRuntimeAction, signal?: AbortSignal, priorCleanupFailed = false): Promise<IosRuntimeStatus> {
    checkCancelled(signal);
    if (action.kind === "status") {
      return Promise.resolve(this.status({
        ...(action.endpointId ? { endpointId: action.endpointId } : {}),
        ...(action.runtimeToken ? { runtimeToken: action.runtimeToken } : {}),
      }));
    }
    if (action.kind === "stop") {
      if (!this.token || action.runtimeToken !== this.token) return Promise.reject(runtimeFailure("IOS_RUNTIME_CONFLICT"));
      return this.close(priorCleanupFailed).then(() => this.status());
    }
    if (action.kind === "start") {
      if (!["idle", "stopped"].includes(this.state)) return Promise.reject(runtimeFailure("IOS_RUNTIME_CONFLICT"));
      this.pending = this.prepare(action.endpointId, action.installRunner);
    } else {
      if (this.state !== "awaiting-developer-trust" || action.runtimeToken !== this.token) {
        return Promise.reject(runtimeFailure("IOS_RUNTIME_CONFLICT"));
      }
      this.pending = this.launch();
    }
    void this.pending.catch((error: unknown) => processStderr(publicError(error).code));
    return this.status();
  }

  private async assertNoWda(signal: AbortSignal): Promise<void> {
    if (!await this.portClosed(signal)) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
  }

  private nativeEnvironment(): NodeJS.ProcessEnv {
    if (!this.nativeUsb) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
    return { USBMUXD_SOCKET_ADDRESS: this.nativeUsb.address };
  }

  private async portClosed(signal?: AbortSignal): Promise<boolean> {
    if (!this.udid) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
    try {
      (await this.usb.connect(this.udid, this.config.devicePort, signal)).destroy();
      return false;
    } catch (error) {
      if (error instanceof MobileUseError && error.code === "WDA_UNAVAILABLE") return true;
      throw error;
    }
  }

  private async prepare(endpointId: string, install: boolean) {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state = "preparing";
    this.retiring = false;
    this.priorCleanupFailed = false;
    this.cleaning = undefined;
    this.failure = null;
    this.installed = false;
    this.mutated = false;
    this.wdaPortClosed = null;
    this.token = randomUUID();
    this.udid = undefined;
    try {
      await this.prerequisites(signal);
      const selected = (await this.usb.list(signal)).find((entry) => `ios:usb:${entry.udid}` === endpointId);
      if (!selected) throw usbFailureForLoss();
      this.udid = selected.udid;
      if (install) {
        if (!this.config.ipaPath) throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
        const packageFile = await stat(this.config.ipaPath).catch(() => { throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID"); });
        if (!packageFile.isFile() || packageFile.size === 0) throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
      }
      this.nativeUsb = await NativeUsbBridge.start(this.usb, this.udid, (error) => this.fail(error));
      const info = await this.commands.run(this.config.executable, ["--udid", this.udid, "info"], 30000, signal,
        false, undefined, this.nativeEnvironment());
      let infoValue: unknown;
      try { infoValue = JSON.parse(info); } catch { throw runtimeFailure("IOS_RUNTIME_FAILED"); }
      const device = z.object({ UniqueDeviceID: z.literal(this.udid),
        ProductVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/) }).safeParse(infoValue);
      const [major = 0, minor = 0, patch = 0] = device.success ? device.data.ProductVersion.split(".").map(Number) : [];
      if (!device.success || !(major > 17 || (major === 17 && (minor > 4 || (minor === 4 && patch > 0))))) {
        throw new MobileUseError("DEVICE_UNSUPPORTED", "Managed WDA requires a physical iOS 17.4.1+ device for go-ios userspace tunnels.",
          "Verify the device UDID and use iOS 17.4.1+ or an externally managed WDA endpoint.");
      }
      await mkdir(join(this.config.stateDirectory, "locks"), { recursive: true, mode: 0o700 });
      const lockPath = join(this.config.stateDirectory, "locks", `${this.udid}.lock`);
      const lock = await open(lockPath, "wx", 0o600).catch(() => { throw runtimeFailure("IOS_RUNTIME_CONFLICT"); });
      this.lockPath = lockPath;
      try { await lock.writeFile(JSON.stringify({ pid: process.pid, token: this.token })); }
      finally { await lock.close(); }
      this.proxy = await UsbProxy.start(this.usb, this.udid, this.config.devicePort, (error) => {
        const failure = publicError(error);
        if (this.state === "ready" || failure.code === "DEVICE_NOT_FOUND") this.fail(failure);
        else if (failure.code !== "WDA_UNAVAILABLE") processStderr(failure.code);
      });
      await this.assertNoWda(signal);
      checkCancelled(signal);
      const port = this.options.allocateTunnelPort
        ? await this.options.allocateTunnelPort(this.config.tunnelPort, signal)
        : await availableTunnelPort(
            this.config.tunnelPort,
            this.options.portProber ?? reservePortPair,
            this.options.occupiedTunnelPorts?.(),
          );
      this.tunnelPort = port;
      const pairs = join(this.config.stateDirectory, "pairing", this.udid);
      const images = join(this.config.stateDirectory, "devimages");
      const logs = join(this.config.stateDirectory, "logs");
      for (const directory of [pairs, images, logs]) await mkdir(directory, { recursive: true, mode: 0o700 });
      const global = ["--udid", this.udid, "--tunnel-info-host", "127.0.0.1", "--tunnel-info-port", String(port)];
      this.tunnel = await this.commands.start(this.config.executable,
        [...global, "tunnel", "start", "--userspace", "--pair-record-path", pairs], join(logs, `tunnel-${this.token}.log`),
        this.nativeEnvironment());
      this.watch(this.tunnel);
      await this.wait(() => (this.options.tunnelCheck ?? checkTunnel)(port, selected.udid, signal), signal);
      await this.commands.run(this.config.executable, [...global, "image", "auto", "--basedir", images], 600000, signal, true,
        join(logs, `image-${this.token}.log`), this.nativeEnvironment());
      this.mutated = true;
      checkCancelled(signal);
      this.assertRunning();
      // go-ios image auto can exit zero after a download failure; verify the mounted-image postcondition.
      const mounted = await this.commands.run(this.config.executable, [...global, "image", "list"], 30000, signal, false,
        join(logs, `image-check-${this.token}.log`), this.nativeEnvironment(), "stderr");
      assertMountedImage(mounted);
      if (install) {
        await this.assertNoWda(signal);
        const ipaPath = this.config.ipaPath;
        if (!ipaPath) throw runtimeFailure("IOS_RUNTIME_CONFIG_INVALID");
        // Do not abort an in-flight install: its acknowledgement is needed for an honest outcome.
        await this.commands.run(this.config.executable, [...global, "install", "--path", ipaPath], 300000, undefined, true,
          join(logs, `install-${this.token}.log`), this.nativeEnvironment());
        this.installed = true;
      }
      checkCancelled(signal);
      this.assertRunning();
      this.state = "awaiting-developer-trust";
    } catch (error) { await this.failedOperation(error); }
  }

  private async launch() {
    const signal = this.controller.signal;
    this.state = "starting";
    try {
      checkCancelled(signal);
      this.assertRunning();
      if (!this.udid || !this.proxy) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
      if (!(await this.usb.list(signal)).some((entry) => entry.udid === this.udid)) throw usbFailureForLoss();
      await this.assertNoWda(signal);
      this.wda = await this.commands.start(this.config.executable, [
        "--udid", this.udid, "--tunnel-info-host", "127.0.0.1", "--tunnel-info-port", String(this.tunnelPort),
        "runwda", "--bundleid", this.config.bundleId,
        "--testrunnerbundleid", this.config.bundleId, "--xctestconfig", "WebDriverAgentRunner.xctest",
      ], join(this.config.stateDirectory, "logs", `wda-${this.token}.log`), this.nativeEnvironment());
      this.watch(this.wda);
      const client = new WdaClient(this.proxy.url, 2000);
      await this.wait(async () => {
        const probe = await client.probe(signal);
        if (probe.sessionId !== null) throw new MobileUseError("WDA_SESSION_CONFLICT",
          "A foreign WDA session is active.", "Stop this runtime and use a dedicated Runner; never replace the session.");
      }, signal);
      this.state = "ready";
    } catch (error) { await this.failedOperation(error); }
  }

  private async failedOperation(error: unknown): Promise<never> {
    this.fail(error);
    try { await this.cleanup(); }
    catch { throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED", this.mutated || this.installed); }
    const failure = this.failure ?? publicError(error).toJSON();
    throw new MobileUseError(failure.code, failure.message, failure.remediation, failure.retryable,
      failure.actionMayHaveRun || this.mutated || this.installed || this.wda !== undefined);
  }

  cancelPending(token?: string): void {
    if (token !== undefined && token !== this.token) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
    this.controller.abort();
  }

  async close(priorCleanupFailed: boolean | ReadonlySet<string> = false): Promise<void> {
    const failed = typeof priorCleanupFailed === "boolean"
      ? priorCleanupFailed
      : (this.token !== undefined && priorCleanupFailed.has(this.token));
    this.priorCleanupFailed ||= failed;
    this.cancelPending();
    try { await this.pending; } catch { /* Recorded in runtime status. */ }
    if (!this.cleaning) this.state = "stopping";
    await this.cleanup();
    this.state = "stopped";
  }

  private async confirmStopped(): Promise<void> {
    if (!this.udid) throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED");
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 10000);
    while (Date.now() < deadline) {
      try {
        if (await this.portClosed()) {
          this.wdaPortClosed = true;
          return;
        }
      } catch {
        this.wdaPortClosed = null;
        throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED");
      }
      await delay(this.options.pollMs ?? 500);
    }
    this.wdaPortClosed = false;
    throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED");
  }

  private cleanup(): Promise<void> {
    this.cleaning ??= (async () => {
      this.retiring = true;
      this.onLost(this.lostEvent());
      const errors: unknown[] = [];
      if (this.wda) {
        try { await this.wda.stop(); } catch (error) { errors.push(error); }
      }
      try { await this.tunnel?.stop(); } catch (error) { errors.push(error); }
      if (this.wda) {
        try { await this.confirmStopped(); } catch (error) { errors.push(error); }
      }
      try { await this.proxy?.close(); } catch (error) { errors.push(error); }
      try { await this.nativeUsb?.close(); } catch (error) { errors.push(error); }
      if (this.lockPath && errors.length === 0 && !this.priorCleanupFailed) {
        try {
          const record = z.object({ token: z.literal(this.token) }).safeParse(JSON.parse(await readFile(this.lockPath, "utf8")));
          if (!record.success) throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED");
          if (!this.priorCleanupFailed) {
            await unlink(this.lockPath);
            this.lockPath = undefined;
          }
        } catch (error) { errors.push(error); }
      }
      if (errors.length || this.priorCleanupFailed) {
        this.state = "cleanup-failed";
        this.failure = runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED", this.mutated || this.installed).toJSON();
        throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED", this.mutated || this.installed);
      }
      this.tunnelPort = 0;
      this.options.releaseTunnelPort?.();
      this.proxy = undefined;
      this.nativeUsb = undefined;
      this.tunnel = undefined;
      this.wda = undefined;
    })();
    return this.cleaning;
  }
}

export class ManagedIosRuntimePool implements IosRuntime {
  onLost: (event?: IosRuntimeLostEvent) => void = () => {};
  private readonly runtimes = new Map<string, ManagedIosRuntime>();
  private readonly tokenToUdid = new Map<string, string>();
  private readonly reservedTunnelPorts = new Map<string, readonly [number, number]>();
  private portAllocationQueue: Promise<void> = Promise.resolve();
  private readonly resolveConfig: () => RuntimeConfig;

  constructor(
    configOrResolver: RuntimeConfig | (() => RuntimeConfig),
    private readonly usb: UsbBackend = new AppleUsbBackend(),
    private readonly commands: RuntimeCommands = runtimeCommands,
    private readonly options: Omit<ManagedIosRuntimeOptions, "occupiedTunnelPorts" | "allocateTunnelPort" | "releaseTunnelPort"> = {},
  ) {
    this.resolveConfig = typeof configOrResolver === "function" ? configOrResolver : () => configOrResolver;
  }

  private tryConfig(): RuntimeConfig | undefined {
    try { return this.resolveConfig(); } catch { return undefined; }
  }

  private occupiedTunnelPorts(excludingUdid?: string): ReadonlySet<number> {
    const ports = new Set<number>();
    for (const [udid, pair] of this.reservedTunnelPorts) {
      if (udid === excludingUdid) continue;
      ports.add(pair[0]);
      ports.add(pair[1]);
    }
    for (const [udid, runtime] of this.runtimes) {
      if (udid === excludingUdid) continue;
      for (const port of runtime.activeTunnelPorts) ports.add(port);
    }
    return ports;
  }

  private allocateTunnelPort(udid: string, requestedPort: number, signal?: AbortSignal): Promise<number> {
    const run = this.portAllocationQueue.then(async () => {
      checkCancelled(signal);
      const occupied = this.occupiedTunnelPorts(udid);
      const held: Server[] = [];
      const reserveWithHold = async (port: number): Promise<number> => {
        if (this.options.portProber) return this.options.portProber(port);
        if (port !== 0 || occupied.size === 0) return reservePortPair(port);
        const primary = createServer((socket) => socket.destroy());
        const adjacent = createServer((socket) => socket.destroy());
        try {
          const candidate = await listenPort(primary, 0);
          if (occupied.has(candidate) || occupied.has(candidate + 1)) {
            held.push(primary);
            return candidate;
          }
          if (candidate <= maxTunnelPort) await listenPort(adjacent, candidate + 1);
          return candidate;
        } finally {
          const toClose = [primary, adjacent].filter((server) => server.listening && !held.includes(server));
          await Promise.all(toClose.map((server) =>
            new Promise<void>((resolve, reject) => server.close((error) => error ? reject(runtimeFailure("IOS_RUNTIME_FAILED")) : resolve()))));
        }
      };
      let port: number;
      try {
        port = await availableTunnelPort(requestedPort, reserveWithHold, occupied);
      } finally {
        await Promise.all(held.filter((server) => server.listening).map((server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))));
      }
      checkCancelled(signal);
      this.reservedTunnelPorts.set(udid, [port, port + 1]);
      return port;
    });
    this.portAllocationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private getOrCreateRuntime(udid: string, config: RuntimeConfig): ManagedIosRuntime {
    let runtime = this.runtimes.get(udid);
    if (!runtime) {
      runtime = new ManagedIosRuntime(config, this.usb, this.commands, {
        ...this.options,
        occupiedTunnelPorts: () => this.occupiedTunnelPorts(udid),
        allocateTunnelPort: (requestedPort, signal) => this.allocateTunnelPort(udid, requestedPort, signal),
        releaseTunnelPort: () => {
          this.reservedTunnelPorts.delete(udid);
        },
      });
      runtime.onLost = (event) => this.onLost({ udid, ...event });
      this.runtimes.set(udid, runtime);
    }
    return runtime;
  }

  private findByToken(token: string): ManagedIosRuntime | undefined {
    const udid = this.tokenToUdid.get(token);
    if (udid) {
      const runtime = this.runtimes.get(udid);
      if (runtime?.status().runtimeToken === token) return runtime;
    }
    for (const runtime of this.runtimes.values()) {
      if (runtime.status().runtimeToken === token) return runtime;
    }
    return undefined;
  }

  status(filter?: IosRuntimeStatusFilter): IosRuntimeStatus {
    const config = this.resolveConfig();
    if (filter?.endpointId !== undefined) {
      const udid = parseUsbEndpointUdid(filter.endpointId);
      if (!udid) throw wdaFailure("INVALID_INPUT");
      const runtime = this.runtimes.get(udid);
      if (!runtime) {
        if (filter.runtimeToken !== undefined) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
        return idleRuntimeStatus(config.bundleId, udid);
      }
      return runtime.status(filter);
    }
    if (filter?.runtimeToken !== undefined) {
      const runtime = this.findByToken(filter.runtimeToken);
      if (!runtime) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
      return runtime.status(filter);
    }
    if (this.runtimes.size === 0) return idleRuntimeStatus(config.bundleId, null);
    if (this.runtimes.size === 1) {
      const [only] = this.runtimes.values();
      if (!only) return idleRuntimeStatus(config.bundleId, null);
      return only.status();
    }
    const all = [...this.runtimes.entries()].map(([udid, runtime]) => {
      const entry = runtime.status();
      return entry.udid ? entry : { ...entry, udid };
    });
    const primary = all.find((entry) => entry.state === "ready")
      ?? all.find((entry) => ["preparing", "awaiting-developer-trust", "starting"].includes(entry.state))
      ?? all[all.length - 1]
      ?? idleRuntimeStatus(config.bundleId, null);
    return { ...primary, runtimes: all };
  }

  async prerequisites(signal?: AbortSignal): Promise<string> {
    const config = this.resolveConfig();
    return checkGoIosPrerequisites(config.executable, this.commands, this.options.platform, signal);
  }

  async devices(signal?: AbortSignal): Promise<DeviceEndpoint[]> {
    const config = this.tryConfig();
    const devices = await this.usb.list(signal);
    const connected = new Set(devices.map((entry) => entry.udid));
    for (const [udid, runtime] of this.runtimes) {
      if (runtime.status().state === "ready" && !connected.has(udid)) {
        runtime.handleUsbDisconnected();
      }
    }
    return devices.map((entry) => {
      const runtime = this.runtimes.get(entry.udid);
      const ready = runtime?.status().state === "ready";
      return {
        platform: "ios",
        endpointId: `ios:usb:${entry.udid}`,
        transportId: entry.udid,
        kind: "usb",
        state: "device",
        model: null,
        selectable: ready,
        reason: ready
          ? "Managed WDA bound to this USB UDID."
          : config
            ? "Explicitly start mobile_ios_runtime for this endpoint, confirm developer trust, then select it when ready."
            : "Set MOBILE_USE_IOS_RUNNER_BUNDLE_ID (and ensure go-ios v1.3.2 is available) before starting mobile_ios_runtime for this USB device.",
      };
    });
  }

  binding(endpointId?: string): RuntimeBinding {
    if (endpointId !== undefined) {
      const udid = parseUsbEndpointUdid(endpointId);
      if (!udid) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
      const runtime = this.runtimes.get(udid);
      if (!runtime) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
      return runtime.binding(endpointId);
    }
    const ready = this.bindings();
    if (ready.length === 0) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
    return ready[0]!;
  }

  bindings(): RuntimeBinding[] {
    const ready: RuntimeBinding[] = [];
    for (const runtime of this.runtimes.values()) {
      ready.push(...runtime.bindings());
    }
    return ready;
  }

  async verify(token: string, signal?: AbortSignal): Promise<void> {
    const active = this.findByToken(token);
    if (active) return active.verify(token, signal);
    const udid = this.tokenToUdid.get(token);
    const runtime = udid ? this.runtimes.get(udid) : undefined;
    if (runtime) return runtime.verify(token, signal);
    if (this.bindings().length > 0) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
    throw runtimeFailure("IOS_RUNTIME_NOT_READY");
  }

  async control(action: IosRuntimeAction, signal?: AbortSignal, priorCleanupFailed = false): Promise<IosRuntimeStatus> {
    checkCancelled(signal);
    if (action.kind === "status") {
      return this.status({
        ...(action.endpointId ? { endpointId: action.endpointId } : {}),
        ...(action.runtimeToken ? { runtimeToken: action.runtimeToken } : {}),
      });
    }
    const config = this.resolveConfig();
    if (action.kind === "start") {
      const udid = parseUsbEndpointUdid(action.endpointId);
      if (!udid) throw wdaFailure("INVALID_INPUT");
      if (config.tunnelPort !== 0) {
        for (const [otherUdid, other] of this.runtimes) {
          if (otherUdid !== udid && (!["idle", "stopped"].includes(other.status().state) || this.reservedTunnelPorts.has(otherUdid))) {
            throw runtimeFailure("IOS_RUNTIME_CONFLICT");
          }
        }
      }
      const runtime = this.getOrCreateRuntime(udid, config);
      const started = await runtime.control(action, signal, priorCleanupFailed);
      if (started.runtimeToken) this.tokenToUdid.set(started.runtimeToken, udid);
      return started.udid ? started : { ...started, udid };
    }
    const runtime = this.findByToken(action.runtimeToken);
    if (!runtime) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
    return runtime.control(action, signal, priorCleanupFailed);
  }

  cancelPending(token?: string): void {
    if (token !== undefined) {
      const runtime = this.findByToken(token);
      if (!runtime) throw runtimeFailure("IOS_RUNTIME_CONFLICT");
      runtime.cancelPending(token);
      return;
    }
    for (const runtime of this.runtimes.values()) runtime.cancelPending();
  }

  async close(priorCleanupFailed: boolean | ReadonlySet<string> = false): Promise<void> {
    const errors: unknown[] = [];
    await Promise.all([...this.runtimes.values()].map(async (runtime) => {
      try { await runtime.close(priorCleanupFailed); } catch (error) { errors.push(error); }
    }));
    if (errors.length) throw publicError(errors[errors.length - 1]);
  }
}

function usbFailureForLoss() {
  return new MobileUseError("DEVICE_NOT_FOUND", "The selected iOS USB UDID is not connected.",
    "Reconnect that device and explicitly restart/reselect. Never switch to another phone or Wi-Fi automatically.");
}
function processStderr(code: string) { process.stderr.write(`mobile-use: ${code}\n`); }
