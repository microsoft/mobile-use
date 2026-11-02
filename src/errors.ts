import type { CaptureTiming, Rect } from "./types.js";

export type ErrorCode =
  | "UNSUPPORTED_HOST" | "ADB_NOT_FOUND" | "ADB_CONFIG_UNSUPPORTED"
  | "ADB_VERSION_UNSUPPORTED" | "ADB_FAILED" | "ADB_TIMEOUT" | "ADB_OUTPUT_LIMIT"
  | "ADB_SERVER_UNAVAILABLE" | "ADB_SERVER_CONFLICT" | "ADB_SERVER_START_FAILED"
  | "CANCELLED" | "INVALID_DEVICE_LIST"
  | "DEVICE_UNAUTHORIZED" | "DEVICE_OFFLINE" | "DEVICE_NOT_FOUND"
  | "DEVICE_UNSUPPORTED" | "DEVICE_METADATA_UNAVAILABLE" | "TRANSPORT_UNVERIFIED"
  | "TRANSPORT_LOST" | "TARGET_NOT_SELECTED" | "STALE_TARGET" | "STALE_OBSERVATION"
  | "INVALID_INPUT" | "UNSUPPORTED_TEXT" | "HIERARCHY_UNAVAILABLE" | "DISPLAY_STATE_UNAVAILABLE"
  | "CAPTURE_UNAVAILABLE" | "INVALID_IMAGE" | "OBSERVATION_UNAVAILABLE"
  | "ELEMENT_CHANGED" | "APP_NOT_FOUND" | "APP_LAUNCH_FAILED"
  | "APP_LIST_UNAVAILABLE" | "APP_FOREGROUND_UNAVAILABLE" | "APP_STATE_UNAVAILABLE"
  | "APP_TERMINATE_FAILED" | "APP_INSTALL_FAILED" | "APP_UNINSTALL_FAILED" | "INVALID_APP_FILE"
  | "KEYGUARD_STATE_UNAVAILABLE" | "MANUAL_UNLOCK_REQUIRED" | "WAKE_FAILED"
  | "GESTURE_HELPER_NOT_PREPARED" | "GESTURE_HELPER_UNAVAILABLE"
  | "TEXT_HELPER_NOT_PREPARED" | "TEXT_HELPER_UNAVAILABLE" | "TEXT_INPUT_UNSUPPORTED" | "TEXT_INPUT_FAILED"
  | "RECORDING_ACTIVE" | "RECORDING_NOT_FOUND" | "RECORDING_FAILED" | "RECORDING_STOP_FAILED"
  | "INVALID_RECORDING_FILE" | "RECORDING_EXPORT_FAILED" | "RECORDING_CLEANUP_FAILED"
  | "RECORDING_CAPABILITIES_UNAVAILABLE" | "RECORDING_DURATION_UNSUPPORTED"
  | "SERVER_STOPPED" | "INTERNAL_ERROR";

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  remediation: string;
  retryable: boolean;
  actionMayHaveRun: boolean;
  visualGuard?: VisualGuardDiagnostics;
}

export interface VisualGuardDiagnostics {
  protectedRegion: Rect;
  changedPixels: number;
  regionChangedPixels: number;
  totalPixels: number;
  changedBounds: Rect | null;
  regionChangedBounds: Rect | null;
  previousCapture: CaptureTiming;
  currentCapture: CaptureTiming;
}

export class MobileUseError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly remediation: string,
    readonly retryable = false,
    readonly actionMayHaveRun = false,
    readonly visualGuard?: VisualGuardDiagnostics,
  ) {
    super(message);
    this.name = "MobileUseError";
  }

  toJSON(): ErrorInfo {
    return {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
      actionMayHaveRun: this.actionMayHaveRun,
      ...(this.visualGuard ? { visualGuard: this.visualGuard } : {}),
    };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function publicError(error: unknown): MobileUseError {
  if (error instanceof MobileUseError) return error;
  return new MobileUseError(
    "INTERNAL_ERROR",
    "An unexpected mobile-use error interrupted this operation.",
    "Stop input and report the error code. Do not include private device data in the report.",
  );
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MobileUseError("CANCELLED", "The operation was cancelled.", "Observe again before continuing.");
  }
}
