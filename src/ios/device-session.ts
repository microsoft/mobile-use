import { randomUUID } from "node:crypto";
import { decodePng } from "../android.js";
import { OBSERVATION_MAX_AGE_MS } from "../device-session.js";
import { checkCancelled, MobileUseError, publicError } from "../errors.js";
import type { MobileService, IosAppOperationResult, IosDoctor, IosForegroundApp, IosSelectedTarget } from "../mobile-service.js";
import { compareScreens, containsPoint, interactionRegion, intersects } from "../screen-guard.js";
import { actionSchema } from "../types.js";
import type {
  ActionResult, AdbServerResult, DeviceEndpoint, InstalledApps, MobileAction, ObservedScreen,
  PreparedGestures, PreparedTextInput, RecordingAction, RecordingResult, Rect, WakeResult,
} from "../types.js";
import { matchesWdaElement, nodeSignature, parseIosHierarchy } from "./hierarchy.js";
import type { IosNode } from "./hierarchy.js";
import { iosBundleIdSchema, readWdaUrl, WdaClient, wdaFailure } from "./wda.js";
import type { WdaElement, WdaProbe } from "./wda.js";
import {
  iosRuntimeActionSchema,
  type IosRuntime,
  type IosRuntimeAction,
  type IosRuntimeLostEvent,
  type IosRuntimeStatus,
  type RuntimeBinding,
} from "./runtime.js";
import { runtimeFailure } from "./runtime-process.js";

const MAX_RETIRED_TOKENS = 256;

interface IosTargetSession {
  readonly token: string;
  readonly endpointId: string;
  readonly udid?: string;
  readonly wda: WdaClient;
  readonly sessionId: string;
  readonly probe: WdaProbe;
  readonly controller: AbortController;
  readonly runtimeToken?: string;
  snapshot: Snapshot | undefined;
  lost: boolean;
  queue: Promise<void>;
}

interface OwnedWdaSession {
  readonly endpointId: string;
  readonly udid?: string;
  readonly wda: WdaClient;
  readonly sessionId: string;
  readonly probe: WdaProbe;
  readonly runtimeToken?: string;
}

interface Snapshot {
  screen: ObservedScreen;
  nodes: IosNode[];
  focus: WdaElement | null;
  app: { bundleId: string; pid: number };
  display: { width: number; height: number; rotation: number; scale: number };
  createdAt: number;
}

const unsupported = ["adb", "wake", "BACK", "ENTER", "helper-prepare", "recording",
  "app-list", "app-terminate", "app-install", "app-uninstall"] as const;
const invalidatingCodes = new Set(["WDA_UNAVAILABLE", "TRANSPORT_LOST", "WDA_RESPONSE_INVALID", "DEVICE_UNSUPPORTED",
  "IOS_USB_UNAVAILABLE", "IOS_RUNTIME_FAILED", "IOS_RUNTIME_NOT_READY"]);

