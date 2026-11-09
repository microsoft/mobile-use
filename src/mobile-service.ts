import type {
  ActionResult, AdbServerResult, AppOperationResult, DeviceEndpoint, ForegroundApp, InstalledApps,
  ObservedScreen, PreparedGestures, PreparedTextInput, RecordingAction, RecordingResult, SelectedTarget, WakeResult,
} from "./types.js";

export interface AndroidDoctor {
  status: "ready";
  platform: "android";
  adbExecutable: string;
  platformToolsVersion: string;
}

export interface IosDoctor {
  status: "ready";
  platform: "ios";
  wdaUrl: string;
  iosVersion: string;
  model: string;
}

export type MobileDoctor = AndroidDoctor | IosDoctor;

export interface IosSelectedTarget {
  targetToken: string;
  endpoint: DeviceEndpoint;
  identity: { platform: "ios"; vendorId: string; iosVersion: string; model: string };
  capabilities: {
    tap: true;
    swipe: true;
    text: true;
    home: true;
    appLaunch: true;
    screenshot: true;
    unsupported: readonly string[];
  };
}

export interface IosForegroundApp {
  platform: "ios";
  packageName: string;
  pid: number;
}

export interface IosAppOperationResult {
  platform: "ios";
  status: "launched";
  packageName: string;
}

interface CommonMethods {
  startAdbServer(signal?: AbortSignal): Promise<AdbServerResult>;
  listDevices(signal?: AbortSignal): Promise<DeviceEndpoint[]>;
  observe(targetToken: string, signal?: AbortSignal, includeScreenshot?: boolean): Promise<ObservedScreen>;
  wake(targetToken: string, signal?: AbortSignal): Promise<WakeResult>;
  prepareGestures(targetToken: string, signal?: AbortSignal): Promise<PreparedGestures>;
  prepareTextInput(targetToken: string, signal?: AbortSignal): Promise<PreparedTextInput>;
  act(targetToken: string, observationId: string, input: unknown, signal?: AbortSignal): Promise<ActionResult>;
  listApps(targetToken: string, signal?: AbortSignal): Promise<InstalledApps>;
  terminateApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult>;
  installApp(targetToken: string, filePath: string, signal?: AbortSignal): Promise<AppOperationResult>;
  uninstallApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult>;
  screenRecording(targetToken: string, action: RecordingAction, signal?: AbortSignal): Promise<RecordingResult>;
}

export interface MobileService extends CommonMethods {
  readonly platform: "android" | "ios";
  doctor(signal?: AbortSignal): Promise<MobileDoctor>;
  selectDevice(endpointId: string, signal?: AbortSignal): Promise<SelectedTarget | IosSelectedTarget>;
  getForegroundApp(targetToken: string, signal?: AbortSignal): Promise<ForegroundApp | IosForegroundApp | null>;
  launchApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult | IosAppOperationResult>;
  stop(): void | Promise<void>;
}
