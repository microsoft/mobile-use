import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import type { MobileUseService } from "./device-session.js";
import { publicError } from "./errors.js";
import { onboardingInstructions, phoneSetup, setupForDevices, setupForError } from "./setup.js";
import { actionSchema } from "./types.js";
import type { ObservedScreen } from "./types.js";

function result(payload: unknown, image: Buffer | null = null, isError = false): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(payload) }];
  if (image) content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
  return { content, ...(isError ? { isError: true } : {}) };
}

async function safely(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    const failure = publicError(error);
    const setup = setupForError(failure.code, failure.actionMayHaveRun);
    process.stderr.write(`mobile-use: ${failure.code}\n`);
    return result({ error: failure.toJSON(), ...(setup ? { setup } : {}) }, null, true);
  }
}

function observationResult(screen: ObservedScreen): CallToolResult {
  return result({ observation: screen.observation }, screen.image);
}

export function createMobileUseServer(service: MobileUseService): McpServer {
  const server = new McpServer(
    { name: "mobile-use", version: packageInfo.version },
    { instructions: onboardingInstructions },
  );
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const targetToken = z.string().uuid();

  server.registerTool("mobile_doctor", {
    description: "Start here on first use: diagnose Windows/ADB prerequisites and return step-by-step setup guidance. Ready means host Platform-Tools only; then call mobile_list_devices before guiding missing phone setup. Guide Platform-Tools installation, Developer options, and USB/Wireless debugging only as needed. Never installs software, pairs, changes settings, lists, or controls devices.",
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => safely(async () => result({
    ...await service.doctor(ctx.mcpReq.signal), scope: "host", setup: phoneSetup,
  })));

  server.registerTool("mobile_start_adb_server", {
    description: "Only after the user explicitly approves starting the local ADB server: reuse a compatible server at 127.0.0.1:5037 or start a missing one, verify readiness, and retry read-only device discovery. The shared server may remain running after this plugin exits and may initialize standard local ADB host keys. Never kills, replaces, or restarts a server, changes settings, pairs, approves phone trust, or controls devices. Conflicts fail explicitly. Never automatically retry uncertain startup.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (_input, ctx) => safely(async () => {
    const started = await service.startAdbServer(ctx.mcpReq.signal);
    return result({ ...started, setup: setupForDevices(started.devices) });
  }));

  server.registerTool("mobile_list_devices", {
    description: "After mobile_doctor, list local ADB endpoints with online/unauthorized/offline states and the next setup steps. Empty inventory prompts Developer options/USB debugging guidance; unauthorized/offline entries need user setup. USB and Wi-Fi may be the same phone. Do not silently select a device or confuse endpoint identity with physical identity.",
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => safely(async () => {
    const devices = await service.listDevices(ctx.mcpReq.signal);
    return result({ devices, setup: setupForDevices(devices) });
  }));

  server.registerTool("mobile_select_device", {
    description: "Select exactly the endpoint the user chose from mobile_list_devices. Verify a real Android 11+ device and modern paired wireless when applicable. Does not pair or connect devices. Every selection invalidates prior target/observation tokens.",
    inputSchema: z.strictObject({ endpointId: z.string().min(1).max(512) }),
    annotations: readOnly,
  }, (input, ctx) => safely(async () => result(await service.selectDevice(input.endpointId, ctx.mcpReq.signal))));

  server.registerTool("mobile_observe", {
    description: "Read the selected device's primary display PNG and native UI hierarchy, with independent status and fresh references. Only observe user-approved non-sensitive content; results can be sent to the configured model service.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: readOnly,
  }, (input, ctx) => safely(async () => observationResult(await service.observe(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_wake", {
    description: "Only when explicitly requested, wake the selected phone and dismiss an unsecured lock screen. Requires a target token but no screen observation; invalidates previous observations. Never enters credentials, bypasses authentication, or captures the lock screen. Secure or unrecognized lock states require manual unlocking. After success, observe approved non-sensitive content before any other action. Never automatically replay an uncertain result.",
    inputSchema: z.strictObject({ targetToken }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (input, ctx) => safely(async () => result(await service.wake(input.targetToken, ctx.mcpReq.signal))));

  server.registerTool("mobile_act", {
    description: "Perform ONE explicitly authorized bounded action on the selected transport using the latest observation (consumed on attempt, expires after 30 seconds). Then observe and verify the requested state. Text appends to a focused non-password native EditText; supports only letters, digits, spaces, periods, commas, underscores, and hyphens. No blind batches, shell, helper installation, or endpoint fallback. Never replay uncertain input. Generic taps/keys can have consequences: installation/debugging trust is not user consent.",
    inputSchema: z.strictObject({ targetToken, observationId: z.string().uuid(), action: actionSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (input, ctx) => safely(async () => {
    const action = await service.act(input.targetToken, input.observationId, input.action, ctx.mcpReq.signal);
    return result({
      dispatchStatus: action.dispatchStatus,
      verificationStatus: action.verificationStatus,
      after: action.after?.observation ?? null,
      error: action.error,
    }, action.after?.image ?? null, action.verificationStatus === "unverified");
  }));

  server.server.onclose = () => service.stop();
  return server;
}
