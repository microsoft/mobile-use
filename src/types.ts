import { z } from "zod";
import type { ErrorInfo } from "./errors.js";

export type Rect = Record<"x" | "y" | "width" | "height", number>;

export type ScreenElement = {
  ref: string;
  bounds: Rect;
  className: string;
  label: string;
  text: string;
  textHash?: string;
  windowIdentity?: string;
  windowId?: number;
  packageName?: string;
  pointerTarget?: true;
  resourceId: string | null;
  editable: boolean;
} & Record<"enabled" | "clickable" | "scrollable" | "focused" | "password", boolean | null>;

export interface ScreenWindow {
  id: number;
  displayId: number;
  bounds: Rect;
  layer: number;
  type: string;
  active: boolean;
  focused: boolean;
  hierarchy: "ok" | "unavailable";
}

export type TransportKind = "usb" | "network" | "paired-wireless" | "emulator" | "unknown";

export interface DeviceEndpoint {
  platform?: "android" | "ios";
  endpointId: string;
  transportId: string | null;
  kind: TransportKind;
  state: string;
  model: string | null;
  selectable: boolean;
  reason: string | null;
}

export interface AdbServerResult {
  status: "ready";
  serverAddress: "127.0.0.1:5037";
  startupAttempted: boolean;
  devices: DeviceEndpoint[];
}

export interface DeviceIdentity {
  hardwareSerial: string | null;
  androidVersion: string;
  apiLevel: number;
  wirelessEvidence: "not-applicable" | "device-tls-port" | "adb-tls-connect-service";
}

export interface SelectedTarget {
  targetToken: string;
  endpoint: DeviceEndpoint;
  identity: DeviceIdentity;
}

export interface WakeResult {
  status: "awake-and-unlocked";
  keyguardDismissed: boolean;
}

export interface PreparedGestures {
  status: "prepared";
  sha256: string;
  remotePath: string;
}

export interface PreparedTextInput {
  status: "prepared";
  sha256: string;
  remotePath: string;
}

export interface InstalledApps {
  userId: number;
  apps: { packageName: string }[];
}

export interface ForegroundApp {
  packageName: string;
  activityName: string;
  userId: number;
}

export interface AppOperationResult {
  status: "launched" | "terminated" | "installed" | "uninstalled";
  userId: number;
  packageName: string | null;
}

export interface ScreenRecording {
  recordingId: string;
  status: "starting" | "recording" | "completed" | "saved";
  startedAt: string;
  timeLimitSeconds: number | null;
  filePath: string;
  sizeBytes?: number;
}

export interface RecordingCapabilities {
  status: "available";
  source: "device-help";
  unlimitedSupported: boolean;
  maxTimeLimitSeconds: number;
  nativeDefaultTimeLimitSeconds: number;
}

export const MAX_RECORDING_TIME_SECONDS = 0xffff_ffff;

export const recordingActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capabilities") }),
  z.strictObject({
    kind: z.literal("start"),
    filePath: z.string().min(1).max(32_767),
    timeLimitSeconds: z.number().int().min(1).max(MAX_RECORDING_TIME_SECONDS).optional(),
  }),
  z.strictObject({ kind: z.literal("status") }),
  z.strictObject({ kind: z.literal("stop"), recordingId: z.string().uuid() }),
]);

export type RecordingAction = z.infer<typeof recordingActionSchema>;
export type RecordingStatus = ScreenRecording | { status: "idle" };
export type RecordingResult = RecordingStatus | RecordingCapabilities;

export interface ReadStatus {
  status: "ok" | "unavailable";
  error: ErrorInfo | null;
}

export interface CaptureTiming {
  startedAt: string;
  durationMs: number;
  screenshotDurationMs: number | null;
  hierarchyDurationMs: number;
}

export interface Observation {
  platform?: "android" | "ios";
  observationId: string;
  targetToken: string;
  capturedAt: string;
  captureTiming: CaptureTiming;
  nonAtomic: true;
  display: { width: number; height: number; rotation: number | null; scale?: number } | null;
  displayState: ReadStatus;
  screenshot: ReadStatus | { status: "skipped"; error: null };
  hierarchy: ReadStatus;
  hierarchyScope: "active-window" | "interactive-windows" | "unavailable";
  windows: ScreenWindow[];
  elements: ScreenElement[];
  warnings: string[];
}

export interface ObservedScreen {
  observation: Observation;
  image: Buffer | null;
}

export interface ActionResult {
  dispatchStatus: "dispatched" | "outcome-unknown";
  verificationStatus: "requires-observation-review" | "unverified";
  after: ObservedScreen | null;
  error: ErrorInfo | null;
  gestureTiming?: { requestedDelayMs: number; actualGapMs: number };
}

const pointSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

const boundsSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const elementRefSchema = z.string().regex(/^e[1-9]\d*$/);

const tapTargetSchema = z.union([
  z.strictObject({ elementRef: elementRefSchema }),
  pointSchema.extend({ bounds: boundsSchema.optional() }),
]);

export const packageNameSchema = z.string().max(255).regex(
  /^(?:android|[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)(?![\s\S])/,
);

export const tapActionSchema = z.strictObject({
  kind: z.literal("tap"),
  target: tapTargetSchema,
});

export const doubleTapActionSchema = z.strictObject({
  kind: z.literal("double_tap"),
  target: tapTargetSchema,
  delayMs: z.number().int().min(0).max(250).default(50),
});

export const longPressActionSchema = z.strictObject({
  kind: z.literal("long_press"),
  target: tapTargetSchema,
});

export const swipeActionSchema = z.strictObject({
  kind: z.literal("swipe"),
  from: pointSchema,
  to: pointSchema,
  elementRef: elementRefSchema.optional(),
  bounds: boundsSchema.optional(),
  durationMs: z.number().int().min(100).max(2000).default(400),
});

export const textActionSchema = z.strictObject({
  kind: z.literal("type_text"),
  text: z.string().min(1).max(256),
});

export const keyActionSchema = z.strictObject({
  kind: z.literal("key"),
  key: z.enum(["BACK", "HOME", "ENTER"]),
});

export const launchAppActionSchema = z.strictObject({
  kind: z.literal("launch_app"),
  packageName: packageNameSchema,
});

export const actionSchema = z.discriminatedUnion("kind", [
  tapActionSchema, doubleTapActionSchema, longPressActionSchema, swipeActionSchema,
  textActionSchema, keyActionSchema, launchAppActionSchema,
]);

export type MobileAction = z.infer<typeof actionSchema>;
