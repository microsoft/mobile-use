import { createHash, randomUUID } from "node:crypto";
import { parseAdbVersion, parseDeviceList, startTransportMonitor } from "./adb.js";
import type { AdbConnection, MonitorFactory, TransportMonitor } from "./adb.js";
import { AndroidBackend, validateText } from "./android.js";
import type { Hierarchy, Screenshot } from "./android.js";
import { checkCancelled, MobileUseError, publicError } from "./errors.js";
import { actionSchema } from "./types.js";
import type {
  ActionResult, AdbServerResult, AppOperationResult, DeviceEndpoint, DeviceIdentity, ForegroundApp, InstalledApps, MobileAction, Observation,
  ObservedScreen, ReadStatus, ScreenElement, SelectedTarget, WakeResult,
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
  imageHash: string | null;
}

function sameEndpoint(inventory: DeviceEndpoint[], expected: DeviceEndpoint): boolean {
  return inventory.some((endpoint) =>
    endpoint.endpointId === expected.endpointId &&
    endpoint.transportId === expected.transportId &&
    endpoint.state === "device",
  );
}

function elementSignature(element: ScreenElement): string {
  const { ref: _ref, ...properties } = element;
  return JSON.stringify(properties);
}

function requirePoint(point: { x: number; y: number }, display: Observation["display"]): void {
  if (!display || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
    point.x < 0 || point.y < 0 || point.x >= display.width || point.y >= display.height) {
    throw new MobileUseError("INVALID_INPUT", "The point is outside the observed primary display.", "Observe again and use in-bounds coordinates.");
  }
}

function readFailure(error: unknown): ReadStatus {
  const failure = publicError(error);
  if (invalidatingCodes.has(failure.code) || ["CANCELLED", "ADB_NOT_FOUND", "ADB_CONFIG_UNSUPPORTED", "INTERNAL_ERROR", "SERVER_STOPPED"].includes(failure.code)) {
    throw failure;
  }
  return { status: "unavailable", error: failure.toJSON() };
}

export class MobileUseService {
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

