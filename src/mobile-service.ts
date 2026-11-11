import type {
  ActionResult, AdbServerResult, AppOperationResult, DeviceEndpoint, DeviceStatus, ForegroundApp, InstalledApps,
  ObservedScreen, PreparedGestures, PreparedTextInput, RecordingAction, RecordingResult, SelectedTarget, WakeResult,
} from "./types.js";
import type { IosRuntimeAction, IosRuntimeStatus } from "./ios/runtime.js";

export interface AndroidDoctor {
  status: "ready";
  platform: "android";
  adbExecutable: string;
  platformToolsVersion: string;
  deviceStatus?: DeviceStatus;
}

export type IosDoctor = {
  status: "ready";
  platform: "ios";
  wdaUrl: string;
  iosVersion: string;
  model: string;
  runtime?: IosRuntimeStatus;
} | {
  status: "runtime-not-ready";
  platform: "ios";
  goIosVersion: string;
  runtime: IosRuntimeStatus;
};

export type MobileDoctor = AndroidDoctor | IosDoctor;

export interface IosSelectedTarget {
  targetToken: string;
  endpoint: DeviceEndpoint;
  identity: { platform: "ios"; vendorId: string; iosVersion: string; model: string; udid?: string };
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
  readonly iosRuntime?: (action: IosRuntimeAction, signal?: AbortSignal) => Promise<IosRuntimeStatus>;
  doctor(signal?: AbortSignal, targetToken?: string): Promise<MobileDoctor>;
  selectDevice(endpointId: string, signal?: AbortSignal): Promise<SelectedTarget | IosSelectedTarget>;
  getForegroundApp(targetToken: string, signal?: AbortSignal): Promise<ForegroundApp | IosForegroundApp | null>;
  launchApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult | IosAppOperationResult>;
  stop(): void | Promise<void>;
}
