import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import type { MobileService } from "./mobile-service.js";
import { publicError } from "./errors.js";
import { androidPromptPack } from "./prompts/android/tools.js";
import type { PromptPack } from "./prompts/contracts.js";
import { iosExternalPromptPack, iosManagedPromptPack, iosRuntimeToolPrompt } from "./prompts/ios/tools.js";
import { phoneSetup, setupForDevices, setupForError } from "./setup.js";
import { iosSetup, managedIosSetup, setupForIosDevices, setupForIosError } from "./ios/setup.js";
import { iosBundleIdSchema } from "./ios/wda.js";
import { iosRuntimeActionSchema } from "./ios/runtime.js";
import {
  doubleTapActionSchema, keyActionSchema, longPressActionSchema, packageNameSchema, swipeActionSchema,
  recordingActionSchema, tapActionSchema, textActionSchema,
} from "./types.js";
import type { ActionResult, ObservedScreen } from "./types.js";

function result(payload: unknown, image: Buffer | null = null, isError = false): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(payload) }];
  if (image) content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
  return { content, ...(isError ? { isError: true } : {}) };
}

async function safely(operation: () => Promise<CallToolResult>, ios = false, managed = false): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    const failure = publicError(error);
    const setup = ios ? setupForIosError(failure.code, managed) : setupForError(failure.code, failure.actionMayHaveRun);
    process.stderr.write(`mobile-use: ${failure.code}\n`);
    return result({ error: failure.toJSON(), ...(setup ? { setup } : {}) }, null, true);
  }
}

function observationResult(screen: ObservedScreen): CallToolResult {
  return result({ observation: screen.observation }, screen.image);
}

function actionResult(action: ActionResult): CallToolResult {
  return result({
    dispatchStatus: action.dispatchStatus,
    verificationStatus: action.verificationStatus,
    after: action.after?.observation ?? null,
    error: action.error,
    ...(action.gestureTiming ? { gestureTiming: action.gestureTiming } : {}),
  }, action.after?.image ?? null, action.verificationStatus === "unverified");
}

function resolvePromptPack(ios: boolean, managed: boolean): PromptPack {
  if (!ios) return androidPromptPack;
  return managed ? iosManagedPromptPack : iosExternalPromptPack;
}

