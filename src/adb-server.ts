import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { checkCancelled, isRecord, MobileUseError, publicError } from "./errors.js";

export const localAdbAddress = "127.0.0.1:5037";

type ServerSpawner = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;

function conflict(): MobileUseError {
  return new MobileUseError(
    "ADB_SERVER_CONFLICT",
    "The local ADB port is occupied by an incompatible or unverified server.",
    "Leave the existing process running. Resolve the local server/version conflict yourself; mobile-use will not kill, replace, or restart it.",
  );
}

export function serverStartupError(error: unknown, startupAttempted: boolean): MobileUseError {
  const failure = publicError(error);
  if (!startupAttempted) return failure;
  return new MobileUseError(
    failure.code, failure.message,
    `${failure.remediation} Server startup may have completed. Check the local server before retrying; do not automatically replay startup.`,
    false, true,
  );
}

export class LocalAdbServer {
  constructor(
    private readonly connect: () => Socket = () => createConnection({ host: "127.0.0.1", port: 5037 }),
    private readonly spawnProcess: ServerSpawner = spawn,
  ) {}

  private query(request: "host:version" | "host:devices-l", signal?: AbortSignal, timeoutMs = 1000): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      checkCancelled(signal);
      const socket = this.connect();
      let connected = false;
      let settled = false;
      let pending: Buffer = Buffer.alloc(0);
      const maxLength = request === "host:version" ? 4 : 0xffff;
      const finish = (error: MobileUseError | null, value: Buffer | null = null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancelled);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const cancelled = (): void => finish(new MobileUseError(
        "CANCELLED", "The local ADB server check was cancelled.", "Check the local server before continuing.",
      ));
      const deadline = setTimeout(() => finish(conflict()), timeoutMs);
      signal?.addEventListener("abort", cancelled, { once: true });
      socket.once("connect", () => {
        connected = true;
        socket.write(`${request.length.toString(16).padStart(4, "0")}${request}`);
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (pending.length + chunk.length > maxLength + 8) return finish(conflict());
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 4) return;
        if (pending.subarray(0, 4).toString("latin1") !== "OKAY") return finish(conflict());
        if (pending.length < 8) return;
        const prefix = pending.subarray(4, 8).toString("latin1");
        if (!/^[0-9a-f]{4}$/i.test(prefix)) return finish(conflict());
        const size = Number.parseInt(prefix, 16);
        if (size > maxLength || pending.length > size + 8) return finish(conflict());
        if (pending.length === size + 8) finish(null, pending.subarray(8));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        finish(!connected && error.code === "ECONNREFUSED" ? null : conflict());
      });
      socket.once("close", () => finish(conflict()));
      if (signal?.aborted) cancelled();
    });
  }

  private async ready(version: number, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    const reply = await this.query("host:version", signal, timeoutMs);
    if (reply === null) return false;
    const text = reply.toString("latin1");
    if (!/^[0-9a-f]{4}$/i.test(text) || Number.parseInt(text, 16) !== version) throw conflict();
    return true;
  }

  private launch(executable: string, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const failed = (error: unknown): void => reject(new MobileUseError(
        isRecord(error) && error.code === "ENOENT" ? "ADB_NOT_FOUND" : "ADB_SERVER_START_FAILED",
        "The local ADB server process could not be started.",
        "Check the installed Platform-Tools and local execution policy. Do not change firewall settings or automatically retry.",
      ));
      // Unlike start-server, direct server mode cannot kill an incompatible daemon in a startup race.
      let child: ChildProcess;
      try {
        child = this.spawnProcess(executable, ["-L", `tcp:${localAdbAddress}`, "server", "nodaemon"], {
          env, detached: true, windowsHide: true, stdio: "ignore",
        });
      } catch (error) {
        failed(error);
        return;
      }
      child.once("error", failed);
      child.once("spawn", () => {
        child.unref();
        resolve(child);
      });
    });
  }

  async inventory(signal?: AbortSignal): Promise<Buffer> {
    const inventory = await this.query("host:devices-l", signal, 5000);
    if (inventory === null) {
      throw new MobileUseError(
        "ADB_SERVER_UNAVAILABLE", "The local ADB server is unavailable for discovery.",
        "Ask for approval to use mobile_start_adb_server. Do not automatically replay startup or restart a shared server.",
      );
    }
    return inventory;
  }

  async ensureRunning(executable: string, env: NodeJS.ProcessEnv, version: number, signal?: AbortSignal): Promise<{
    startupAttempted: boolean;
    inventory: Buffer;
  }> {
    let startupAttempted = false;
    try {
      if (!await this.ready(version, signal)) {
        checkCancelled(signal);
        const child = await this.launch(executable, env);
        startupAttempted = true;
        const deadline = performance.now() + 5000;
        for (;;) {
          checkCancelled(signal);
          const remaining = Math.ceil(deadline - performance.now());
          if (remaining <= 0) {
            throw new MobileUseError(
              "ADB_SERVER_START_FAILED", "The local ADB server did not become ready within five seconds.",
              "Check local ADB startup errors and policy. Do not automatically retry or restart another server.",
            );
          }
          if (await this.ready(version, signal, remaining)) break;
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new MobileUseError(
              "ADB_SERVER_START_FAILED", "The ADB server process exited before readiness was verified.",
              "Check local ADB startup errors and policy. No restart or replacement was attempted.",
            );
          }
          await delay(Math.min(100, remaining), undefined, signal ? { signal } : {}).catch((error: unknown) => {
            checkCancelled(signal);
            throw error;
          });
        }
      }
      checkCancelled(signal);
      const inventory = await this.inventory(signal);
      return { startupAttempted, inventory };
    } catch (error) {
      throw serverStartupError(error, startupAttempted);
    }
  }
}
