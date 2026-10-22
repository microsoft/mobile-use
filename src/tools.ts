import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import type { MobileUseService } from "./device-session.js";
import { publicError } from "./errors.js";
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
    process.stderr.write(`mobile-use: ${failure.code}\n`);
    return result({ error: failure.toJSON() }, null, true);
  }
}

function observationResult(screen: ObservedScreen): CallToolResult {
  return result({ observation: screen.observation }, screen.image);
}

export function createMobileUseServer(service: MobileUseService): McpServer {
  const server = new McpServer({ name: "mobile-use", version: packageInfo.version });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const targetToken = z.string().uuid();

  server.registerTool("mobile_doctor", {
    description: "Diagnose Windows/ADB prerequisites without installing software, pairing, or changing settings. Does not list or control devices.",
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => safely(async () => result(await service.doctor(ctx.mcpReq.signal))));

  server.registerTool("mobile_list_devices", {
    description: "List local ADB endpoints with online/unauthorized/offline states. USB and Wi-Fi may be the same phone. Do not silently select a device or confuse endpoint identity with physical identity.",
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, (_input, ctx) => safely(async () => result({ devices: await service.listDevices(ctx.mcpReq.signal) })));

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
