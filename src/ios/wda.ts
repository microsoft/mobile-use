import { z } from "zod";
import { checkCancelled, isRecord, MobileUseError } from "../errors.js";
import type { ErrorCode } from "../errors.js";
import type { Rect } from "../types.js";

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
export const iosBundleIdSchema = z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/);
const envelopeSchema = z.object({
  sessionId: sessionIdSchema.nullable(),
  value: z.unknown(),
  status: z.number().optional(),
});
const rectSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
});
const stringAttribute = z.string().max(4096).nullable();
const elementSchema = z.object({
  "element-6066-11e4-a52e-4f735466cecf": sessionIdSchema,
  type: z.string().regex(/^XCUIElementType[A-Za-z]+$/),
  rect: rectSchema,
  enabled: z.boolean(),
  displayed: z.boolean(),
  label: stringAttribute,
  "attribute/name": stringAttribute,
  "attribute/value": stringAttribute,
});

export interface WdaElement {
  id: string;
  type: string;
  rect: Rect;
  enabled: boolean;
  visible: boolean;
  name: string;
  label: string;
  value: string;
}

export interface WdaProbe {
  sessionId: string | null;
  iosVersion: string;
  vendorId: string;
  model: string;
  build: string;
}

export function wdaFailure(code: ErrorCode, actionMayHaveRun = false): MobileUseError {
  return new MobileUseError(code, "The iOS/WDA operation could not be verified.",
    "Check the dedicated Runner and local forwarding yourself. Reselect explicitly after connection loss; never replay uncertain input.",
    false, actionMayHaveRun);
}

