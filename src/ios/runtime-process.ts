import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { checkCancelled, isRecord, MobileUseError } from "../errors.js";

export function runtimeFailure(code: "IOS_RUNTIME_FAILED" | "IOS_RUNTIME_NOT_READY" |
  "IOS_RUNTIME_CONFLICT" | "IOS_RUNTIME_CONFIG_INVALID" | "IOS_RUNTIME_CLEANUP_FAILED", uncertain = false) {
  return new MobileUseError(code, "The managed iOS runtime operation could not be verified.",
    code === "IOS_RUNTIME_CLEANUP_FAILED"
      ? "Inspect local runtime logs, WDA state and remaining owned processes, then fully restart the MCP server. Never uninstall or terminate foreign processes."
      : "Inspect the local runtime logs and device trust/Developer Mode. Stop this runtime explicitly before restarting; do not replay uncertain installation.",
    false, uncertain);
}

export interface OwnedProcess {
  exited: Promise<void>;
  assertRunning(): void;
  stop(): Promise<void>;
}

export interface RuntimeCommands {
  run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal, mutating?: boolean, logPath?: string,
    environment?: NodeJS.ProcessEnv): Promise<string>;
  start(file: string, args: string[], logPath: string, environment?: NodeJS.ProcessEnv): Promise<OwnedProcess>;
}

const execute = promisify(execFile);
async function commandLog(logPath: string | undefined, value: unknown, mutating: boolean) {
  if (!logPath) return;
  const record = isRecord(value) ? value : {};
  const output = [record.stdout, record.stderr, record.message].filter((entry) => typeof entry === "string").join("\n");
  try { await writeFile(logPath, output, { flag: "wx", mode: 0o600 }); }
  catch { throw runtimeFailure("IOS_RUNTIME_FAILED", mutating); }
}

export const runtimeCommands: RuntimeCommands = {
  async run(file, args, timeout, signal, mutating = false, logPath, environment) {
    checkCancelled(signal);
    let output: { stdout: string; stderr: string };
    try {
      output = await execute(file, args, {
        timeout, signal, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, ...environment, ENABLE_GO_IOS_AGENT: "" },
      });
    } catch (error) {
      await commandLog(logPath, error, mutating);
      if (signal?.aborted) {
        throw new MobileUseError("CANCELLED", "The runtime command was cancelled.",
          "Check the device and runtime before restarting; cancellation does not prove device-side work stopped.", false, mutating);
      }
      throw runtimeFailure("IOS_RUNTIME_FAILED", mutating);
    }
    await commandLog(logPath, output, mutating);
    return output.stdout;
  },
  async start(file, args, logPath, environment) {
    const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    try { await once(log, "open"); } catch { throw runtimeFailure("IOS_RUNTIME_FAILED"); }
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, ...environment, ENABLE_GO_IOS_AGENT: "" },
    });
    let ended = false;
    const exited = new Promise<void>((resolve) => {
      const exit = () => { ended = true; resolve(); };
      child.once("error", exit);
      child.once("exit", exit);
      log.on("error", () => { exit(); child.kill(); });
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => {
      if (log.destroyed) resolve();
      else log.end(resolve);
    }));
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    try { await once(child, "spawn"); }
    catch { await closed; throw runtimeFailure("IOS_RUNTIME_FAILED"); }
    let stopping: Promise<void> | undefined;
    return {
      exited,
      assertRunning() { if (ended) throw runtimeFailure("IOS_RUNTIME_FAILED"); },
      stop() {
        stopping ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
          let force: ReturnType<typeof setTimeout> | undefined;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([closed, new Promise<never>((_resolve, reject) => {
              force = setTimeout(() => child.kill("SIGKILL"), 5000);
              deadline = setTimeout(() => reject(runtimeFailure("IOS_RUNTIME_CLEANUP_FAILED")), 10000);
            })]);
          } finally { clearTimeout(force); clearTimeout(deadline); }
        })();
        return stopping;
      },
    };
  },
};