async function awaitTargetQueue(queue: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await queue;
    return;
  }
  checkCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(wdaFailure("CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });
    queue.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
  checkCancelled(signal);
}

export class IosMobileUseService implements MobileService {
  readonly platform = "ios";
  private readonly clients = new Map<string, WdaClient>();
  private readonly targets = new Map<string, IosTargetSession>();
  private readonly ownedSessions = new Map<string, OwnedWdaSession>();
  private readonly retiredTokens = new Map<string, "stale" | "lost">();
  private hostQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  private hostLost = false;
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;
  readonly iosRuntime?: (action: IosRuntimeAction, signal?: AbortSignal) => Promise<IosRuntimeStatus>;

  constructor(private readonly configuredUrl: string | undefined,
    private readonly now: () => number = Date.now, private readonly runtime?: IosRuntime) {
    if (runtime) {
      runtime.onLost = (event) => this.handleRuntimeLost(event);
      this.iosRuntime = (action, signal) => this.controlRuntime(action, signal);
    }
  }

  private clientForUrl(url: string): WdaClient {
    let client = this.clients.get(url);
    if (!client) {
      client = new WdaClient(url);
      this.clients.set(url, client);
    }
    return client;
  }

  private externalClient(): WdaClient {
    return this.clientForUrl(readWdaUrl(this.configuredUrl));
  }

  private readyRuntimeBindings(): RuntimeBinding[] {
    if (!this.runtime) return [];
    if (this.runtime.bindings) return this.runtime.bindings();
    try { return [this.runtime.binding()]; } catch { return []; }
  }

  private recordRetiredToken(token: string, reason: "stale" | "lost") {
    if (this.retiredTokens.has(token)) this.retiredTokens.delete(token);
    this.retiredTokens.set(token, reason);
    while (this.retiredTokens.size > MAX_RETIRED_TOKENS) {
      const oldest = this.retiredTokens.keys().next().value;
      if (oldest === undefined) break;
      this.retiredTokens.delete(oldest);
    }
  }

  private retireTarget(token: string, reason: "stale" | "lost", dropOwned: boolean) {
    const session = this.targets.get(token);
    if (!session) return;
    this.targets.delete(token);
    session.lost = reason === "lost";
    session.snapshot = undefined;
    session.controller.abort();
    this.recordRetiredToken(token, reason);
    if (dropOwned) {
      const owned = this.ownedSessions.get(session.endpointId);
      if (owned?.sessionId === session.sessionId) this.ownedSessions.delete(session.endpointId);
    }
  }

  private deselectEndpoint(endpointId: string, clearRetired = true) {
    for (const [token, session] of [...this.targets.entries()]) {
      if (session.endpointId !== endpointId) continue;
      this.targets.delete(token);
      session.snapshot = undefined;
      session.controller.abort();
      if (clearRetired) this.retiredTokens.delete(token);
    }
  }

  private handleRuntimeLost(event?: IosRuntimeLostEvent) {
    const matchAllManaged = !event?.runtimeToken && !event?.udid;
    for (const session of [...this.targets.values()]) {
      if (!session.runtimeToken && !session.udid) continue;
      const matches = matchAllManaged ||
        (event?.runtimeToken !== undefined && session.runtimeToken === event.runtimeToken) ||
        (event?.udid !== undefined && session.udid === event.udid);
      if (!matches) continue;
      this.clients.delete(session.wda.url);
      this.retireTarget(session.token, "lost", true);
    }
    for (const [endpointId, owned] of [...this.ownedSessions.entries()]) {
      if (!owned.runtimeToken && !owned.udid) continue;
      const matches = matchAllManaged ||
        (event?.runtimeToken !== undefined && owned.runtimeToken === event.runtimeToken) ||
        (event?.udid !== undefined && owned.udid === event.udid);
      if (matches) {
        this.clients.delete(owned.wda.url);
        this.ownedSessions.delete(endpointId);
      }
    }
  }

  private serializeHost<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.hostQueue.then(async () => {
      if (this.stopped) throw wdaFailure("SERVER_STOPPED");
      checkCancelled(signal);
      return operation();
    });
    this.hostQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireTarget(token: string): IosTargetSession {
    const active = this.targets.get(token);
    if (active) {
      if (active.lost) {
        this.retireTarget(token, "lost", true);
        throw wdaFailure("TRANSPORT_LOST");
      }
      return active;
    }
    const retired = this.retiredTokens.get(token);
    if (retired === "lost") throw wdaFailure("TRANSPORT_LOST");
    if (retired === "stale") throw wdaFailure("STALE_TARGET");
    throw wdaFailure(this.hostLost ? "TRANSPORT_LOST" : "TARGET_NOT_SELECTED");
  }

  private serializeTarget<T>(
    token: string,
    operation: (target: IosTargetSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.stopped) return Promise.reject(wdaFailure("SERVER_STOPPED"));
    try { checkCancelled(signal); } catch (error) { return Promise.reject(error); }
    const existing = this.targets.get(token);
    if (!existing) {
      return this.serializeHost(async () => {
        const resolved = this.requireTarget(token);
        return operation(resolved);
      }, signal);
    }
    const result = existing.queue.then(async () => {
      if (this.stopped) throw wdaFailure("SERVER_STOPPED");
      checkCancelled(signal);
      const current = this.requireTarget(token);
      try {
        return await operation(current);
      } catch (error) {
        if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) {
          this.retireTarget(current.token, "lost", true);
        }
        throw error;
      }
    });
    existing.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private signal(target: IosTargetSession, request?: AbortSignal): AbortSignal {
    return AbortSignal.any([target.controller.signal, this.lifetime.signal, ...(request ? [request] : [])]);
  }

  private async ensure(target: IosTargetSession, signal: AbortSignal) {
    this.requireTarget(target.token);
    if (this.runtime && target.runtimeToken !== undefined) {
      await this.runtime.verify(target.runtimeToken, signal);
    }
    const probe = await target.wda.probe(signal);
    if (probe.sessionId !== target.sessionId || probe.vendorId !== target.probe.vendorId ||
      probe.build !== target.probe.build || probe.iosVersion !== target.probe.iosVersion) {
      throw wdaFailure("TRANSPORT_LOST");
    }
    this.requireTarget(target.token);
    checkCancelled(signal);
  }

  private buildEndpoint(probe: WdaProbe, wdaUrl: string, binding?: RuntimeBinding): DeviceEndpoint {
    const endpointId = binding ? `ios:usb:${binding.udid}` : `ios:${new URL(wdaUrl).host}`;
    const owned = this.ownedSessions.get(endpointId);
    const conflict = probe.sessionId !== null && probe.sessionId !== owned?.sessionId;
    return {
      platform: "ios",
      endpointId,
      transportId: binding?.udid ?? null,
      kind: binding ? "usb" : "unknown",
      state: "device",
      model: probe.model,
      selectable: !conflict,
      reason: conflict ? "A foreign WDA session is active. Use a dedicated Runner; never replace another controller's session."
        : binding ? "Managed WDA bound to the verified USB UDID."
          : "User-managed local WDA forwarding; its physical USB/network transport is not independently verified.",
    };
  }

  private retireEndpointSessions(endpointId: string) {
    for (const session of [...this.targets.values()]) {
      if (session.endpointId === endpointId) {
        this.retireTarget(session.token, "lost", true);
      }
    }
    this.ownedSessions.delete(endpointId);
  }

  private reconcileTargetProbe(endpointId: string, probe: WdaProbe) {
    for (const session of [...this.targets.values()]) {
      if (session.endpointId !== endpointId) continue;
      if (probe.vendorId !== session.probe.vendorId ||
        probe.build !== session.probe.build ||
        probe.sessionId !== session.sessionId) {
        this.retireTarget(session.token, "lost", true);
      }
    }
  }

  doctor(signal?: AbortSignal): Promise<IosDoctor> {
    return this.serializeHost(async () => {
      let goIosVersion: string | undefined;
      if (this.runtime) {
        try {
          goIosVersion = await this.runtime.prerequisites(signal);
        } catch (error) {
          if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) {
            for (const session of [...this.targets.values()]) {
              if (session.udid) this.retireTarget(session.token, "lost", true);
            }
            for (const [endpointId, owned] of [...this.ownedSessions.entries()]) {
              if (owned.udid) this.ownedSessions.delete(endpointId);
            }
          }
          throw error;
        }
      }
      if (this.runtime && this.configuredUrl === undefined) {
        const ready = this.readyRuntimeBindings();
        if (ready.length === 0) {
          return {
            status: "runtime-not-ready" as const,
            platform: "ios" as const,
            goIosVersion: goIosVersion!,
            runtime: this.runtime.status(),
          };
        }
        const primary = ready[0]!;
        const endpointId = `ios:usb:${primary.udid}`;
        try {
          await this.runtime.verify(primary.token, signal);
          const client = this.clientForUrl(primary.url);
          const probe = await client.probe(signal);
          return {
            status: "ready" as const,
            platform: "ios" as const,
            wdaUrl: client.url,
            iosVersion: probe.iosVersion,
            model: probe.model,
            runtime: this.runtime.status(),
          };
        } catch (error) {
          if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) {
            this.retireEndpointSessions(endpointId);
          }
          throw error;
        }
      }
      const client = this.externalClient();
      const ready = this.readyRuntimeBindings();
      if (this.runtime && ready[0]) {
        const primary = ready[0];
        const managedEndpointId = `ios:usb:${primary.udid}`;
        try {
          await this.runtime.verify(primary.token, signal);
        } catch (error) {
          if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) {
            this.retireEndpointSessions(managedEndpointId);
          }
          throw error;
        }
      }
      const externalEndpointId = `ios:${new URL(client.url).host}`;
      try {
        const probe = await client.probe(signal);
        return {
          status: "ready" as const,
          platform: "ios" as const,
          wdaUrl: client.url,
          iosVersion: probe.iosVersion,
          model: probe.model,
          ...(this.runtime ? { runtime: this.runtime.status() } : {}),
        };
      } catch (error) {
        if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) {
          this.retireEndpointSessions(externalEndpointId);
        }
        throw error;
      }
    }, signal);
  }

  private isCancellationOrShutdown(error: unknown, signal?: AbortSignal): boolean {
    if (this.stopped || signal?.aborted) return true;
    return error instanceof MobileUseError && (error.code === "CANCELLED" || error.code === "SERVER_STOPPED");
  }

  listDevices(signal?: AbortSignal): Promise<DeviceEndpoint[]> {
    return this.serializeHost(async () => {
      const results: DeviceEndpoint[] = [];
      let usbDiscoveryError: unknown;
      if (this.runtime) {
        let usbDevices: DeviceEndpoint[] | undefined;
        try {
          usbDevices = await this.runtime.devices(signal);
        } catch (error) {
          if (this.isCancellationOrShutdown(error, signal)) throw error;
          for (const session of [...this.targets.values()]) {
            if (session.udid) this.retireTarget(session.token, "lost", true);
          }
          if (this.configuredUrl === undefined) throw error;
          usbDiscoveryError = error;
        }
        if (usbDevices) {
          const connectedEndpoints = new Set(usbDevices.map((entry) => entry.endpointId));
          for (const session of [...this.targets.values()]) {
            if (session.udid && !connectedEndpoints.has(session.endpointId)) {
              this.retireTarget(session.token, "lost", true);
            }
          }
          const bindingsByEndpoint = new Map<string, RuntimeBinding>(
            this.readyRuntimeBindings().map((binding) => [`ios:usb:${binding.udid}`, binding] as const),
          );
          for (const entry of usbDevices) {
            const binding = bindingsByEndpoint.get(entry.endpointId);
            if (!binding) {
              results.push(entry);
              continue;
            }
            try {
              await this.runtime.verify(binding.token, signal);
              const client = this.clientForUrl(binding.url);
              const probe = await client.probe(signal);
              this.reconcileTargetProbe(entry.endpointId, probe);
              results.push(this.buildEndpoint(probe, client.url, binding));
            } catch (error) {
              if (this.isCancellationOrShutdown(error, signal)) throw error;
              for (const session of [...this.targets.values()]) {
                if (session.endpointId === entry.endpointId) {
                  this.retireTarget(session.token, "lost", true);
                }
              }
              results.push({
                ...entry,
                state: "offline",
                model: null,
                selectable: false,
                reason: publicError(error).message,
              });
            }
          }
        }
      }
      if (!this.runtime) {
        const client = this.externalClient();
        const endpointId = `ios:${new URL(client.url).host}`;
        try {
          const probe = await client.probe(signal);
          this.reconcileTargetProbe(endpointId, probe);
          results.push(this.buildEndpoint(probe, client.url));
        } catch (error) {
          if (!this.isCancellationOrShutdown(error, signal)) {
            for (const session of [...this.targets.values()]) {
              if (session.endpointId === endpointId) {
                this.retireTarget(session.token, "lost", true);
              }
            }
          }
          throw error;
        }
      } else if (this.configuredUrl !== undefined) {
        let client: WdaClient | undefined;
        try {
          client = this.externalClient();
        } catch (error) {
          if (this.isCancellationOrShutdown(error, signal) || usbDiscoveryError !== undefined || results.length === 0) {
            throw error;
          }
          results.push({
            platform: "ios",
            endpointId: "ios:external",
            transportId: null,
            kind: "unknown",
            state: "offline",
            model: null,
            selectable: false,
            reason: publicError(error).message,
          });
        }
        if (client) {
          const endpointId = `ios:${new URL(client.url).host}`;
          try {
            const probe = await client.probe(signal);
            this.reconcileTargetProbe(endpointId, probe);
            results.push(this.buildEndpoint(probe, client.url));
          } catch (error) {
            if (this.isCancellationOrShutdown(error, signal)) throw error;
            for (const session of [...this.targets.values()]) {
              if (session.endpointId === endpointId) {
                this.retireTarget(session.token, "lost", true);
              }
            }
            if (usbDiscoveryError !== undefined) throw error;
            results.push({
              platform: "ios",
              endpointId,
              transportId: null,
              kind: "unknown",
              state: "offline",
              model: null,
              selectable: false,
              reason: publicError(error).message,
            });
          }
        }
      }
      return results;
    }, signal);
  }

  selectDevice(endpointId: string, request?: AbortSignal): Promise<IosSelectedTarget> {
    return this.serializeHost(async () => {
      const signal = AbortSignal.any([this.lifetime.signal, ...(request ? [request] : [])]);
      let binding: RuntimeBinding | undefined;
      let client: WdaClient;
      if (this.runtime && endpointId.startsWith("ios:usb:")) {
        try {
          try {
            binding = this.runtime.binding(endpointId);
          } catch (error) {
            if (error instanceof MobileUseError && error.code === "IOS_RUNTIME_NOT_READY" &&
              this.readyRuntimeBindings().length > 0) {
              const usbDevices = await this.runtime.devices(signal);
              if (!usbDevices.some((entry) => entry.endpointId === endpointId)) throw wdaFailure("DEVICE_NOT_FOUND");
            }
            throw error;
          }
          await this.runtime.verify(binding.token, signal);
          client = this.clientForUrl(binding.url);
        } catch (error) {
          if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) {
            this.retireEndpointSessions(endpointId);
          }
          throw error;
        }
      } else if (!this.runtime || this.configuredUrl !== undefined) {
        client = this.externalClient();
      } else {
        if (this.readyRuntimeBindings().length === 0) throw runtimeFailure("IOS_RUNTIME_NOT_READY");
        throw wdaFailure("DEVICE_NOT_FOUND");
      }

      const matchingActive = [...this.targets.values()].filter((session) =>
        session.endpointId === endpointId || (binding !== undefined && session.udid === binding.udid));
      for (const existing of matchingActive) {
        let settled: Promise<void>;
        do {
          settled = existing.queue;
          await awaitTargetQueue(settled, signal);
        } while (existing.queue !== settled);
        this.retireTarget(existing.token, "stale", false);
      }

      let createdTarget: IosTargetSession | undefined;
      try {
        const probe = await client.probe(signal);
        const resolvedEndpoint = this.buildEndpoint(probe, client.url, binding);
        if (endpointId !== resolvedEndpoint.endpointId) throw wdaFailure("DEVICE_NOT_FOUND");
        const owned = this.ownedSessions.get(endpointId);
        if (owned) {
          if (probe.sessionId !== owned.sessionId || probe.vendorId !== owned.probe.vendorId ||
            probe.build !== owned.probe.build) {
            this.ownedSessions.delete(endpointId);
            throw wdaFailure("TRANSPORT_LOST");
          }
          await client.closeSession(owned.sessionId);
          this.ownedSessions.delete(endpointId);
        } else if (probe.sessionId !== null) {
          throw wdaFailure("WDA_SESSION_CONFLICT");
        }
        checkCancelled(signal);
        const before = await client.probe(signal);
        if (before.sessionId !== null || before.vendorId !== probe.vendorId || before.build !== probe.build) {
          throw wdaFailure("WDA_SESSION_CONFLICT");
        }
        const sessionId = await client.createSession(signal);
        this.ownedSessions.set(endpointId, {
          endpointId,
          ...(binding ? { udid: binding.udid, runtimeToken: binding.token } : {}),
          wda: client,
          sessionId,
          probe: before,
        });
        checkCancelled(signal);
        const target: IosTargetSession = {
          token: randomUUID(),
          endpointId,
          ...(binding ? { udid: binding.udid, runtimeToken: binding.token } : {}),
          wda: client,
          sessionId,
          probe: before,
          controller: new AbortController(),
          snapshot: undefined,
          lost: false,
          queue: Promise.resolve(),
        };
        createdTarget = target;
        this.targets.set(target.token, target);
        await this.ensure(target, signal);
        this.hostLost = false;
        return {
          targetToken: target.token,
          endpoint: this.buildEndpoint({ ...before, sessionId }, client.url, binding),
          identity: {
            platform: "ios",
            vendorId: before.vendorId,
            iosVersion: before.iosVersion,
            model: before.model,
            ...(binding ? { udid: binding.udid } : {}),
          },
          capabilities: { tap: true, swipe: true, text: true, home: true, appLaunch: true, screenshot: true, unsupported },
        };
      } catch (error) {
        if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) {
          const probedEndpointId = binding ? `ios:usb:${binding.udid}` : `ios:${new URL(client.url).host}`;
          if (createdTarget) {
            this.retireTarget(createdTarget.token, "lost", true);
          }
          this.retireEndpointSessions(probedEndpointId);
          for (const existing of matchingActive) this.recordRetiredToken(existing.token, "lost");
        } else if (createdTarget) {
          this.targets.delete(createdTarget.token);
          createdTarget.snapshot = undefined;
          createdTarget.controller.abort();
        }
        throw error;
      }
    }, request);
  }

  private async capture(target: IosTargetSession, signal: AbortSignal, includeScreenshot: boolean): Promise<Snapshot> {
    await this.ensure(target, signal);
    await target.wda.assertUnlocked(target.sessionId, signal);
    const startedAt = new Date(this.now()).toISOString();
    const start = performance.now();
    const display = await target.wda.screen(target.sessionId, signal);
    const app = await target.wda.activeApp(target.sessionId, signal);
    const hierarchyStart = performance.now();
    const hierarchy = parseIosHierarchy(await target.wda.source(target.sessionId, signal), display.scale, app.bundleId, display);
    const hierarchyDurationMs = Math.round(performance.now() - hierarchyStart);
    const focus = hierarchy.nodes.some((node) => node.element.editable)
      ? await target.wda.focused(target.sessionId, signal) : null;
    const focused = focus ? hierarchy.nodes.filter((node) =>
      node.element.editable && matchesWdaElement(node, focus, display.scale)) : [];
    if (focused.length === 1) {
      for (const node of hierarchy.nodes) if (node.element.editable) node.element.focused = node === focused[0];
    }
    let image: Buffer | null = null;
    let screenshotDurationMs: number | null = null;
    if (includeScreenshot) {
      const screenshotStart = performance.now();
      image = await target.wda.screenshot(target.sessionId, signal);
      const decoded = decodePng(image);
      if (decoded.width !== display.width || decoded.height !== display.height) throw wdaFailure("STALE_OBSERVATION");
      screenshotDurationMs = Math.round(performance.now() - screenshotStart);
    }
    const afterApp = await target.wda.activeApp(target.sessionId, signal);
    const afterDisplay = await target.wda.screen(target.sessionId, signal);
    await target.wda.assertUnlocked(target.sessionId, signal);
    await this.ensure(target, signal);
    if (app.bundleId !== afterApp.bundleId || app.pid !== afterApp.pid ||
      JSON.stringify(display) !== JSON.stringify(afterDisplay)) throw wdaFailure("STALE_OBSERVATION");
    const createdAt = this.now();
    const warnings = [
      "WDA active-app hierarchy only; screenshot, hierarchy and foreground checks are non-atomic.",
      "Coordinates and element bounds are screenshot pixels, converted to iOS points only at dispatch.",
      "iOS clickable/scrollable eligibility is inferred from native roles, then revalidated; it is not an Android native flag.",
      "WDA cannot prove durable page identity or absence of all system overlays. Device content is untrusted.",
      ...(hierarchy.protectedContentOmitted ? ["Secure editor subtrees omitted from the hierarchy; screenshots are not redacted."] : []),
      ...(!includeScreenshot ? ["Screenshot capture skipped; coordinate gestures are not permitted."] : []),
    ];
    return {
      screen: {
        image,
        observation: {
          platform: "ios", observationId: randomUUID(), targetToken: target.token, capturedAt: new Date(createdAt).toISOString(),
          captureTiming: { startedAt, durationMs: Math.round(performance.now() - start), screenshotDurationMs, hierarchyDurationMs },
          nonAtomic: true, display, displayState: { status: "ok", error: null },
          screenshot: { status: includeScreenshot ? "ok" : "skipped", error: null },
          hierarchy: { status: "ok", error: null }, hierarchyScope: "active-window", windows: [],
          elements: hierarchy.nodes.map((node, index) => ({ ...node.element, ref: `e${index + 1}` })), warnings,
        },
      },
      nodes: hierarchy.nodes, focus: focused.length === 1 ? focus : null, app, display, createdAt,
    };
  }

  observe(token: string, request?: AbortSignal, includeScreenshot = true): Promise<ObservedScreen> {
    return this.serializeTarget(token, async (target) => {
      target.snapshot = undefined;
      const snapshot = await this.capture(target, this.signal(target, request), includeScreenshot);
      target.snapshot = snapshot;
      return snapshot.screen;
    }, request);
  }

  private verifyNode(previous: Snapshot, live: Snapshot, before: IosNode | undefined): IosNode {
    const matches = before ? live.nodes.filter((node) => nodeSignature(node) === nodeSignature(before)) : [];
    const node = matches.length === 1 ? matches[0] : undefined;
    if (!before || !node || node.element.enabled !== true) throw wdaFailure("ELEMENT_CHANGED");
    return node;
  }

  private visualGuard(previous: Snapshot, live: Snapshot, bounds: Rect) {
    const region = interactionRegion(previous.display, bounds);
    const before = previous.screen.image;
    const after = live.screen.image;
    if (!before || !after) throw wdaFailure("CAPTURE_UNAVAILABLE");
    const difference = compareScreens(before, after, region);
    const metadata = (snapshot: Snapshot) => JSON.stringify(snapshot.nodes.filter((node) =>
      intersects(node.element.bounds, region)).map(nodeSignature).sort());
    if (difference.regionChangedPixels || metadata(previous) !== metadata(live)) {
      throw new MobileUseError("STALE_OBSERVATION", "The visual target or its surrounding metadata changed before input.",
        "Observe again. No input was sent.", false, false, {
          ...difference, protectedRegion: region,
          previousCapture: previous.screen.observation.captureTiming, currentCapture: live.screen.observation.captureTiming,
        });
    }
  }

  private point(point: { x: number; y: number }, snapshot: Snapshot) {
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
      !containsPoint({ x: 0, y: 0, width: snapshot.display.width, height: snapshot.display.height }, point)) {
      throw wdaFailure("INVALID_INPUT");
    }
  }

  private async resolve(target: IosTargetSession, node: IosNode, scale: number, signal: AbortSignal) {
    const matches = (await target.wda.find(target.sessionId, node.element.className, node.name, signal))
      .filter((element) => matchesWdaElement(node, element, scale));
    const element = matches.length === 1 ? matches[0] : undefined;
    if (!element) throw wdaFailure("ELEMENT_CHANGED");
    await target.wda.assertHittable(target.sessionId, element.id, signal);
    return element;
  }

  private async dispatch(target: IosTargetSession, action: MobileAction, previous: Snapshot, live: Snapshot, signal: AbortSignal) {
    const refNode = (ref: string) => {
      const index = previous.screen.observation.elements.findIndex((element) => element.ref === ref);
      return previous.nodes[index];
    };
    const coordinateMode = () => {
      if (!previous.screen.image || !live.screen.image) throw wdaFailure("CAPTURE_UNAVAILABLE");
    };
    const verifyStart = (point: { x: number; y: number }, swipe = false) => {
      const metadata = (snapshot: Snapshot) => JSON.stringify(snapshot.nodes.filter((node) =>
        (node.element.clickable || (swipe && node.element.scrollable)) && containsPoint(node.element.bounds, point))
        .map(nodeSignature).sort());
      if (metadata(previous) !== metadata(live)) throw wdaFailure("ELEMENT_CHANGED");
    };
    let pointerActions: Array<Record<string, string | number>> | undefined;
    const move = (point: { x: number; y: number }, duration = 0) => ({
      type: "pointerMove", origin: "viewport", x: point.x / live.display.scale, y: point.y / live.display.scale, duration,
    });
    const down = { type: "pointerDown", button: 0 };
    const up = { type: "pointerUp", button: 0 };
    if (action.kind === "tap" || action.kind === "double_tap" || action.kind === "long_press") {
      let point: { x: number; y: number };
      let node: IosNode | undefined;
      if ("elementRef" in action.target) {
        node = this.verifyNode(previous, live, refNode(action.target.elementRef));
        if (node.element.clickable !== true) throw wdaFailure("ELEMENT_CHANGED");
        point = { x: Math.floor(node.element.bounds.x + node.element.bounds.width / 2),
          y: Math.floor(node.element.bounds.y + node.element.bounds.height / 2) };
      } else {
        coordinateMode();
        point = action.target;
        this.point(point, previous);
        const candidates = previous.nodes.filter((item) => item.element.clickable && containsPoint(item.element.bounds, point));
        if (candidates.length > 1) throw wdaFailure("ELEMENT_CHANGED");
        if (candidates[0]) node = this.verifyNode(previous, live, candidates[0]);
        else {
          const bounds = action.target.bounds;
          if (!bounds || !containsPoint(bounds, point)) throw wdaFailure("INVALID_INPUT");
          this.visualGuard(previous, live, bounds);
        }
      }
      this.point(point, live);
      verifyStart(point);
      if (node) await this.resolve(target, node, live.display.scale, signal);
      pointerActions = [move(point), down];
      if (action.kind === "long_press") pointerActions.push({ type: "pause", duration: 1000 });
      pointerActions.push(up);
      if (action.kind === "double_tap") pointerActions.push({ type: "pause", duration: action.delayMs }, down, up);
    } else if (action.kind === "swipe") {
      coordinateMode();
      this.point(action.from, previous);
      this.point(action.to, previous);
      const candidates = action.elementRef ? [refNode(action.elementRef)] :
        previous.nodes.filter((node) => node.element.scrollable && containsPoint(node.element.bounds, action.from));
      if (candidates.length > 1) throw wdaFailure("ELEMENT_CHANGED");
      const surface = candidates[0];
      if (surface || action.elementRef) {
        const node = this.verifyNode(previous, live, surface);
        if (!node.element.scrollable || !containsPoint(node.element.bounds, action.from) ||
          !containsPoint(node.element.bounds, action.to)) throw wdaFailure("ELEMENT_CHANGED");
        verifyStart(action.from, true);
        if (node.name) await this.resolve(target, node, live.display.scale, signal);
        else this.visualGuard(previous, live, node.element.bounds);
      } else {
        if (!action.bounds || !containsPoint(action.bounds, action.from) || !containsPoint(action.bounds, action.to)) {
          throw wdaFailure("INVALID_INPUT");
        }
        this.visualGuard(previous, live, action.bounds);
      }
      pointerActions = [move(action.from), down, move(action.to, action.durationMs), up];
    } else if (action.kind === "type_text") {
      const field = live.nodes.filter((node) => node.element.editable && node.element.focused === true);
      const node = field.length === 1 ? field[0] : undefined;
      const before = node ? previous.nodes.find((item) => nodeSignature(item) === nodeSignature(node)) : undefined;
      if (!node || !before || !live.focus || !previous.focus || live.focus.id !== previous.focus.id) {
        throw wdaFailure("ELEMENT_CHANGED");
      }
      this.verifyNode(previous, live, before);
      await target.wda.assertHittable(target.sessionId, live.focus.id, signal);
      const current = await target.wda.focused(target.sessionId, signal);
      if (!current || current.id !== live.focus.id || !matchesWdaElement(node, current, live.display.scale)) {
        throw wdaFailure("ELEMENT_CHANGED");
      }
      await this.assertContext(target, live, signal);
      await target.wda.command(target.sessionId, "POST", `/element/${current.id}/value`, signal, { text: action.text });
      return;
    } else if (action.kind === "key") {
      if (action.key !== "HOME") throw wdaFailure("UNSUPPORTED_OPERATION");
      await this.assertContext(target, live, signal);
      await target.wda.home(target.sessionId, signal);
      return;
    } else {
      throw wdaFailure("UNSUPPORTED_OPERATION");
    }
    await this.assertContext(target, live, signal);
    await target.wda.command(target.sessionId, "POST", "/actions", signal, {
      actions: [{ type: "pointer", id: "mobile-use-finger", parameters: { pointerType: "touch" }, actions: pointerActions }],
    });
  }

  private async assertContext(target: IosTargetSession, snapshot: Snapshot, signal: AbortSignal) {
    await this.ensure(target, signal);
    await target.wda.assertUnlocked(target.sessionId, signal);
    const app = await target.wda.activeApp(target.sessionId, signal);
    const display = await target.wda.screen(target.sessionId, signal);
    if (app.bundleId !== snapshot.app.bundleId || app.pid !== snapshot.app.pid ||
      JSON.stringify(display) !== JSON.stringify(snapshot.display)) throw wdaFailure("STALE_OBSERVATION");
    checkCancelled(signal);
  }

  act(token: string, observationId: string, input: unknown, request?: AbortSignal): Promise<ActionResult> {
    return this.serializeTarget(token, async (target) => {
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success) throw wdaFailure("INVALID_INPUT");
      const action = parsed.data;
      const previous = target.snapshot;
      target.snapshot = undefined;
      const age = previous ? this.now() - previous.createdAt : -1;
      if (!previous || previous.screen.observation.observationId !== observationId ||
        previous.screen.observation.targetToken !== token || age < 0 || age > OBSERVATION_MAX_AGE_MS) throw wdaFailure("STALE_OBSERVATION");
      if ((action.kind === "key" && action.key !== "HOME") || action.kind === "launch_app") throw wdaFailure("UNSUPPORTED_OPERATION");
      if (action.kind === "type_text" && /[\u0000-\u001f\u007f-\u009f]/.test(action.text)) {
        throw new MobileUseError("TEXT_INPUT_UNSUPPORTED", "iOS text input cannot contain control characters or line breaks.",
          "Use non-sensitive plain text. Submit/Return, deletion and credential input are not supported.");
      }
      const signal = this.signal(target, request);
      const includeScreenshot = previous.screen.observation.screenshot.status !== "skipped";
      const live = await this.capture(target, signal, includeScreenshot);
      if (JSON.stringify(previous.display) !== JSON.stringify(live.display) ||
        previous.app.bundleId !== live.app.bundleId || previous.app.pid !== live.app.pid) throw wdaFailure("STALE_OBSERVATION");
      try {
        await this.dispatch(target, action, previous, live, signal);
      } catch (error) {
        const failure = publicError(error);
        if (invalidatingCodes.has(failure.code)) this.retireTarget(target.token, "lost", true);
        if (!failure.actionMayHaveRun) throw failure;
        return { dispatchStatus: "outcome-unknown", verificationStatus: "unverified", after: null, error: failure.toJSON() };
      }
      try {
        const after = await this.capture(target, signal, includeScreenshot);
        target.snapshot = after;
        return { dispatchStatus: "dispatched", verificationStatus: "requires-observation-review", after: after.screen, error: null };
      } catch (error) {
        const failure = publicError(error);
        if (invalidatingCodes.has(failure.code)) this.retireTarget(target.token, "lost", true);
        return { dispatchStatus: "dispatched", verificationStatus: "unverified", after: null,
          error: { ...failure.toJSON(), retryable: false, actionMayHaveRun: true } };
      }
    }, request);
  }

  getForegroundApp(token: string, request?: AbortSignal): Promise<IosForegroundApp> {
    return this.serializeTarget(token, async (target) => {
      const signal = this.signal(target, request);
      await this.ensure(target, signal);
      const app = await target.wda.activeApp(target.sessionId, signal);
      await this.ensure(target, signal);
      return { platform: "ios", packageName: app.bundleId, pid: app.pid };
    }, request);
  }

  launchApp(token: string, packageName: string, request?: AbortSignal): Promise<IosAppOperationResult> {
    return this.serializeTarget(token, async (target) => {
      if (!iosBundleIdSchema.safeParse(packageName).success) throw wdaFailure("INVALID_INPUT");
      target.snapshot = undefined;
      const signal = this.signal(target, request);
      await this.ensure(target, signal);
      await target.wda.assertUnlocked(target.sessionId, signal);
      await target.wda.command(target.sessionId, "POST", "/wda/apps/launch", signal, { bundleId: packageName });
      try {
        const app = await target.wda.activeApp(target.sessionId, signal);
        await this.ensure(target, signal);
        if (app.bundleId !== packageName) throw wdaFailure("APP_LAUNCH_FAILED", true);
        return { platform: "ios", status: "launched", packageName };
      } catch (error) {
        const failure = publicError(error);
        throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
      }
    }, request);
  }

  private rejectSelected<T>(token: string, signal?: AbortSignal): Promise<T> {
    return this.serializeTarget(token, async () => { throw wdaFailure("UNSUPPORTED_OPERATION"); }, signal);
  }
  startAdbServer(signal?: AbortSignal): Promise<AdbServerResult> {
    return this.serializeHost(async () => { throw wdaFailure("UNSUPPORTED_OPERATION"); }, signal);
  }
  wake(token: string, signal?: AbortSignal): Promise<WakeResult> { return this.rejectSelected(token, signal); }
  prepareGestures(token: string, signal?: AbortSignal): Promise<PreparedGestures> { return this.rejectSelected(token, signal); }
  prepareTextInput(token: string, signal?: AbortSignal): Promise<PreparedTextInput> { return this.rejectSelected(token, signal); }
  listApps(token: string, signal?: AbortSignal): Promise<InstalledApps> { return this.rejectSelected(token, signal); }
  terminateApp(token: string, _app: string, signal?: AbortSignal) { return this.rejectSelected<never>(token, signal); }
  installApp(token: string, _file: string, signal?: AbortSignal) { return this.rejectSelected<never>(token, signal); }
  uninstallApp(token: string, _app: string, signal?: AbortSignal) { return this.rejectSelected<never>(token, signal); }
  screenRecording(token: string, _action: RecordingAction, signal?: AbortSignal): Promise<RecordingResult> {
    return this.rejectSelected(token, signal);
  }

  private async releaseOwnedSessionEntry(owned: OwnedWdaSession): Promise<void> {
    this.ownedSessions.delete(owned.endpointId);
    const probe = await owned.wda.probe();
    if (probe.vendorId !== owned.probe.vendorId || probe.build !== owned.probe.build ||
      probe.sessionId !== owned.sessionId) throw wdaFailure("TRANSPORT_LOST");
    await owned.wda.closeSession(owned.sessionId);
  }

  private async controlRuntime(input: IosRuntimeAction, signal?: AbortSignal): Promise<IosRuntimeStatus> {
    const parsed = iosRuntimeActionSchema.safeParse(input);
    if (!parsed.success || !this.runtime) return Promise.reject(wdaFailure("INVALID_INPUT"));
    checkCancelled(signal);
    const runtime = this.runtime;
    const action = parsed.data;
    if (action.kind === "status") {
      if (this.stopped) throw wdaFailure("SERVER_STOPPED");
      return runtime.control(action, signal);
    }
    const matchingStopTargets = action.kind === "stop"
      ? [...this.targets.values()].filter((session) => session.runtimeToken === action.runtimeToken)
      : [];
    if (action.kind === "stop") {
      runtime.cancelPending(action.runtimeToken);
      for (const session of matchingStopTargets) session.controller.abort();
    }
    return this.serializeHost(async () => {
      if (action.kind === "stop") {
        const stopTargets = new Map<string, IosTargetSession>(
          matchingStopTargets.map((session) => [session.token, session]),
        );
        for (const session of this.targets.values()) {
          if (session.runtimeToken === action.runtimeToken) {
            stopTargets.set(session.token, session);
          }
        }
        for (const session of stopTargets.values()) {
          this.targets.delete(session.token);
          this.retiredTokens.delete(session.token);
          session.snapshot = undefined;
          session.controller.abort();
        }
        for (const session of stopTargets.values()) {
          let settled: Promise<void>;
          do {
            settled = session.queue;
            await settled;
          } while (session.queue !== settled);
          this.retiredTokens.delete(session.token);
        }
        const errors: unknown[] = [];
        for (const owned of [...this.ownedSessions.values()]) {
          if (owned.runtimeToken !== action.runtimeToken) continue;
          try { await this.releaseOwnedSessionEntry(owned); } catch (error) { errors.push(error); }
        }
        let status: IosRuntimeStatus | undefined;
        // Once stop invalidates the target, finish cleanup even if the request is cancelled.
        try { status = await runtime.control(action, undefined, errors.length > 0); } catch (error) { errors.push(error); }
        for (const token of stopTargets.keys()) {
          const session = this.targets.get(token);
          if (session) {
            this.targets.delete(token);
            session.snapshot = undefined;
            session.controller.abort();
          }
          this.retiredTokens.delete(token);
        }
        if (errors.length) throw publicError(errors[errors.length - 1]);
        if (!status) throw wdaFailure("INTERNAL_ERROR");
        return status;
      }
      const status = await runtime.control(action, signal);
      if (action.kind === "start") {
        this.deselectEndpoint(action.endpointId);
      }
      return status;
    }, action.kind === "stop" ? undefined : signal);
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    this.runtime?.cancelPending();
    for (const session of this.targets.values()) {
      session.controller.abort();
      session.snapshot = undefined;
    }
    this.closing ??= (async () => {
      await this.hostQueue;
      for (const session of this.targets.values()) {
        session.controller.abort();
        session.snapshot = undefined;
      }
      await Promise.all([...this.targets.values()].map((session) => session.queue));
      this.targets.clear();
      const errors: unknown[] = [];
      const failedRuntimeTokens = new Set<string>();
      for (const owned of [...this.ownedSessions.values()]) {
        try {
          await this.releaseOwnedSessionEntry(owned);
        } catch (error) {
          errors.push(error);
          if (owned.runtimeToken) failedRuntimeTokens.add(owned.runtimeToken);
        }
      }
      const priorCleanupFailed: boolean | ReadonlySet<string> = failedRuntimeTokens.size > 0 ? failedRuntimeTokens : false;
      try { await this.runtime?.close(priorCleanupFailed); } catch (error) { errors.push(error); }
      this.clients.clear();
      if (errors.length) throw publicError(errors[errors.length - 1]);
    })();
    return this.closing;
  }
}
