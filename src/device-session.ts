import { randomUUID } from "node:crypto";
import { parseAdbVersion, parseDeviceList, startTransportMonitor } from "./adb.js";
import type { AdbConnection, MonitorFactory, TransportMonitor } from "./adb.js";
import { AndroidBackend, deviceReadinessError, isPointerButton, validateText } from "./android.js";
import type { Hierarchy, Screenshot } from "./android.js";
import { checkCancelled, MobileUseError, publicError } from "./errors.js";
import type { AndroidDoctor, MobileService } from "./mobile-service.js";
import { compareScreens, containsPoint, interactionRegion, intersects } from "./screen-guard.js";
import { actionSchema, recordingActionSchema } from "./types.js";
import { isAdbText } from "./text-input.js";
import type {
  ActionResult, AdbServerResult, AppOperationResult, DeviceEndpoint, DeviceIdentity, DeviceStatus, ForegroundApp, InstalledApps, MobileAction, Observation,
  ObservedScreen, PreparedGestures, PreparedTextInput, ReadStatus, RecordingAction, RecordingResult, Rect, ScreenElement, ScreenWindow, SelectedTarget, WakeResult,
} from "./types.js";

const OBSERVATION_MAX_AGE_MS = 30_000;
const invalidatingCodes = new Set([
  "DEVICE_UNAUTHORIZED", "DEVICE_OFFLINE", "TRANSPORT_LOST", "ADB_SERVER_UNAVAILABLE",
  "ADB_SERVER_CONFLICT", "ADB_SERVER_START_FAILED",
]);

interface TargetState {
  token: string;
  endpoint: DeviceEndpoint;
  identity: DeviceIdentity | null;
  backend: AndroidBackend;
  controller: AbortController;
  monitor: TransportMonitor;
}

interface Snapshot {
  screen: ObservedScreen;
  createdAt: number;
  foregroundApp: ForegroundApp | null;
}

function sameEndpoint(inventory: DeviceEndpoint[], expected: DeviceEndpoint): boolean {
  return inventory.some((endpoint) =>
    endpoint.endpointId === expected.endpointId &&
    endpoint.transportId === expected.transportId &&
    endpoint.state === "device",
  );
}

function elementSignature(element: ScreenElement): string {
  const { ref: _ref, windowId: _windowId, ...properties } = element;
  return JSON.stringify(properties);
}

function windowSignature(window: ScreenWindow): string {
  const { id: _id, ...properties } = window;
  return JSON.stringify(properties);
}

function observedElementSignature(element: ScreenElement, observation: Observation): string {
  const owner = observation.windows.find((window) => window.id === element.windowId);
  if (element.windowId !== undefined && !owner) {
    throw new MobileUseError("ELEMENT_CHANGED", "An observed element's owning window could not be verified.", "Observe again and identify the intended control or surface in its owning window.");
  }
  return JSON.stringify([elementSignature(element), owner ? windowSignature(owner) : null]);
}

function requirePoint(point: { x: number; y: number }, display: Observation["display"]): void {
  if (!display || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
    point.x < 0 || point.y < 0 || point.x >= display.width || point.y >= display.height) {
    throw new MobileUseError("INVALID_INPUT", "The point is outside the observed primary display.", "Observe again and use in-bounds coordinates.");
  }
}

function readFailure(error: unknown): { status: "unavailable"; error: NonNullable<ReadStatus["error"]> } {
  const failure = publicError(error);
  if (invalidatingCodes.has(failure.code) || ["CANCELLED", "ADB_NOT_FOUND", "ADB_CONFIG_UNSUPPORTED", "INTERNAL_ERROR", "SERVER_STOPPED"].includes(failure.code)) {
    throw failure;
  }
  return { status: "unavailable", error: failure.toJSON() };
}

