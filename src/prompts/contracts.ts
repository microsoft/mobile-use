export interface SetupGuidance<Stage extends string = string> {
  stage: Stage;
  steps: string[];
}

export type AndroidSetupStage =
  | "platform-tools"
  | "adb-server"
  | "phone"
  | "authorization"
  | "connection"
  | "select-device";

export type IosSetupStage = "connection" | "select-device";

export type MultiPlatformSetupStage =
  | AndroidSetupStage
  | "wda"
  | "ios-runtime"
  | "host-setup";

export type CoreToolName =
  | "mobile_doctor"
  | "mobile_start_adb_server"
  | "mobile_list_devices"
  | "mobile_select_device"
  | "mobile_observe"
  | "mobile_wake"
  | "mobile_tap"
  | "mobile_swipe"
  | "mobile_press_key"
  | "mobile_input_text"
  | "mobile_screen_recording"
  | "mobile_app_management";

export type IosRuntimeToolName = "mobile_ios_runtime";

export interface ToolPrompt {
  readonly title: string;
  readonly description: string;
}

export interface PromptPack<TTool extends string = CoreToolName> {
  readonly instructions: string;
  readonly tools: Readonly<Record<TTool, ToolPrompt>>;
}

export type AndroidPromptPack = PromptPack<CoreToolName>;
export type IosExternalPromptPack = PromptPack<CoreToolName>;
export type IosManagedPromptPack = PromptPack<CoreToolName | IosRuntimeToolName>;
export type MultiPlatformPromptPack = PromptPack<CoreToolName | IosRuntimeToolName>;

export function joinPrompt(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}
