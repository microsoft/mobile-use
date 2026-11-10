import { randomUUID } from "node:crypto";
import { decodePng } from "../android.js";
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
import { iosRuntimeActionSchema, type IosRuntime, type IosRuntimeAction, type IosRuntimeStatus } from "./runtime.js";

interface Target {
  token: string;
  sessionId: string;
  probe: WdaProbe;
  controller: AbortController;
  runtimeToken?: string;
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

export class IosMobileUseService implements MobileService {
  readonly platform = "ios";
  private client: WdaClient | undefined;
  private selected: Target | undefined;
  private owned: Target | undefined;
  private snapshot: Snapshot | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private transportLost = false;
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;
  readonly iosRuntime?: (action: IosRuntimeAction, signal?: AbortSignal) => Promise<IosRuntimeStatus>;

  constructor(private readonly configuredUrl: string | undefined,
    private readonly now: () => number = Date.now, private readonly runtime?: IosRuntime) {
    if (runtime) {
      runtime.onLost = () => { this.invalidate(true); this.client = undefined; };
      this.iosRuntime = (action, signal) => this.controlRuntime(action, signal);
    }
  }

  private get wda(): WdaClient {
    const url = this.runtime?.binding().url ?? readWdaUrl(this.configuredUrl);
    if (this.client?.url !== url) this.client = new WdaClient(url);
    return this.client;
  }

  private serialize<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.stopped) throw wdaFailure("SERVER_STOPPED");
      checkCancelled(signal);
      try { return await operation(); }
      catch (error) {
        if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) this.invalidate(true);
        throw error;
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private invalidate(lost = false) {
    this.selected?.controller.abort();
    this.selected = undefined;
    this.snapshot = undefined;
    this.transportLost = lost;
    if (lost) this.owned = undefined;
  }

  private target(token: string): Target {
    if (!this.selected) throw wdaFailure(this.transportLost ? "TRANSPORT_LOST" : "TARGET_NOT_SELECTED");
    if (this.selected.token !== token) throw wdaFailure("STALE_TARGET");
    return this.selected;
  }

  private signal(target: Target, request?: AbortSignal): AbortSignal {
    return AbortSignal.any([target.controller.signal, this.lifetime.signal, ...(request ? [request] : [])]);
  }

  private async ensure(target: Target, signal: AbortSignal) {
    this.target(target.token);
    if (this.runtime) await this.runtime.verify(target.runtimeToken ?? "", signal);
    const probe = await this.wda.probe(signal);
    if (probe.sessionId !== target.sessionId || probe.vendorId !== target.probe.vendorId ||
      probe.build !== target.probe.build || probe.iosVersion !== target.probe.iosVersion) {
      throw wdaFailure("TRANSPORT_LOST");
    }
    this.target(target.token);
    checkCancelled(signal);
  }

  private endpoint(probe: WdaProbe): DeviceEndpoint {
    const conflict = probe.sessionId !== null && probe.sessionId !== this.owned?.sessionId;
    const binding = this.runtime?.binding();
    return {
      platform: "ios", endpointId: binding ? `ios:usb:${binding.udid}` : `ios:${new URL(this.wda.url).host}`,
      transportId: binding?.udid ?? null, kind: binding ? "usb" : "unknown", state: "device", model: probe.model,
      selectable: !conflict,
      reason: conflict ? "A foreign WDA session is active. Use a dedicated Runner; never replace another controller's session."
        : binding ? "Managed WDA bound to the verified USB UDID."
          : "User-managed local WDA forwarding; its physical USB/network transport is not independently verified.",
    };
  }

  doctor(signal?: AbortSignal): Promise<IosDoctor> {
    return this.serialize(async () => {
      if (this.runtime) {
        const goIosVersion = await this.runtime.prerequisites(signal);
        if (this.runtime.status().state !== "ready") {
          return { status: "runtime-not-ready" as const, platform: "ios" as const,
            goIosVersion, runtime: this.runtime.status() };
        }
        await this.runtime.verify(this.runtime.binding().token, signal);
      }
      const probe = await this.wda.probe(signal);
      return { status: "ready" as const, platform: "ios" as const, wdaUrl: this.wda.url,
        iosVersion: probe.iosVersion, model: probe.model,
        ...(this.runtime ? { runtime: this.runtime.status() } : {}) };
    }, signal);
  }

