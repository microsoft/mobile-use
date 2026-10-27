import { z } from "zod";
import type { ErrorInfo } from "./errors.js";

export type Rect = Record<"x" | "y" | "width" | "height", number>;

export type ScreenElement = {
  ref: string;
  bounds: Rect;
  className: string;
  label: string;
  text: string;
  resourceId: string | null;
  editable: boolean;
} & Record<"enabled" | "clickable" | "focused" | "password", boolean | null>;

export type TransportKind = "usb" | "network" | "paired-wireless" | "emulator" | "unknown";

export interface DeviceEndpoint {
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

export interface ReadStatus {
  status: "ok" | "unavailable";
  error: ErrorInfo | null;
}

export interface Observation {
  observationId: string;
  targetToken: string;
  capturedAt: string;
  nonAtomic: true;
  display: { width: number; height: number; rotation: number | null } | null;
  displayState: ReadStatus;
  screenshot: ReadStatus | { status: "skipped"; error: null };
  hierarchy: ReadStatus;
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

const tapTargetSchema = z.union([
  z.strictObject({ elementRef: z.string().regex(/^e[1-9]\d*$/) }),
  pointSchema,
]);

export const packageNameSchema = z.string().max(255).regex(
  /^(?:android|[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)(?![\s\S])/,
);

export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("tap"),
    target: tapTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("double_tap"),
    target: tapTargetSchema,
    delayMs: z.number().int().min(0).max(250).default(50),
  }),
  z.strictObject({
    kind: z.literal("swipe"),
    from: pointSchema,
    to: pointSchema,
    durationMs: z.number().int().min(100).max(2000).default(400),
  }),
  z.strictObject({
    kind: z.literal("type_text"),
    text: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal("key"),
    key: z.enum(["BACK", "HOME", "ENTER"]),
  }),
  z.strictObject({
    kind: z.literal("launch_app"),
    packageName: packageNameSchema,
  }),
]);

export type MobileAction = z.infer<typeof actionSchema>;
