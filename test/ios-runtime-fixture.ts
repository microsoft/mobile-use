import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MobileUseError } from "../src/errors.js";
import type { IosRuntime, IosRuntimeStatus } from "../src/ios/runtime.js";
import { IosMobileUseService } from "../src/ios/device-session.js";
import { ManagedIosRuntime } from "../src/ios/runtime.js";
import { runtimeFailure, type OwnedProcess, type RuntimeCommands } from "../src/ios/runtime-process.js";
import { usbFailure, type UsbBackend } from "../src/ios/usb.js";
import { createIosFixture } from "./ios-fixture.js";

export const IOS_UDID = "00008110-0000000000000001";
export const IOS_OTHER_UDID = "00008110-0000000000000002";
export const IOS_ENDPOINT = `ios:usb:${IOS_UDID}`;

export async function waitRuntimeState(runtime: IosRuntime, state: IosRuntimeStatus["state"]): Promise<IosRuntimeStatus> {
  for (let i = 0; i < 400; i++) {
    const status = runtime.status();
    if (status.state === state) return status;
    if (status.error && ["failed", "cleanup-failed"].includes(status.state)) {
      throw new MobileUseError(status.error.code, status.error.message, status.error.remediation,
        status.error.retryable, status.error.actionMayHaveRun);
    }
    await delay(5);
  }
  throw new Error(`Fixture runtime did not reach ${state}.`);
}

export async function runtimeFixture(t: TestContext, options: { directory?: string; ipa?: boolean; tunnelPort?: number } = {}) {
  const http = await createIosFixture();
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "mobile-use-runtime-"));
  const ipaPath = join(directory, "signed.ipa");
  if (options.ipa) await writeFile(ipaPath, "fixture-user-validated-signed-package");
  const calls: Array<{ kind: "run" | "start"; args: string[]; signal: AbortSignal | undefined }> = [];
  const events: string[] = [];
  const state = {
    connected: true, running: false, leaveRunnerRunning: false, closeRunnerWithTunnel: false, failImage: false, failInstall: false,
    failTunnelStop: false, badInfo: false, productVersion: "18.5",
    installHook: undefined as (() => Promise<void>) | undefined,
    imageHook: undefined as (() => Promise<void>) | undefined,
    listHook: undefined as (() => Promise<void>) | undefined,
  };
  const exits = new Map<string, () => void>();
  const usb: UsbBackend = {
    async list() {
      await state.listHook?.();
      return [
        ...(state.connected ? [{ udid: IOS_UDID, deviceId: 1 }] : []),
        { udid: IOS_OTHER_UDID, deviceId: 2 },
      ];
    },
    async connect(udid, _port, signal) {
      assert.equal(udid, IOS_UDID);
      if (!state.connected) throw usbFailure("DEVICE_NOT_FOUND");
      if (!state.running) throw usbFailure("WDA_UNAVAILABLE");
      return new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(http.url).port), ...(signal ? { signal } : {}) });
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    },
  };
  const commands: RuntimeCommands = {
    async run(_file, args, _timeout, signal) {
      calls.push({ kind: "run", args, signal });
      if (args[0] === "version") return JSON.stringify({ version: "v1.3.2" });
      assert.deepEqual(args.slice(0, 2), ["--udid", IOS_UDID]);
      if (args.includes("info")) return state.badInfo ? "broken JSON" :
        JSON.stringify({ UniqueDeviceID: IOS_UDID, ProductVersion: state.productVersion });
      if (args.includes("image")) {
        events.push("image");
        await state.imageHook?.();
        if (state.failImage) throw runtimeFailure("IOS_RUNTIME_FAILED", true);
      }
      if (args.includes("install")) {
        events.push("install");
        await state.installHook?.();
        if (state.failInstall) throw runtimeFailure("IOS_RUNTIME_FAILED", true);
      }
      assert.equal(args.includes("uninstall"), false, "retention policy never uninstalls");
      return "";
    },
    async start(_file, args) {
      calls.push({ kind: "start", args, signal: undefined });
      assert.deepEqual(args.slice(0, 2), ["--udid", IOS_UDID]);
      const name = args.includes("runwda") ? "wda" : "tunnel";
      events.push(`start-${name}`);
      if (name === "wda") state.running = true;
      let stopped = false;
      const exited = new Promise<void>((resolve) => exits.set(name, resolve));
      const owned: OwnedProcess = {
        exited,
        assertRunning() { if (stopped) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
        async stop() {
          stopped = true;
          events.push(`stop-${name}`);
          if (name === "wda" && !state.leaveRunnerRunning && !state.closeRunnerWithTunnel) state.running = false;
          if (name === "tunnel" && state.closeRunnerWithTunnel) state.running = false;
          exits.get(name)?.();
          if (name === "tunnel" && state.failTunnelStop) throw runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED");
        },
      };
      return owned;
    },
  };
  const runtime = new ManagedIosRuntime({
    executable: "fixture-go-ios", bundleId: "example.runner.xctrunner", stateDirectory: directory,
    ...(options.ipa ? { ipaPath } : {}), devicePort: 8100, tunnelPort: options.tunnelPort ?? 0,
  }, usb, commands, { platform: "win32", tunnelCheck: async () => {}, readinessTimeoutMs: 1000, pollMs: 5, stopTimeoutMs: 25 });
  const service = new IosMobileUseService(undefined, Date.now, runtime);
  let expectedCleanupFailure = false;
  t.after(async () => {
    try { await service.stop(); }
    catch (error) { if (!expectedCleanupFailure) throw error; }
    finally {
      await http.close();
      if (!options.directory) await rm(directory, { recursive: true, force: true });
    }
  });
  const start = async () => {
    await runtime.control({ kind: "start", endpointId: IOS_ENDPOINT, installRunner: options.ipa ?? false });
    return waitRuntimeState(runtime, "awaiting-developer-trust");
  };
  const ready = async () => {
    const started = await start();
    assert.ok(started.runtimeToken);
    await runtime.control({ kind: "confirm_trust", runtimeToken: started.runtimeToken });
    return waitRuntimeState(runtime, "ready");
  };
  return {
    runtime, service, http, calls, events, state, directory, start, ready,
    crash(name: string) { exits.get(name)?.(); },
    allowCleanupFailure() { expectedCleanupFailure = true; },
  };
}