export function createMobileUseServer(service: MobileService): McpServer {
  const ios = service.platform === "ios";
  const controlRuntime = ios ? service.iosRuntime : undefined;
  const managed = controlRuntime !== undefined;
  const prompts = resolvePromptPack(ios, managed);
  const doctorSetup = ios ? (managed ? managedIosSetup : iosSetup) : phoneSetup;
  const execute = (operation: () => Promise<CallToolResult>) => safely(operation, ios, managed);
  const server = new McpServer(
    { name: "mobile-use", version: packageInfo.version },
    { instructions: prompts.instructions },
  );
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const mutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const targetToken = z.string().uuid();
  const observationId = z.string().uuid();
  const appIdentifier = ios ? iosBundleIdSchema : packageNameSchema;
  const prepareAction = z.strictObject({ kind: z.literal("prepare") });

  if (controlRuntime) server.registerTool("mobile_ios_runtime", {
    ...iosRuntimeToolPrompt,
    inputSchema: z.strictObject({ action: iosRuntimeActionSchema }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => result(await controlRuntime(input.action, ctx.mcpReq.signal))));

  server.registerTool("mobile_doctor", {
    ...prompts.tools.mobile_doctor,
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => execute(async () => result({
    ...await service.doctor(ctx.mcpReq.signal), scope: "host", setup: doctorSetup,
  })));

  server.registerTool("mobile_start_adb_server", {
    ...prompts.tools.mobile_start_adb_server,
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (_input, ctx) => execute(async () => {
    const started = await service.startAdbServer(ctx.mcpReq.signal);
    return result({ ...started, setup: setupForDevices(started.devices) });
  }));

  server.registerTool("mobile_list_devices", {
    ...prompts.tools.mobile_list_devices,
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => execute(async () => {
    const devices = await service.listDevices(ctx.mcpReq.signal);
    return result({ devices, setup: ios ? setupForIosDevices(devices, managed) : setupForDevices(devices) });
  }));

  server.registerTool("mobile_select_device", {
    ...prompts.tools.mobile_select_device,
    inputSchema: z.strictObject({ endpointId: z.string().min(1).max(512) }),
    annotations: ios ? mutation : readOnly,
  }, (input, ctx) => execute(async () => result(await service.selectDevice(input.endpointId, ctx.mcpReq.signal))));

  server.registerTool("mobile_observe", {
    ...prompts.tools.mobile_observe,
    inputSchema: z.strictObject({ targetToken, includeScreenshot: z.boolean().default(true) }),
    annotations: readOnly,
  }, (input, ctx) => execute(async () => observationResult(await service.observe(input.targetToken, ctx.mcpReq.signal, input.includeScreenshot))));

  server.registerTool("mobile_wake", {
    ...prompts.tools.mobile_wake,
    inputSchema: z.strictObject({ targetToken }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => result(await service.wake(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_tap", {
    ...prompts.tools.mobile_tap,
    inputSchema: z.strictObject({
      targetToken,
      action: z.discriminatedUnion("kind", [
        prepareAction, tapActionSchema.extend({ observationId }), doubleTapActionSchema.extend({ observationId }),
        longPressActionSchema.extend({ observationId }),
      ]),
    }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    if (input.action.kind === "prepare") return result(await service.prepareGestures(input.targetToken, ctx.mcpReq.signal));
    const { observationId, ...action } = input.action;
    return actionResult(await service.act(input.targetToken, observationId, action, ctx.mcpReq.signal));
  }));

  server.registerTool("mobile_swipe", {
    ...prompts.tools.mobile_swipe,
    inputSchema: swipeActionSchema.omit({ kind: true }).extend({ targetToken, observationId }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    const { targetToken, observationId, ...swipe } = input;
    return actionResult(await service.act(targetToken, observationId, { kind: "swipe", ...swipe }, ctx.mcpReq.signal));
  }));

  server.registerTool("mobile_press_key", {
    ...prompts.tools.mobile_press_key,
    inputSchema: keyActionSchema.omit({ kind: true }).extend({ targetToken, observationId }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => actionResult(await service.act(
    input.targetToken, input.observationId, { kind: "key", key: input.key }, ctx.mcpReq.signal,
  ))));

  server.registerTool("mobile_input_text", {
    ...prompts.tools.mobile_input_text,
    inputSchema: z.strictObject({
      targetToken,
      action: z.discriminatedUnion("kind", [prepareAction, textActionSchema.extend({ observationId })]),
    }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    if (input.action.kind === "prepare") return result(await service.prepareTextInput(input.targetToken, ctx.mcpReq.signal));
    const { observationId, ...action } = input.action;
    return actionResult(await service.act(input.targetToken, observationId, action, ctx.mcpReq.signal));
  }));

  server.registerTool("mobile_screen_recording", {
    ...prompts.tools.mobile_screen_recording,
    inputSchema: z.strictObject({ targetToken, action: recordingActionSchema }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => result(await service.screenRecording(input.targetToken, input.action, ctx.mcpReq.signal))));

  server.registerTool("mobile_app_management", {
    ...prompts.tools.mobile_app_management,
    inputSchema: z.strictObject({
      targetToken,
      action: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("list") }),
        z.strictObject({ kind: z.literal("foreground") }),
        z.strictObject({ kind: z.literal("launch"), packageName: appIdentifier }),
        z.strictObject({ kind: z.literal("terminate"), packageName: appIdentifier }),
        z.strictObject({ kind: z.literal("install"), filePath: z.string().min(1).max(32_767) }),
        z.strictObject({ kind: z.literal("uninstall"), packageName: appIdentifier }),
      ]),
    }),
    annotations: mutation,
  }, (input, ctx) => execute(async () => {
    const { targetToken, action } = input;
    const signal = ctx.mcpReq.signal;
    switch (action.kind) {
      case "list": return result(await service.listApps(targetToken, signal));
      case "foreground": return result({ foregroundApp: await service.getForegroundApp(targetToken, signal) });
      case "launch": return result(await service.launchApp(targetToken, action.packageName, signal));
      case "terminate": return result(await service.terminateApp(targetToken, action.packageName, signal));
      case "install": return result(await service.installApp(targetToken, action.filePath, signal));
      case "uninstall": return result(await service.uninstallApp(targetToken, action.packageName, signal));
    }
  }));

  server.server.onclose = () => {
    void Promise.resolve(service.stop()).catch(() => {
      process.stderr.write("mobile-use: device session cleanup failed; check the owned session on the device.\n");
      process.exitCode = 1;
    });
  };
  return server;
}