  listDevices(signal?: AbortSignal): Promise<DeviceEndpoint[]> {
    return this.serialize(async () => {
      const devices = this.runtime ? await this.runtime.devices(signal) : undefined;
      if (devices && this.runtime?.status().state !== "ready") return devices;
      const probe = await this.wda.probe(signal);
      if (this.selected && (probe.vendorId !== this.selected.probe.vendorId ||
        probe.build !== this.selected.probe.build || probe.sessionId !== this.selected.sessionId)) {
        this.invalidate(true);
      }
      const endpoint = this.endpoint(probe);
      return devices ? devices.map((entry) => entry.endpointId === endpoint.endpointId ? endpoint : entry) : [endpoint];
    }, signal);
  }

  selectDevice(endpointId: string, request?: AbortSignal): Promise<IosSelectedTarget> {
    return this.serialize(async () => {
      this.invalidate();
      const signal = AbortSignal.any([this.lifetime.signal, ...(request ? [request] : [])]);
      if (this.runtime) await this.runtime.verify(this.runtime.binding().token, signal);
      const probe = await this.wda.probe(signal);
      if (endpointId !== this.endpoint(probe).endpointId) throw wdaFailure("DEVICE_NOT_FOUND");
      if (this.owned) {
        if (probe.sessionId !== this.owned.sessionId || probe.vendorId !== this.owned.probe.vendorId ||
          probe.build !== this.owned.probe.build) throw wdaFailure("TRANSPORT_LOST");
        await this.wda.closeSession(this.owned.sessionId);
        this.owned = undefined;
      } else if (probe.sessionId !== null) {
        throw wdaFailure("WDA_SESSION_CONFLICT");
      }
      checkCancelled(signal);
      const before = await this.wda.probe(signal);
      if (before.sessionId !== null || before.vendorId !== probe.vendorId || before.build !== probe.build) {
        throw wdaFailure("WDA_SESSION_CONFLICT");
      }
      const sessionId = await this.wda.createSession(signal);
      const target: Target = { token: randomUUID(), sessionId, probe: before, controller: new AbortController(),
        ...(this.runtime ? { runtimeToken: this.runtime.binding().token } : {}) };
      this.owned = target;
      checkCancelled(signal);
      this.selected = target;
      await this.ensure(target, signal);
      return {
        targetToken: target.token, endpoint: this.endpoint({ ...before, sessionId }),
        identity: { platform: "ios", vendorId: before.vendorId, iosVersion: before.iosVersion, model: before.model,
          ...(this.runtime ? { udid: this.runtime.binding().udid } : {}) },
        capabilities: { tap: true, swipe: true, text: true, home: true, appLaunch: true, screenshot: true, unsupported },
      };
    }, request);
  }