  doctor(signal?: AbortSignal): Promise<{ status: "ready"; adbExecutable: string; platformToolsVersion: string }> {
    return this.serialize(async () => {
      const adbExecutable = this.adb.executable();
      const output = (await this.adb.run(["version"], signal ? { signal } : {})).toString("utf8");
      const { platformToolsVersion } = parseAdbVersion(output);
      return { status: "ready", adbExecutable, platformToolsVersion };
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

  private async capture(state: TargetState, signal?: AbortSignal, includeScreenshot = true): Promise<Snapshot> {
    const results = await Promise.allSettled([
      includeScreenshot ? state.backend.screenshot(signal) : Promise.resolve(null),
      state.backend.hierarchy(signal),
      state.backend.displayState(signal),
    ]);
    const [imageResult, hierarchyResult, displayResult] = results;
    const screenshotStatus: Observation["screenshot"] = !includeScreenshot
      ? { status: "skipped", error: null }
      : imageResult.status === "fulfilled"
        ? { status: "ok", error: null } : readFailure(imageResult.reason);
    const hierarchyStatus: ReadStatus = hierarchyResult.status === "fulfilled"
      ? { status: "ok", error: null } : readFailure(hierarchyResult.reason);
    const displayStatus: ReadStatus = displayResult.status === "fulfilled"
      ? { status: "ok", error: null } : readFailure(displayResult.reason);
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
        "Stop input. The user should expose an unlocked, observable safe screen; do not bypass protection.",
      );
    }
    if (verifiedDisplay && ((screenshot &&
      (screenshot.width !== verifiedDisplay.width || screenshot.height !== verifiedDisplay.height)) ||
      (hierarchy && hierarchy.rotation !== verifiedDisplay.rotation))) {
      throw new MobileUseError("STALE_OBSERVATION", "Display geometry changed or is inconsistent during observation.", "Observe again on the primary display.", true);
    }
    const dimensions = screenshot ? { width: screenshot.width, height: screenshot.height } : verifiedDisplay;
    const display = dimensions ? { width: dimensions.width, height: dimensions.height, rotation: verifiedDisplay?.rotation ?? null } : null;
    const warnings: string[] = [];
    if (!includeScreenshot) warnings.push("Screenshot capture skipped by request; no screenshot-coordinate actions are permitted.");
    else if (!screenshot) warnings.push("Image unavailable; no screenshot-coordinate actions are permitted.");
    if (!hierarchy) warnings.push("Hierarchy unavailable; no semantic element or focused-field claims can be made.");
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
      nonAtomic: true,
      display,
      displayState: displayStatus,
      screenshot: screenshotStatus,
      hierarchy: hierarchyStatus,
      elements: visible.map((element, index) => ({ ...element, ref: `e${index + 1}` })),
      warnings,
    };
    const image = screenshot?.image ?? null;
    return {
      screen: { observation, image },
      createdAt: now,
      imageHash: image ? createHash("sha256").update(image).digest("hex") : null,
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
  ): Promise<T> {
    return this.serialize(async () => {
      const state = this.target(targetToken);
      if (mutating) this.snapshot = undefined;
      await this.ensureIdentity(state, signal);
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

  private async dispatch(state: TargetState, action: MobileAction, previous: Snapshot, live: Snapshot, signal?: AbortSignal): Promise<void> {
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
    const unchangedImage = (): void => {
      if (old.screenshot.status === "skipped") {
        throw new MobileUseError(
          "CAPTURE_UNAVAILABLE",
          "Screenshot capture was disabled for this observation; coordinate actions are not permitted.",
          "Use a fresh hierarchy observation and an enabled clickable elementRef.",
        );
      }
      if (!previous.imageHash || previous.imageHash !== live.imageHash) {
        throw new MobileUseError("STALE_OBSERVATION", "The screenshot changed before coordinate input.", "Observe again and choose coordinates from the new screen.");
      }
    };
    switch (action.kind) {
      case "tap":
      case "double_tap": {
        let point: { x: number; y: number };
        if ("elementRef" in action.target) {
          const ref = action.target.elementRef;
          const oldElement = old.elements.find((element) => element.ref === ref);
          const matches = oldElement ? current.elements.filter((element) => elementSignature(element) === elementSignature(oldElement)) : [];
          const element = matches.length === 1 ? matches[0] : undefined;
          if (!element || element.enabled !== true || element.clickable !== true) {
            throw new MobileUseError("ELEMENT_CHANGED", "The referenced actionable element is missing, changed, disabled, or ambiguous.", "Inspect a new hierarchy and choose one enabled clickable element.");
          }
          point = {
            x: Math.floor(element.bounds.x + element.bounds.width / 2),
            y: Math.floor(element.bounds.y + element.bounds.height / 2),
          };
        } else {
          unchangedImage();
          point = action.target;
        }
        requirePoint(point, current.display);
        if (action.kind === "double_tap") await state.backend.doubleTap(point.x, point.y, action.delayMs, signal);
        else await state.backend.tap(point.x, point.y, signal);
        break;
      }
      case "swipe":
        unchangedImage();
        requirePoint(action.from, current.display);
        requirePoint(action.to, current.display);
        await state.backend.swipe(action.from, action.to, action.durationMs, signal);
        break;
      case "type_text": {
        const fields = current.elements.filter((element) =>
          element.editable && element.focused === true && element.enabled === true && element.password === false);
        const field = fields.length === 1 ? fields[0] : undefined;
        if (!field || !old.elements.some((element) => elementSignature(element) === elementSignature(field))) {
          throw new MobileUseError("ELEMENT_CHANGED", "A unique unchanged focused non-password native text field is required.", "Observe, focus an approved non-sensitive EditText, and observe again.");
        }
        await state.backend.typeText(action.text, signal);
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
      try {
        await this.dispatch(state, action, previous, live, signal);
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
        return { dispatchStatus: "dispatched", verificationStatus: "requires-observation-review", after: after.screen, error: null };
      } catch (error) {
        const failure = publicError(error);
        if (invalidatingCodes.has(failure.code)) this.invalidate(true);
        return {
          dispatchStatus: "dispatched", verificationStatus: "unverified", after: null,
          error: { ...failure.toJSON(), retryable: false, actionMayHaveRun: true },
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