export function readWdaUrl(value: string | undefined): string {
  if (!value) throw wdaFailure("WDA_CONFIG_INVALID");
  let url: URL;
  try { url = new URL(value); } catch { throw wdaFailure("WDA_CONFIG_INVALID"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
    url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw wdaFailure("WDA_CONFIG_INVALID");
  }
  return url.origin;
}

export class WdaClient {
  constructor(readonly url: string, private readonly timeoutMs = 10_000) {
    readWdaUrl(url);
  }

  private async request(method: "GET" | "POST" | "DELETE", path: string, signal?: AbortSignal,
    body?: unknown, mutating = false, expectedSession?: string) {
    checkCancelled(signal);
    try {
      const response = await fetch(`${this.url}${path}`, {
        method, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const reader = response.body?.getReader();
      if (!reader) throw wdaFailure("WDA_RESPONSE_INVALID", mutating);
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if ((length += chunk.value.length) > 24 * 1024 * 1024) throw wdaFailure("WDA_RESPONSE_INVALID", mutating);
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel(); }
      const parsed = envelopeSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success || parsed.data.value === undefined) throw wdaFailure("WDA_RESPONSE_INVALID", mutating);
      if (expectedSession && parsed.data.sessionId !== expectedSession) throw wdaFailure("TRANSPORT_LOST", mutating);
      if (!response.ok || (parsed.data.status !== undefined && parsed.data.status !== 0) ||
        (isRecord(parsed.data.value) && typeof parsed.data.value.error === "string")) {
        const error = isRecord(parsed.data.value) ? parsed.data.value.error : undefined;
        throw wdaFailure(error === "invalid session id" ? "TRANSPORT_LOST" :
          error === "no such element" || error === "stale element reference" ? "ELEMENT_CHANGED" : "WDA_COMMAND_FAILED", mutating);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof MobileUseError) throw error;
      throw wdaFailure(signal?.aborted ? "CANCELLED" : "WDA_UNAVAILABLE", mutating);
    }
  }

  async probe(signal?: AbortSignal): Promise<WdaProbe> {
    const status = await this.request("GET", "/status", signal);
    const parsed = z.object({
      ready: z.literal(true),
      os: z.object({ name: z.literal("iOS"), version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/) }),
      build: z.object({ time: z.string().min(1), productBundleIdentifier: z.string().min(1) }),
      ios: z.object({ simulatorVersion: z.unknown().optional() }).optional(),
    }).safeParse(status.value);
    if (!parsed.success) throw wdaFailure("WDA_RESPONSE_INVALID");
    if (parsed.data.ios?.simulatorVersion !== undefined || Number(parsed.data.os.version.split(".")[0]) < 17) {
      throw wdaFailure("DEVICE_UNSUPPORTED");
    }
    const info = await this.request("GET", "/wda/device/info", signal);
    const device = z.object({
      uuid: z.string().uuid(), model: z.string().min(1).max(128), isSimulator: z.literal(false),
    }).safeParse(info.value);
    if (!device.success) throw wdaFailure("DEVICE_UNSUPPORTED");
    if (status.sessionId !== info.sessionId) throw wdaFailure("TRANSPORT_LOST");
    return {
      sessionId: status.sessionId, iosVersion: parsed.data.os.version,
      vendorId: device.data.uuid, model: device.data.model,
      build: JSON.stringify(parsed.data.build),
    };
  }

  async createSession(signal?: AbortSignal): Promise<string> {
    const response = await this.request("POST", "/session", signal, { capabilities: { alwaysMatch: {
      shouldUseCompactResponses: false,
      elementResponseAttributes: "type,rect,enabled,displayed,label,attribute/name,attribute/value",
      shouldTerminateApp: false,
      shouldWaitForQuiescence: true,
      disableAutomaticScreenshots: true,
    } } }, true);
    const parsed = z.object({ sessionId: sessionIdSchema }).safeParse(response.value);
    if (!parsed.success || parsed.data.sessionId !== response.sessionId) throw wdaFailure("WDA_RESPONSE_INVALID", true);
    return parsed.data.sessionId;
  }

  async command(sessionId: string, method: "GET" | "POST", path: string, signal?: AbortSignal, body?: unknown,
    mutating = method === "POST") {
    return (await this.request(method, `/session/${sessionId}${path}`, signal, body, mutating, sessionId)).value;
  }

  async home(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/wda/homescreen", signal, {}, true, sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    const current = await this.probe();
    if (current.sessionId !== sessionId) throw wdaFailure("TRANSPORT_LOST");
    await this.request("DELETE", `/session/${sessionId}`, undefined, undefined, true);
  }

  async activeApp(sessionId: string, signal?: AbortSignal) {
    const parsed = z.object({
      bundleId: iosBundleIdSchema,
      pid: z.number().int().positive(),
    }).safeParse(await this.command(sessionId, "GET", "/wda/activeAppInfo", signal));
    if (!parsed.success) throw wdaFailure("APP_FOREGROUND_UNAVAILABLE");
    return parsed.data;
  }

  async screen(sessionId: string, signal?: AbortSignal) {
    const parsed = z.object({
      screenSize: z.object({ width: z.number().positive().max(8192), height: z.number().positive().max(8192) }),
      scale: z.number().positive().max(4),
    }).safeParse(await this.command(sessionId, "GET", "/wda/screen", signal));
    const rotation = z.object({
      x: z.literal(0), y: z.literal(0),
      z: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    }).safeParse(await this.command(sessionId, "GET", "/rotation", signal));
    if (!parsed.success || !rotation.success) throw wdaFailure("DISPLAY_STATE_UNAVAILABLE");
    const { screenSize, scale } = parsed.data;
    const width = Math.round(screenSize.width * scale);
    const height = Math.round(screenSize.height * scale);
    if (Math.abs(width - screenSize.width * scale) > 0.01 ||
      Math.abs(height - screenSize.height * scale) > 0.01) throw wdaFailure("DISPLAY_STATE_UNAVAILABLE");
    return { width, height, scale, rotation: rotation.data.z / 90 };
  }

  async assertUnlocked(sessionId: string, signal?: AbortSignal) {
    if (await this.command(sessionId, "GET", "/wda/locked", signal) !== false) {
      throw new MobileUseError("MANUAL_UNLOCK_REQUIRED", "Unlock the iPhone manually before observation or input.",
        "Never send credentials or authentication screens to Copilot.");
    }
  }

  async source(sessionId: string, signal?: AbortSignal): Promise<string> {
    const value = await this.command(sessionId, "GET", "/source?format=xml", signal);
    if (typeof value !== "string") throw wdaFailure("HIERARCHY_UNAVAILABLE");
    return value;
  }

  async screenshot(sessionId: string, signal?: AbortSignal): Promise<Buffer> {
    const value = await this.command(sessionId, "GET", "/screenshot", signal);
    if (typeof value !== "string" || !value.length || value.length > 24 * 1024 * 1024 ||
      value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw wdaFailure("CAPTURE_UNAVAILABLE");
    }
    return Buffer.from(value, "base64");
  }

  private element(value: unknown): WdaElement {
    const parsed = elementSchema.safeParse(value);
    if (!parsed.success) throw wdaFailure("WDA_RESPONSE_INVALID");
    return {
      id: parsed.data["element-6066-11e4-a52e-4f735466cecf"],
      type: parsed.data.type, rect: parsed.data.rect,
      enabled: parsed.data.enabled, visible: parsed.data.displayed,
      name: parsed.data["attribute/name"] ?? "", label: parsed.data.label ?? "",
      value: parsed.data["attribute/value"] ?? "",
    };
  }

  async find(sessionId: string, type: string, name: string, signal?: AbortSignal): Promise<WdaElement[]> {
    const literal = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    const result = await this.command(sessionId, "POST", "/elements", signal, {
      using: "predicate string", value: `type == ${literal(type)} AND name == ${literal(name)}`,
    }, false);
    if (!Array.isArray(result) || result.length > 100) throw wdaFailure("ELEMENT_CHANGED");
    return result.map((value: unknown) => this.element(value));
  }

  async focused(sessionId: string, signal?: AbortSignal): Promise<WdaElement | null> {
    let result: unknown;
    try { result = await this.command(sessionId, "GET", "/element/active", signal); }
    catch (error) {
      if (error instanceof MobileUseError && error.code === "ELEMENT_CHANGED") return null;
      throw error;
    }
    // Do not return a secure editor's name, label or value to the public observation.
    const type = isRecord(result) ? result.type : undefined;
    if (type === "XCUIElementTypeSecureTextField") return null;
    return this.element(result);
  }

  async assertHittable(sessionId: string, elementId: string, signal?: AbortSignal) {
    if (await this.command(sessionId, "GET", `/element/${elementId}/attribute/hittable`, signal) !== true) {
      throw wdaFailure("ELEMENT_CHANGED");
    }
  }
}