  private async capture(target: Target, signal: AbortSignal, includeScreenshot: boolean): Promise<Snapshot> {
    await this.ensure(target, signal);
    await this.wda.assertUnlocked(target.sessionId, signal);
    const startedAt = new Date(this.now()).toISOString();
    const start = performance.now();
    const display = await this.wda.screen(target.sessionId, signal);
    const app = await this.wda.activeApp(target.sessionId, signal);
    const hierarchyStart = performance.now();
    const hierarchy = parseIosHierarchy(await this.wda.source(target.sessionId, signal), display.scale, app.bundleId, display);
    const hierarchyDurationMs = Math.round(performance.now() - hierarchyStart);
    const focus = hierarchy.nodes.some((node) => node.element.editable)
      ? await this.wda.focused(target.sessionId, signal) : null;
    const focused = focus ? hierarchy.nodes.filter((node) =>
      node.element.editable && matchesWdaElement(node, focus, display.scale)) : [];
    if (focused.length === 1) {
      for (const node of hierarchy.nodes) if (node.element.editable) node.element.focused = node === focused[0];
    }
    let image: Buffer | null = null;
    let screenshotDurationMs: number | null = null;
    if (includeScreenshot) {
      const screenshotStart = performance.now();
      image = await this.wda.screenshot(target.sessionId, signal);
      const decoded = decodePng(image);
      if (decoded.width !== display.width || decoded.height !== display.height) throw wdaFailure("STALE_OBSERVATION");
      screenshotDurationMs = Math.round(performance.now() - screenshotStart);
    }
    const afterApp = await this.wda.activeApp(target.sessionId, signal);
    const afterDisplay = await this.wda.screen(target.sessionId, signal);
    await this.wda.assertUnlocked(target.sessionId, signal);
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
    return this.serialize(async () => {
      const target = this.target(token);
      this.snapshot = undefined;
      const snapshot = await this.capture(target, this.signal(target, request), includeScreenshot);
      this.snapshot = snapshot;
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

  private async resolve(target: Target, node: IosNode, scale: number, signal: AbortSignal) {
    const matches = (await this.wda.find(target.sessionId, node.element.className, node.name, signal))
      .filter((element) => matchesWdaElement(node, element, scale));
    const element = matches.length === 1 ? matches[0] : undefined;
    if (!element) throw wdaFailure("ELEMENT_CHANGED");
    await this.wda.assertHittable(target.sessionId, element.id, signal);
    return element;
  }

  private async dispatch(target: Target, action: MobileAction, previous: Snapshot, live: Snapshot, signal: AbortSignal) {
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
      await this.wda.assertHittable(target.sessionId, live.focus.id, signal);
      const current = await this.wda.focused(target.sessionId, signal);
      if (!current || current.id !== live.focus.id || !matchesWdaElement(node, current, live.display.scale)) {
        throw wdaFailure("ELEMENT_CHANGED");
      }
      await this.assertContext(target, live, signal);
      await this.wda.command(target.sessionId, "POST", `/element/${current.id}/value`, signal, { text: action.text });
      return;
    } else if (action.kind === "key") {
      if (action.key !== "HOME") throw wdaFailure("UNSUPPORTED_OPERATION");
      await this.assertContext(target, live, signal);
      await this.wda.home(target.sessionId, signal);
      return;
    } else {
      throw wdaFailure("UNSUPPORTED_OPERATION");
    }
    await this.assertContext(target, live, signal);
    await this.wda.command(target.sessionId, "POST", "/actions", signal, {
      actions: [{ type: "pointer", id: "mobile-use-finger", parameters: { pointerType: "touch" }, actions: pointerActions }],
    });
  }

  private async assertContext(target: Target, snapshot: Snapshot, signal: AbortSignal) {
    await this.ensure(target, signal);
    await this.wda.assertUnlocked(target.sessionId, signal);
    const app = await this.wda.activeApp(target.sessionId, signal);
    const display = await this.wda.screen(target.sessionId, signal);
    if (app.bundleId !== snapshot.app.bundleId || app.pid !== snapshot.app.pid ||
      JSON.stringify(display) !== JSON.stringify(snapshot.display)) throw wdaFailure("STALE_OBSERVATION");
    checkCancelled(signal);
  }

  act(token: string, observationId: string, input: unknown, request?: AbortSignal): Promise<ActionResult> {
    return this.serialize(async () => {
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success) throw wdaFailure("INVALID_INPUT");
      const action = parsed.data;
      const target = this.target(token);
      const previous = this.snapshot;
      this.snapshot = undefined;
      const age = previous ? this.now() - previous.createdAt : -1;
      if (!previous || previous.screen.observation.observationId !== observationId ||
        previous.screen.observation.targetToken !== token || age < 0 || age > 30_000) throw wdaFailure("STALE_OBSERVATION");
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
        if (invalidatingCodes.has(failure.code)) this.invalidate(true);
        if (!failure.actionMayHaveRun) throw failure;
        return { dispatchStatus: "outcome-unknown", verificationStatus: "unverified", after: null, error: failure.toJSON() };
      }
      try {
        const after = await this.capture(target, signal, includeScreenshot);
        this.snapshot = after;
        return { dispatchStatus: "dispatched", verificationStatus: "requires-observation-review", after: after.screen, error: null };
      } catch (error) {
        const failure = publicError(error);
        if (invalidatingCodes.has(failure.code)) this.invalidate(true);
        return { dispatchStatus: "dispatched", verificationStatus: "unverified", after: null,
          error: { ...failure.toJSON(), retryable: false, actionMayHaveRun: true } };
      }
    }, request);
  }

