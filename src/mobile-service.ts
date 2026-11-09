import type { MobileUseService } from "./device-session.js";
import type { AppOperationResult, DeviceEndpoint, ForegroundApp, SelectedTarget } from "./types.js";

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

type CommonMethods = Pick<MobileUseService,
  "startAdbServer" | "listDevices" | "observe" | "wake" | "prepareGestures" | "prepareTextInput" |
  "act" | "listApps" | "terminateApp" | "installApp" | "uninstallApp" | "screenRecording"
>;

export interface MobileService extends CommonMethods {
  readonly platform?: "android" | "ios";
  doctor(signal?: AbortSignal): Promise<
    { status: "ready"; adbExecutable: string; platformToolsVersion: string } |
    { status: "ready"; platform: "ios"; wdaUrl: string; iosVersion: string; model: string }
  >;
  selectDevice(endpointId: string, signal?: AbortSignal): Promise<SelectedTarget | IosSelectedTarget>;
  getForegroundApp(targetToken: string, signal?: AbortSignal): Promise<ForegroundApp | IosForegroundApp | null>;
  launchApp(targetToken: string, packageName: string, signal?: AbortSignal): Promise<AppOperationResult | IosAppOperationResult>;
  stop(): void | Promise<void>;
}