export class MobileUseService implements MobileService {
  readonly platform = "android";
  private selected: TargetState | undefined;
  private snapshot: Snapshot | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private transportLost = false;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly adb: AdbConnection,
    private readonly monitorFactory: MonitorFactory = startTransportMonitor,
    private readonly now: () => number = Date.now,
  ) {}

  private serialize<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.stopped) throw new MobileUseError("SERVER_STOPPED", "The server is stopped.", "Start a new plugin session.");
      checkCancelled(signal);
      try {
        return await operation();
      } catch (error) {
        if (error instanceof MobileUseError && invalidatingCodes.has(error.code)) this.invalidate(true);
        throw error;
      }
    });
    // Keep the queue usable after failure; the original promise still rejects to its caller.
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private invalidate(lost = false): void {
    const previous = this.selected;
    this.selected = undefined;
    this.snapshot = undefined;
    this.transportLost = lost;
    previous?.monitor.close();
    previous?.controller.abort();
  }

  private target(token: string): TargetState {
    if (!this.selected) {
      throw this.transportLost
        ? new MobileUseError("TRANSPORT_LOST", "The selected transport was lost.", "Rediscover and explicitly reselect; no fallback was attempted.")
        : new MobileUseError("TARGET_NOT_SELECTED", "No device is selected.", "List devices and select the endpoint the user explicitly requested.");
    }
    if (this.selected.token !== token) {
      throw new MobileUseError("STALE_TARGET", "This target token is not current.", "Use the token from explicit device selection.");
    }
    return this.selected;
  }

  private async inventory(signal?: AbortSignal): Promise<DeviceEndpoint[]> {
    return parseDeviceList((await this.adb.run(["devices", "-l"], signal ? { signal } : {})).toString("utf8"));
  }

  private async ensureEndpoint(state: TargetState, signal?: AbortSignal): Promise<void> {
    this.target(state.token);
    if (!sameEndpoint(await this.inventory(signal), state.endpoint)) {
      this.invalidate(true);
      throw new MobileUseError("TRANSPORT_LOST", "The exact selected transport is no longer online.", "Rediscover and explicitly reselect.");
    }
    this.target(state.token);
  }

  private async ensureIdentity(state: TargetState, signal?: AbortSignal): Promise<void> {
    await this.ensureEndpoint(state, signal);
    const identity = await state.backend.identity(signal);
    if (state.identity?.hardwareSerial && state.identity.hardwareSerial !== identity.hardwareSerial) {
      this.invalidate(true);
      throw new MobileUseError("TRANSPORT_LOST", "The selected transport's physical identity changed.", "Rediscover and explicitly reselect.");
    }
  }

  doctor(signal?: AbortSignal, targetToken?: string): Promise<AndroidDoctor> {
    return this.serialize(async () => {
      const adbExecutable = this.adb.executable();
      const output = (await this.adb.run(["version"], signal ? { signal } : {})).toString("utf8");
      const { platformToolsVersion } = parseAdbVersion(output);
      if (targetToken !== undefined) {
        const state = this.target(targetToken);
        await this.ensureIdentity(state, signal);
        const deviceStatus = await this.readDeviceStatus(state, signal);
        return { status: "ready", platform: this.platform, adbExecutable, platformToolsVersion, deviceStatus };
      }
      return { status: "ready", platform: this.platform, adbExecutable, platformToolsVersion };
    }, signal);
  }

  startAdbServer(signal?: AbortSignal): Promise<AdbServerResult> {
    return this.serialize(async () => {
      let result: AdbServerResult;
      try {
        result = await this.adb.startServer(signal);
      } catch (error) {
        if (publicError(error).actionMayHaveRun) this.invalidate(true);
        throw error;
      }
      if (result.startupAttempted || (this.selected && !sameEndpoint(result.devices, this.selected.endpoint))) {
        this.invalidate(true);
      }
      return result;
    }, signal);
  }

  listDevices(signal?: AbortSignal): Promise<DeviceEndpoint[]> {
    return this.serialize(async () => {
      const inventory = await this.inventory(signal);
      if (this.selected && !sameEndpoint(inventory, this.selected.endpoint)) this.invalidate(true);
      return inventory;
    }, signal);
  }

  selectDevice(endpointId: string, signal?: AbortSignal): Promise<SelectedTarget> {
    return this.serialize(async () => {
      this.invalidate();
      const endpoint = (await this.inventory(signal)).find((entry) => entry.endpointId === endpointId);
      if (!endpoint) throw new MobileUseError("DEVICE_NOT_FOUND", "That endpoint is not in the current inventory.", "Refresh and explicitly choose an available endpoint.");
      if (!endpoint.selectable) {
        const code = endpoint.state === "unauthorized" ? "DEVICE_UNAUTHORIZED"
          : endpoint.state === "offline" ? "DEVICE_OFFLINE" : "DEVICE_UNSUPPORTED";
        throw new MobileUseError(code, "This endpoint cannot be selected.", endpoint.reason ?? "Choose a supported authorized physical device.");
      }
      const controller = new AbortController();
      const monitorSignal = AbortSignal.any([controller.signal, this.lifetime.signal]);
      const token = randomUUID();
      let lost = false;
      let monitor: TransportMonitor | undefined;
      const cancelled = (): void => controller.abort();
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        monitor = await this.monitorFactory((inventory) => {
          if (!sameEndpoint(inventory, endpoint)) {
            lost = true;
            if (this.selected?.token === token) this.invalidate(true);
          }
        }, () => {
          lost = true;
          if (this.selected?.token === token) this.invalidate(true);
        }, monitorSignal);
        if (lost || !sameEndpoint(monitor.initial, endpoint)) {
          throw new MobileUseError("TRANSPORT_LOST", "The selected transport changed during selection.", "Refresh and reselect.");
        }
        const backend = new AndroidBackend(this.adb, endpoint, monitorSignal, () => {
          if (this.stopped || lost || this.selected?.token !== token || monitorSignal.aborted) {
            throw new MobileUseError("TRANSPORT_LOST", "This selected transport is no longer current.", "Rediscover and reselect.");
          }
        });
        const state: TargetState = { token, endpoint, identity: null, backend, controller, monitor };
        this.selected = state;
        state.identity = await backend.identity(signal);
        checkCancelled(signal);
        this.target(token);
        if (lost) throw new MobileUseError("TRANSPORT_LOST", "The selected transport was interrupted.", "Rediscover and reselect.");
        return {
          targetToken: token,
          endpoint: {
            ...endpoint,
            kind: state.identity.wirelessEvidence === "not-applicable" ? "usb" : "paired-wireless",
            reason: null,
          },
          identity: state.identity,
        };
      } catch (error) {
        monitor?.close();
        controller.abort();
        this.invalidate(lost);
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancelled);
      }
    }, signal);
  }

  private async readDeviceStatus(state: TargetState, signal?: AbortSignal): Promise<DeviceStatus> {
    try {
      return await state.backend.deviceStatus(signal);
    } catch (error) {
      this.target(state.token);
      checkCancelled(signal);
      return {
        ...readFailure(error), screenState: "unknown", lockState: "unknown",
        secure: null, userId: null, readyForInteraction: false,
      };
    }
  }

  private async capture(state: TargetState, signal?: AbortSignal, includeScreenshot = true): Promise<Snapshot> {
    const startedAt = new Date(this.now()).toISOString();
    const started = performance.now();
    let screenshotDurationMs: number | null = null;
    let hierarchyDurationMs = 0;
    const blocked = (deviceStatus: DeviceStatus, error: MobileUseError): Snapshot => {
      const now = this.now();
      const unavailable: ReadStatus = { status: "unavailable", error: error.toJSON() };
      return {
        createdAt: now, foregroundApp: null,
        screen: {
          image: null,
          observation: {
            observationId: randomUUID(), targetToken: state.token, capturedAt: new Date(now).toISOString(),
            captureTiming: {
              startedAt, durationMs: Math.round(performance.now() - started),
              screenshotDurationMs, hierarchyDurationMs,
            },
            nonAtomic: true, deviceStatus, display: null, displayState: unavailable,
            screenshot: screenshotDurationMs === null ? { status: "skipped", error: null } : unavailable,
            hierarchy: unavailable,
            hierarchyScope: "unavailable", windows: [], elements: [],
            warnings: [`Screen content withheld: ${error.message} ${error.remediation}`],
          },
        },
      };
    };
    const initialStatus = await this.readDeviceStatus(state, signal);
    const initialError = deviceReadinessError(initialStatus);
    if (initialError) return blocked(initialStatus, initialError);
    const timed = async <T>(operation: () => Promise<T>, finish: (durationMs: number) => void): Promise<T> => {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        finish(Math.round(performance.now() - start));
      }
    };
    const results = await Promise.allSettled([
      includeScreenshot
        ? timed(() => state.backend.screenshot(signal), (ms) => { screenshotDurationMs = ms; })
        : Promise.resolve(null),
      timed(() => state.backend.hierarchy(signal), (ms) => { hierarchyDurationMs = ms; }),
      state.backend.displayState(signal),
      state.backend.getForegroundApp(signal),
    ]);
    const [imageResult, hierarchyResult, displayResult, foregroundResult] = results;
    const screenshotStatus: Observation["screenshot"] = !includeScreenshot
      ? { status: "skipped", error: null }
      : imageResult.status === "fulfilled"
        ? { status: "ok", error: null } : readFailure(imageResult.reason);
    const hierarchyStatus: ReadStatus = hierarchyResult.status === "fulfilled"
      ? { status: "ok", error: null } : readFailure(hierarchyResult.reason);
    const displayStatus: ReadStatus = displayResult.status === "fulfilled"
      ? { status: "ok", error: null } : readFailure(displayResult.reason);
    const foregroundStatus: ReadStatus = foregroundResult.status === "fulfilled"
      ? { status: "ok", error: null } : readFailure(foregroundResult.reason);
    const deviceStatus = await this.readDeviceStatus(state, signal);
    const readinessError = deviceReadinessError(deviceStatus);
    if (readinessError) return blocked(deviceStatus, readinessError);
    if (initialStatus.userId !== deviceStatus.userId) {
      throw new MobileUseError("STALE_OBSERVATION", "The Android user changed during observation.", "Observe the intended user's approved non-sensitive screen again.");
    }
    const foregroundApp = foregroundResult.status === "fulfilled" ? foregroundResult.value : null;
    const screenshot: Screenshot | null = imageResult.status === "fulfilled" ? imageResult.value : null;
    const hierarchy: Hierarchy | null = hierarchyResult.status === "fulfilled" ? hierarchyResult.value : null;
    const verifiedDisplay = displayResult.status === "fulfilled" ? displayResult.value : null;
    this.target(state.token);
    checkCancelled(signal);
    if (!screenshot && !hierarchy) {
      throw new MobileUseError(
        "OBSERVATION_UNAVAILABLE",
        includeScreenshot
          ? `Neither image nor UI hierarchy is usable (${screenshotStatus.error?.code}, ${hierarchyStatus.error?.code}).`
          : `Screenshot capture was skipped and no UI hierarchy is usable (${hierarchyStatus.error?.code}).`,
        `Stop input. ${hierarchyStatus.error?.message ?? "The user should expose an unlocked, observable safe screen; do not bypass protection."}`,
      );
    }
    if (verifiedDisplay && ((screenshot &&
      (screenshot.width !== verifiedDisplay.width || screenshot.height !== verifiedDisplay.height)) ||
      (hierarchy && hierarchy.rotation !== null && hierarchy.rotation !== verifiedDisplay.rotation))) {
      throw new MobileUseError("STALE_OBSERVATION", "Display geometry changed or is inconsistent during observation.", "Observe again on the primary display.", true);
    }
    const dimensions = screenshot ? { width: screenshot.width, height: screenshot.height } : verifiedDisplay;
    const display = dimensions ? { width: dimensions.width, height: dimensions.height, rotation: verifiedDisplay?.rotation ?? null } : null;
    const warnings: string[] = [];
    if (!foregroundApp) {
      warnings.push(`Foreground activity is unavailable (${foregroundStatus.error?.code ?? "no resumed activity"}); pointer gestures, Unicode and windowed element/text input are blocked.`);
    }
    if (!includeScreenshot) warnings.push("Screenshot capture skipped by request; no screenshot-coordinate actions are permitted.");
    else if (!screenshot) warnings.push("Image unavailable; no screenshot-coordinate actions are permitted.");
    if (!hierarchy) warnings.push("Hierarchy unavailable; no semantic element or focused-field claims can be made.");
    if (hierarchy?.scope === "active-window") warnings.push("Only the active window was exposed; floating-window controls may be unavailable.");
    if (hierarchy?.windows.some((window) => window.hierarchy === "unavailable")) {
      warnings.push("Some interactive windows have no accessible root; their controls are unavailable.");
    }
    if (hierarchy && !hierarchy.elements.length) warnings.push("No semantic elements were exposed; content may be custom-drawn or unavailable.");
    if (!verifiedDisplay) warnings.push("Primary display state could not be verified; input is blocked until a fresh observation verifies it.");
    if (!display) warnings.push("Display geometry is unavailable; coordinate-based input is blocked.");
    const visible = (hierarchy?.elements ?? []).filter((element) => {
      const b = element.bounds;
      return b.x >= 0 && b.y >= 0 && (!display || b.x + b.width <= display.width && b.y + b.height <= display.height);
    });
    if (visible.length !== (hierarchy?.elements.length ?? 0)) warnings.push("Off-screen elements were omitted.");
    const now = this.now();
    const observation: Observation = {
      observationId: randomUUID(),
      targetToken: state.token,
      capturedAt: new Date(now).toISOString(),
      captureTiming: { startedAt, durationMs: Math.round(performance.now() - started), screenshotDurationMs, hierarchyDurationMs },
      nonAtomic: true,
      deviceStatus,
      display,
      displayState: displayStatus,
      screenshot: screenshotStatus,
      hierarchy: hierarchyStatus,
      hierarchyScope: hierarchy?.scope ?? "unavailable",
      windows: hierarchy?.windows ?? [],
      elements: visible.map((element, index) => ({
        ...element, ...(isPointerButton(element) && element.clickable !== true ? { pointerTarget: true as const } : {}),
        ref: `e${index + 1}`,
      })),
      warnings,
    };
    const image = screenshot?.image ?? null;
    return {
      screen: { observation, image },
      createdAt: now,
      foregroundApp,
    };
  }

  observe(targetToken: string, signal?: AbortSignal, includeScreenshot = true): Promise<ObservedScreen> {
    return this.serialize(async () => {
      const state = this.target(targetToken);
      this.snapshot = undefined;
      await this.ensureEndpoint(state, signal);
      const snapshot = await this.capture(state, signal, includeScreenshot);
      this.snapshot = snapshot;
      return snapshot.screen;
    }, signal);
  }

  wake(targetToken: string, signal?: AbortSignal): Promise<WakeResult> {
    return this.serialize(async () => {
      const state = this.target(targetToken);
      this.snapshot = undefined;
      await this.ensureIdentity(state, signal);
      const result = await state.backend.wake(signal);
      try {
        await this.ensureEndpoint(state, signal);
      } catch (error) {
        const failure = publicError(error);
        throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
      }
      return result;
    }, signal);
  }

  private appOperation<T>(
    targetToken: string,
    mutating: boolean,
    operation: (backend: AndroidBackend) => Promise<T>,
    signal?: AbortSignal,
    requireIdentity = true,
  ): Promise<T> {
    return this.serialize(async () => {
      const state = this.target(targetToken);
      if (mutating) this.snapshot = undefined;
      if (requireIdentity) await this.ensureIdentity(state, signal);
      else await this.ensureEndpoint(state, signal);
      let completed = false;
      try {
        const value = await operation(state.backend);
        completed = true;
        await this.ensureEndpoint(state, signal);
        checkCancelled(signal);
        return value;
      } catch (error) {
        const failure = publicError(error);
        if (mutating && (completed || failure.actionMayHaveRun || !(error instanceof MobileUseError))) {
          throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
        }
        throw failure;
      }
    }, signal);
  }

  listApps(targetToken: string, signal?: AbortSignal): Promise<InstalledApps> {
    return this.appOperation(targetToken, false, (backend) => backend.listApps(signal), signal);
  }

  getForegroundApp(targetToken: string, signal?: AbortSignal): Promise<ForegroundApp | null> {
    return this.appOperation(targetToken, false, (backend) => backend.getForegroundApp(signal), signal);
  }

  launchApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult> {
    return this.appOperation(targetToken, true, async (backend) => {
      const userId = await backend.launchApp(packageName, signal);
      try {
        const foreground = await backend.getForegroundApp(signal);
        if (foreground?.packageName !== packageName || foreground.userId !== userId) {
          throw new MobileUseError("APP_LAUNCH_FAILED", "The requested app was not confirmed in the foreground.", "Check the phone before considering another launch.");
        }
        return { status: "launched", packageName, userId };
      } catch (error) {
        const failure = publicError(error);
        throw new MobileUseError(failure.code, failure.message, failure.remediation, false, true);
      }
    }, signal);
  }

  terminateApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult> {
    return this.appOperation(targetToken, true, (backend) => backend.terminateApp(packageName, signal), signal);
  }

  installApp(targetToken: string, filePath: string, signal?: AbortSignal): Promise<AppOperationResult> {
    return this.appOperation(targetToken, true, (backend) => backend.installApp(filePath, signal), signal);
  }

  uninstallApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult> {
    return this.appOperation(targetToken, true, (backend) => backend.uninstallApp(packageName, signal), signal);
  }

  screenRecording(targetToken: string, action: RecordingAction, signal?: AbortSignal): Promise<RecordingResult> {
    const parsed = recordingActionSchema.safeParse(action);
    if (!parsed.success) {
      return Promise.reject(new MobileUseError("INVALID_INPUT", "The screen recording action is invalid.", "Use capabilities to inspect native limits, start with a local .mp4 path and an optional positive integer timeLimitSeconds (omit for unlimited where supported), status, or stop with the recording ID."));
    }
    const recovery = parsed.data.kind === "stop" || parsed.data.kind === "status";
    return this.appOperation(targetToken, action.kind === "start" || action.kind === "stop",
      (backend) => backend.screenRecording(parsed.data, signal), signal, !recovery);
  }

  prepareGestures(targetToken: string, signal?: AbortSignal): Promise<PreparedGestures> {
    return this.appOperation(targetToken, true, (backend) => backend.prepareGestures(signal), signal);
  }

  prepareTextInput(targetToken: string, signal?: AbortSignal): Promise<PreparedTextInput> {
    return this.appOperation(targetToken, true, (backend) => backend.prepareTextInput(signal), signal);
  }

  private async dispatch(state: TargetState, action: MobileAction, previous: Snapshot, live: Snapshot, signal?: AbortSignal): Promise<number | undefined> {
    const observedStatus = previous.screen.observation.deviceStatus;
    if (observedStatus?.status !== "ok") {
      throw (observedStatus && deviceReadinessError(observedStatus)) ?? new MobileUseError(
        "DEVICE_NOT_READY", "The original observation did not establish the Android user.",
        "Inspect a fresh observation with verified device readiness before input.",
      );
    }
    const expectedUserId = observedStatus.userId;
    await state.backend.requireInteractive(signal, expectedUserId);
    const old = previous.screen.observation;
    const current = live.screen.observation;
    if (old.displayState.status !== "ok" || current.displayState.status !== "ok" ||
      !old.display || !current.display || old.display.rotation === null || current.display.rotation === null) {
      throw new MobileUseError("DISPLAY_STATE_UNAVAILABLE", "Primary display state was unavailable in the observation or before dispatch.", "Inspect a fresh observation with verified display state before input.");
    }
    if (old.display.width !== current.display.width || old.display.height !== current.display.height ||
      old.display.rotation !== current.display.rotation) {
      throw new MobileUseError("STALE_OBSERVATION", "Display geometry or rotation changed.", "Inspect a new observation before input.");
    }
    const display = current.display;
    const sameObservedElement = (before: ScreenElement, after: ScreenElement, afterObservation = current): boolean =>
      observedElementSignature(before, old) === observedElementSignature(after, afterObservation);
    const verifyWindowContext = (before: ScreenElement, after: ScreenElement): ScreenWindow | undefined => {
      if (before.windowId === undefined && after.windowId === undefined) return undefined;
      const oldWindow = old.windows.find((window) => window.id === before.windowId);
      const newWindow = current.windows.find((window) => window.id === after.windowId);
      const app = previous.foregroundApp;
      const liveApp = live.foregroundApp;
      if (!oldWindow || !newWindow || windowSignature(oldWindow) !== windowSignature(newWindow) ||
        old.windows.filter((window) => windowSignature(window) === windowSignature(oldWindow)).length !== 1 ||
        current.windows.filter((window) => windowSignature(window) === windowSignature(newWindow)).length !== 1 ||
        !app || !liveApp || app.packageName !== liveApp.packageName ||
        app.activityName !== liveApp.activityName || app.userId !== liveApp.userId) {
        throw new MobileUseError("ELEMENT_CHANGED", "The observed element's window or app context changed before input.", "Observe again and select one unchanged control in its owning window.");
      }
      return newWindow;
    };
    const requireAppContext = (): void => {
      const before = previous.foregroundApp;
      const after = live.foregroundApp;
      if (!before || !after || before.packageName !== after.packageName ||
        before.activityName !== after.activityName || before.userId !== after.userId) {
        throw new MobileUseError("STALE_OBSERVATION", "The foreground app, activity, or Android user is unavailable or changed before pointer input.", "Observe again with a verifiable matching foreground activity. Identical pixels cannot override missing or changed app context.");
      }
    };
    const requireCoordinateCapture = (from: { x: number; y: number }, to = from): void => {
      requirePoint(from, display);
      requirePoint(to, display);
      if (old.screenshot.status === "skipped") {
        throw new MobileUseError(
          "CAPTURE_UNAVAILABLE",
          "Screenshot capture was disabled for this observation; coordinate actions are not permitted.",
          "Use a fresh hierarchy observation and an enabled clickable elementRef.",
        );
      }
      if (!previous.screen.image || !live.screen.image) {
        throw new MobileUseError("CAPTURE_UNAVAILABLE", "A usable screenshot is required before coordinate input.", "Observe again or use an enabled clickable elementRef.");
      }
    };
    const pointerCandidate = (element: ScreenElement): boolean => element.clickable === true ||
      ["android.widget.Button", "android.widget.ImageButton"].includes(element.className);
    const identifiesControl = (element: ScreenElement): boolean => !!element.text || !!element.label || element.editable ||
      ["android.widget.Button", "android.widget.ImageButton"].includes(element.className);
    const pointRegion = (from: { x: number; y: number }, to = from): Rect => ({
      x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
      width: Math.abs(to.x - from.x) + 1, height: Math.abs(to.y - from.y) + 1,
    });
    const verifyTarget = (before: ScreenElement | undefined, region: Rect, swipeFrom?: { x: number; y: number }): ScreenElement => {
      const matches = before ? current.elements.filter((element) => sameObservedElement(before, element)) : [];
      const element = matches.length === 1 ? matches[0] : undefined;
      if (!before || !element || old.elements.filter((candidate) => sameObservedElement(before, candidate, old)).length !== 1 ||
        element.enabled !== true || (swipeFrom ? element.scrollable !== true : element.clickable !== true && !isPointerButton(element))) {
        throw new MobileUseError("ELEMENT_CHANGED", "The actionable target is missing, changed, disabled, ambiguous, or ineligible for this gesture.", "Observe again and select one unchanged enabled control or scrollable surface. Pixel similarity cannot override failed target metadata.");
      }
      const window = verifyWindowContext(before, element);
      requireAppContext();
      if (window) {
        if (region.x < window.bounds.x || region.y < window.bounds.y ||
          region.x + region.width > window.bounds.x + window.bounds.width ||
          region.y + region.height > window.bounds.y + window.bounds.height ||
          [old, current].some((observation) => observation.windows.some((candidate) =>
            windowSignature(candidate) !== windowSignature(window) && candidate.layer >= window.layer && intersects(candidate.bounds, region)))) {
          throw new MobileUseError("ELEMENT_CHANGED", "Another interactive window may cover the target or gesture path.", "Observe again and use an uncovered target in its matching window.");
        }
      }
      const start = swipeFrom ? pointRegion(swipeFrom) : region;
      const signatures = (observation: Observation): string => JSON.stringify(observation.elements
        .filter((candidate) => (pointerCandidate(candidate) || (swipeFrom !== undefined && candidate.scrollable === true)) &&
          intersects(candidate.bounds, start))
        .map((candidate) => observedElementSignature(candidate, observation)).sort());
      if (signatures(old) !== signatures(current)) {
        throw new MobileUseError("ELEMENT_CHANGED", "Controls or scrollable surfaces overlapping the gesture's start point changed before input.", "Observe again and identify the intended uncovered control or surface.");
      }
      return element;
    };
    const visualRegion = (bounds: Rect, from: { x: number; y: number }, to = from): Rect => {
      const region = interactionRegion(display, bounds);
      if (!containsPoint(bounds, from) || !containsPoint(bounds, to)) {
        throw new MobileUseError("INVALID_INPUT", "The requested gesture is outside its visual target bounds.", "Supply complete control or swipe surface bounds containing all requested points.");
      }
      return region;
    };
    const visualFallback = (bounds: Rect | undefined, from: { x: number; y: number }, to = from): void => {
      requireAppContext();
      if (!bounds) {
        throw new MobileUseError("INVALID_INPUT", "No unique actionable metadata target was identified; visual fallback requires explicit bounds.", "Observe again and provide the complete visible control or swipe surface bounds, not just a point. Prefer an actionable elementRef.");
      }
      const region = visualRegion(bounds, from, to);
      const before = previous.screen.image;
      const after = live.screen.image;
      if (!before || !after) {
        throw new MobileUseError("CAPTURE_UNAVAILABLE", "Visual fallback requires two usable screenshots.", "Observe again or use an eligible elementRef.");
      }
      const difference = compareScreens(before, after, region);
      const reject = (message: string): never => {
        throw new MobileUseError("STALE_OBSERVATION", message, "Observe again and verify the whole target and surrounding margin. No input was sent.", false, false, {
          ...difference, protectedRegion: region,
          previousCapture: old.captureTiming, currentCapture: current.captureTiming,
        });
      };
      if (old.hierarchy.status !== current.hierarchy.status || old.hierarchyScope !== current.hierarchyScope) {
        reject("Hierarchy availability or coverage changed before visual input.");
      }
      if (old.hierarchy.status === "ok" && current.hierarchy.status === "ok") {
        const signatures = (observation: Observation): string => JSON.stringify(observation.elements
          .filter((element) => intersects(element.bounds, region))
          .map((element) => observedElementSignature(element, observation)).sort());
        if (signatures(old) !== signatures(current)) {
          reject("UI elements in the visual target's protected region changed before input.");
        }
        const windowSignatures = (observation: Observation): string => JSON.stringify(observation.windows
          .filter((window) => intersects(window.bounds, region))
          .map(windowSignature).sort());
        if (windowSignatures(old) !== windowSignatures(current)) {
          reject("Interactive windows in the visual target's protected region changed before input.");
        }
      }
      if (difference.regionChangedPixels) {
        reject("Pixels in the visual target's protected region changed before input.");
      }
    };
    switch (action.kind) {
      case "tap":
      case "long_press":
      case "double_tap": {
        let point: { x: number; y: number };
        if ("elementRef" in action.target) {
          const ref = action.target.elementRef;
          const oldElement = old.elements.find((element) => element.ref === ref);
          if (!oldElement) {
            throw new MobileUseError("ELEMENT_CHANGED", "The referenced control was not exposed in the observation.", "Observe again and select an enabled actionable element.");
          }
          point = {
            x: Math.floor(oldElement.bounds.x + oldElement.bounds.width / 2),
            y: Math.floor(oldElement.bounds.y + oldElement.bounds.height / 2),
          };
          verifyTarget(oldElement, pointRegion(point));
        } else {
          const target = action.target;
          requireCoordinateCapture(target);
          if (target.bounds) visualRegion(target.bounds, target);
          const candidates = old.elements.filter((element) => pointerCandidate(element) && containsPoint(element.bounds, target));
          if (candidates.length > 1) {
            throw new MobileUseError("ELEMENT_CHANGED", "Multiple potential controls overlap the requested point.", "Observe again and select an explicit actionable elementRef. Visual bounds cannot resolve ambiguous metadata.");
          }
          const candidate = candidates[0];
          if (candidate && (candidate.enabled !== true || identifiesControl(candidate))) verifyTarget(candidate, pointRegion(target));
          else visualFallback(target.bounds, target);
          point = target;
        }
        requirePoint(point, current.display);
        if (action.kind === "double_tap") return state.backend.doubleTap(point.x, point.y, action.delayMs, signal, expectedUserId);
        else if (action.kind === "long_press") await state.backend.longPress(point.x, point.y, signal);
        else await state.backend.tap(point.x, point.y, signal);
        break;
      }
      case "swipe": {
        requireCoordinateCapture(action.from, action.to);
        if (action.bounds) visualRegion(action.bounds, action.from, action.to);
        const candidates = action.elementRef
          ? old.elements.filter((element) => element.ref === action.elementRef)
          : old.elements.filter((element) => element.scrollable === true &&
            containsPoint(element.bounds, action.from));
        if (candidates.length > 1) {
          throw new MobileUseError("ELEMENT_CHANGED", "Multiple scrollable surfaces contain the requested swipe.", "Observe again and specify the intended scrollable elementRef.");
        }
        const surface = candidates[0];
        if (surface || action.elementRef) {
          const element = verifyTarget(surface, pointRegion(action.from, action.to), action.from);
          if (!containsPoint(element.bounds, action.from) || !containsPoint(element.bounds, action.to)) {
            throw new MobileUseError("INVALID_INPUT", "The swipe must remain within its observed scrollable surface.", "Choose in-bounds endpoints within the same surface.");
          }
        } else visualFallback(action.bounds, action.from, action.to);
        await state.backend.swipe(action.from, action.to, action.durationMs, signal);
        break;
      }
      case "type_text": {
        const fields = current.elements.filter((element) => {
          if (!element.editable || element.focused !== true || element.enabled !== true || element.password !== false) return false;
          if (element.windowId === undefined) return true;
          const owner = current.windows.find((window) => window.id === element.windowId);
          return owner?.type === "TYPE_APPLICATION" && owner.active && owner.focused;
        });
        const field = fields.length === 1 ? fields[0] : undefined;
        const matches = field ? old.elements.filter((element) => sameObservedElement(element, field)) : [];
        const before = matches.length === 1 ? matches[0] : undefined;
        if (!field || !before) {
          throw new MobileUseError("ELEMENT_CHANGED", "A unique unchanged focused non-password native text field is required.", "Observe, focus an approved non-sensitive EditText, and observe again.");
        }
        const owner = verifyWindowContext(before, field);
        if (owner && (!field.packageName || field.packageName !== live.foregroundApp?.packageName)) {
          throw new MobileUseError("ELEMENT_CHANGED", "The focused editor does not belong to the observed foreground application.", "Focus an approved non-sensitive editor in the foreground app and observe again.");
        }
        let foreground: ForegroundApp | undefined;
        if (!isAdbText(action.text)) {
          foreground = await state.backend.getForegroundApp(signal) ?? undefined;
          const currentApp = foreground;
          if (!currentApp || [previous.foregroundApp, live.foregroundApp].some((app) => !app ||
            app.packageName !== currentApp.packageName || app.activityName !== currentApp.activityName || app.userId !== currentApp.userId)) {
            throw new MobileUseError("ELEMENT_CHANGED", "The foreground app or Android user could not be matched before Unicode input.", "Observe the approved text field again.");
          }
        }
        await state.backend.typeText(action.text, signal, field, foreground, expectedUserId);
        break;
      }
      case "key":
        await state.backend.key(action.key, signal);
        break;
      case "launch_app":
        await state.backend.launchApp(action.packageName, signal);
        break;
    }
  }

  act(targetToken: string, observationId: string, input: unknown, signal?: AbortSignal): Promise<ActionResult> {
    return this.serialize(async () => {
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success) throw new MobileUseError("INVALID_INPUT", "The action does not match the supported bounded action schema.", "Use one supported action with valid fields; raw ADB/shell commands are not accepted.");
      const action = parsed.data;
      if (action.kind === "type_text") validateText(action.text);
      const state = this.target(targetToken);
      const previous = this.snapshot;
      this.snapshot = undefined;
      const age = previous ? this.now() - previous.createdAt : -1;
      if (!previous || previous.screen.observation.observationId !== observationId ||
        previous.screen.observation.targetToken !== targetToken ||
        age < 0 || age > OBSERVATION_MAX_AGE_MS) {
        throw new MobileUseError("STALE_OBSERVATION", "The observation is missing, expired, or already consumed.", "Observe again; each observation authorizes at most one attempt.");
      }
      await this.ensureIdentity(state, signal);
      const includeScreenshot = previous.screen.observation.screenshot.status !== "skipped";
      const live = await this.capture(state, signal, includeScreenshot);
      let gestureTiming: ActionResult["gestureTiming"];
      try {
        const actualGapMs = await this.dispatch(state, action, previous, live, signal);
        if (action.kind === "double_tap" && actualGapMs !== undefined) {
          gestureTiming = { requestedDelayMs: action.delayMs, actualGapMs };
        }
      } catch (error) {
        const failure = publicError(error);
        if (invalidatingCodes.has(failure.code)) this.invalidate(true);
        if (failure.actionMayHaveRun || !(error instanceof MobileUseError)) {
          return {
            dispatchStatus: "outcome-unknown", verificationStatus: "unverified", after: null,
            error: { ...failure.toJSON(), retryable: false, actionMayHaveRun: true },
          };
        }
        throw failure;
      }
      try {
        await this.ensureEndpoint(state, signal);
        const after = await this.capture(state, signal, includeScreenshot);
        this.snapshot = after;
        return {
          dispatchStatus: "dispatched", verificationStatus: "requires-observation-review", after: after.screen, error: null,
          ...(gestureTiming ? { gestureTiming } : {}),
        };
      } catch (error) {
        const failure = publicError(error);
        if (invalidatingCodes.has(failure.code)) this.invalidate(true);
        return {
          dispatchStatus: "dispatched", verificationStatus: "unverified", after: null,
          error: { ...failure.toJSON(), retryable: false, actionMayHaveRun: true },
          ...(gestureTiming ? { gestureTiming } : {}),
        };
      }
    }, signal);
  }

  stop(): void {
    this.stopped = true;
    this.invalidate();
    this.lifetime.abort();
    this.adb.stop();
  }
}
