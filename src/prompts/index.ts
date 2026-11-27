export * from "./contracts.js";
export * from "./android/consent.js";
export {
  adbServerSetup,
  authorizationSetup,
  buildAndroidSelectDeviceSetup,
  connectionSetup,
  deviceSelectionInstructions,
  phoneSetup,
  platformToolsSetup,
  serverConflictSetup,
  type AndroidSetupGuidance,
} from "./android/setup.js";
export { androidServerInstructions } from "./android/instructions.js";
export { androidPromptPack, androidToolPrompts } from "./android/tools.js";
export {
  buildIosSelectDeviceSetup,
  iosRuntimeSetup,
  iosSetup,
  managedIosSetup,
  type IosSetupGuidance,
} from "./multi-platform/ios-setup.js";
export { iosInstructions, iosSharedSafetyInstructions, managedIosInstructions } from "./multi-platform/ios-instructions.js";
export {
  iosExternalPromptPack,
  iosExternalToolPrompts,
  iosManagedPromptPack,
  iosManagedToolPrompts,
  iosRuntimeToolPrompt,
} from "./multi-platform/ios-tools.js";
export {
  buildMultiPlatformSelectDeviceSetup,
  multiPlatformDeviceSelectionInstructions,
  multiPlatformHostSetup,
  type MultiPlatformSetupGuidance,
} from "./multi-platform/setup.js";
export { multiPlatformServerInstructions } from "./multi-platform/instructions.js";
export { multiPlatformPromptPack, multiPlatformToolPrompts } from "./multi-platform/tools.js";