  getForegroundApp(token: string, request?: AbortSignal): Promise<IosForegroundApp> {
    return this.serialize(async () => {
      const target = this.target(token);
      const signal = this.signal(target, request);
      await this.ensure(target, signal);
      const app = await this.wda.activeApp(target.sessionId, signal);
      await this.ensure(target, signal);
      return { platform: "ios", packageName: app.bundleId, pid: app.pid };
    }, request);
  }

  launchApp(token: string, packageName: string, request?: AbortSignal): Promise<IosAppOperationResult> {
    return this.serialize(async () => {
      if (!iosBundleIdSchema.safeParse(packageName).success) throw wdaFailure("INVALID_INPUT");
      const target = this.target(token);
      this.snapshot = undefined;
      const signal = this.signal(target, request);
      await this.ensure(target, signal);
      await this.wda.assertUnlocked(target.sessionId, signal);
      await this.wda.command(target.sessionId, "POST", "/wda/apps/launch", signal, { bundleId: packageName });
      try {
        const app = await this.wda.activeApp(target.sessionId, signal);
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
    return this.serialize(async () => { this.target(token); throw wdaFailure("UNSUPPORTED_OPERATION"); }, signal);
  }
  startAdbServer(signal?: AbortSignal): Promise<AdbServerResult> {
    return this.serialize(async () => { throw wdaFailure("UNSUPPORTED_OPERATION"); }, signal);
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

  private async releaseOwnedSession(): Promise<void> {
    const owned = this.owned;
    const client = this.client;
    this.selected = undefined;
    this.owned = undefined;
    if (!owned) return;
    if (!client) throw wdaFailure("TRANSPORT_LOST");
    const probe = await client.probe();
    if (probe.vendorId !== owned.probe.vendorId || probe.build !== owned.probe.build ||
      probe.sessionId !== owned.sessionId) throw wdaFailure("TRANSPORT_LOST");
    await client.closeSession(owned.sessionId);
  }

  private async controlRuntime(input: IosRuntimeAction, signal?: AbortSignal): Promise<IosRuntimeStatus> {
    const parsed = iosRuntimeActionSchema.safeParse(input);
    if (!parsed.success || !this.runtime) return Promise.reject(wdaFailure("INVALID_INPUT"));
    checkCancelled(signal);
    const runtime = this.runtime;
    const action = parsed.data;
    if (action.kind === "status") {
      if (this.stopped) throw wdaFailure("SERVER_STOPPED");
      return runtime.status();
    }
    if (action.kind === "stop") {
      runtime.cancelPending(action.runtimeToken);
      this.selected?.controller.abort();
    }
    return this.serialize(async () => {
      if (action.kind === "stop") {
        const errors: unknown[] = [];
        try { await this.releaseOwnedSession(); } catch (error) { errors.push(error); }
        let status: IosRuntimeStatus | undefined;
        // Once stop invalidates the target, finish cleanup even if the request is cancelled.
        try { status = await runtime.control(action, undefined, errors.length > 0); } catch (error) { errors.push(error); }
        this.invalidate();
        this.client = undefined;
        if (errors.length) throw publicError(errors[errors.length - 1]);
        if (!status) throw wdaFailure("INTERNAL_ERROR");
        return status;
      }
      const status = await runtime.control(action, signal);
      if (action.kind === "start") { this.invalidate(); this.client = undefined; }
      return status;
    }, action.kind === "stop" ? undefined : signal);
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    this.runtime?.cancelPending();
    this.selected?.controller.abort();
    this.snapshot = undefined;
    this.closing ??= (async () => {
      await this.queue;
      const errors: unknown[] = [];
      try { await this.releaseOwnedSession(); } catch (error) { errors.push(error); }
      try { await this.runtime?.close(errors.length > 0); } catch (error) { errors.push(error); }
      if (errors.length) throw publicError(errors[errors.length - 1]);
    })();
    return this.closing;
  }
}
