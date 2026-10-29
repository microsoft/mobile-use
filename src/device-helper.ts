import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions } from "./adb.js";
import { checkCancelled, MobileUseError, publicError } from "./errors.js";

export type DeviceCommand = (args: readonly string[], options?: RunOptions) => Promise<Buffer>;

export interface DeviceHelper {
  name: string;
  fileName: string;
  mainClass: string;
  base64: string;
  sha256: string;
  ready: string;
  unavailable: (actionMayHaveRun?: boolean) => MobileUseError;
}

export async function verifyHelper(command: DeviceCommand, helper: DeviceHelper, remotePath: string, signal?: AbortSignal): Promise<void> {
  const checksum = await command(["shell", "sha256sum", remotePath], signal ? { signal } : {});
  if (checksum.toString("utf8").trim() !== `${helper.sha256}  ${remotePath}`) throw helper.unavailable();
}

export async function prepareHelper(command: DeviceCommand, helper: DeviceHelper, signal?: AbortSignal): Promise<{
  status: "prepared"; sha256: string; remotePath: string;
}> {
  checkCancelled(signal);
  const bytes = Buffer.from(helper.base64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== helper.sha256) throw helper.unavailable();
  const directory = await mkdtemp(path.join(tmpdir(), `mobile-use-${helper.name}-`));
  const localPath = path.join(directory, helper.fileName);
  const remoteDirectory = `/data/local/tmp/mobile-use-${helper.name}-${randomUUID()}`;
  const remotePath = `${remoteDirectory}/${helper.fileName}`;
  const mutation = { mutating: true, ...(signal ? { signal } : {}) };
  let created = false;
  try {
    await writeFile(localPath, bytes, { flag: "wx" });
    await command(["shell", "mkdir", "-m", "700", remoteDirectory], mutation);
    created = true;
    await command(["push", localPath, remotePath], mutation);
    await command(["shell", "chmod", "400", remotePath], mutation);
    await verifyHelper(command, helper, remotePath, signal);
    const checked = await command([
      "shell", `CLASSPATH=${remotePath}`, "app_process", "/", helper.mainClass, "--check",
    ], mutation);
    if (checked.toString("utf8").trim() !== helper.ready) throw helper.unavailable(true);
    return { status: "prepared", sha256: helper.sha256, remotePath };
  } catch (error) {
    const failure = publicError(error);
    throw new MobileUseError(failure.code, failure.message, failure.remediation, false, created || failure.actionMayHaveRun);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
