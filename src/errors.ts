export type ErrorCode =
  | "UNSUPPORTED_HOST" | "ADB_NOT_FOUND" | "ADB_CONFIG_UNSUPPORTED"
  | "ADB_VERSION_UNSUPPORTED" | "ADB_FAILED" | "ADB_TIMEOUT" | "ADB_OUTPUT_LIMIT"
  | "ADB_SERVER_UNAVAILABLE" | "CANCELLED" | "INVALID_DEVICE_LIST"
  | "DEVICE_UNAUTHORIZED" | "DEVICE_OFFLINE" | "DEVICE_NOT_FOUND"
  | "DEVICE_UNSUPPORTED" | "DEVICE_METADATA_UNAVAILABLE" | "TRANSPORT_UNVERIFIED"
  | "TRANSPORT_LOST" | "TARGET_NOT_SELECTED" | "STALE_TARGET" | "STALE_OBSERVATION"
  | "INVALID_INPUT" | "UNSUPPORTED_TEXT" | "HIERARCHY_UNAVAILABLE"
  | "CAPTURE_UNAVAILABLE" | "INVALID_IMAGE" | "OBSERVATION_UNAVAILABLE"
  | "ELEMENT_CHANGED" | "APP_NOT_FOUND" | "APP_LAUNCH_FAILED"
  | "KEYGUARD_STATE_UNAVAILABLE" | "MANUAL_UNLOCK_REQUIRED" | "WAKE_FAILED"
  | "SERVER_STOPPED" | "INTERNAL_ERROR";

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  remediation: string;
  retryable: boolean;
  actionMayHaveRun: boolean;
}

export class MobileUseError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly remediation: string,
    readonly retryable = false,
    readonly actionMayHaveRun = false,
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
