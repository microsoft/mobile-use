import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { png } from "./helpers.js";

export async function createIosFixture() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const state = {
    sessionId: null as string | null, sequence: 0,
    uuid: "11111111-1111-4111-8111-111111111111", simulator: false, iosVersion: "17.5",
    app: "example.demo", pid: 100, build: "fixture-boot", locked: false,
    shade: 8, scale: 2, rotation: "PORTRAIT", buttonEnabled: true, buttonLabel: "Tap",
    windowName: "Main", value: "safe", focusId: "editor", focusType: "XCUIElementTypeTextField",
    overlay: false,
    failAction: false, failAfterAction: false, corruptSource: false,
    sourceHook: undefined as (() => void) | undefined,
    actionHook: undefined as (() => Promise<void>) | undefined,
  };
  const rects = {
    button: { x: 5, y: 5, width: 10, height: 10 },
    editor: { x: 5, y: 25, width: 20, height: 10 },
    table: { x: 1, y: 40, width: 38, height: 39 },
  };
  const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const node = (type: string, name: string, label: string, value: string, rect: typeof rects.button, children = "", enabled = true) =>
    `<${type} name="${attribute(name)}" label="${attribute(label)}" value="${attribute(value)}" enabled="${enabled}" visible="true" ` +
    `x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}">${children}</${type}>`;
  function source() {
    const children = node("XCUIElementTypeButton", "button", state.buttonLabel, "", rects.button, "", state.buttonEnabled) +
      node("XCUIElementTypeTextField", "editor", "Notes", state.value, rects.editor) +
      node("XCUIElementTypeTable", "table", "List", "", rects.table) +
      node("XCUIElementTypeSecureTextField", "private-name", "private-label", "private-value",
        { x: 30, y: 25, width: 5, height: 10 },
        node("XCUIElementTypeStaticText", "private-child", "private-child-label", "private-child-value",
          { x: 30, y: 25, width: 5, height: 10 })) +
      (state.overlay ? node("XCUIElementTypeButton", "overlay", "Overlay", "", rects.button) : "");
    const full = { x: 0, y: 0, width: 40, height: 80 };
    return `<AppiumAUT>${node("XCUIElementTypeApplication", "Demo", "Demo", "", full,
      node("XCUIElementTypeWindow", state.windowName, "", "", full, children))}</AppiumAUT>`;
  }
  function element(id: keyof typeof rects) {
    const type = id === "button" ? "XCUIElementTypeButton" : id === "table" ? "XCUIElementTypeTable" : state.focusType;
    return {
      "element-6066-11e4-a52e-4f735466cecf": id === "editor" ? state.focusId : id,
      type, rect: rects[id], enabled: id === "button" ? state.buttonEnabled : true, displayed: true,
      label: id === "button" ? state.buttonLabel : id === "editor" ? "Notes" : "List",
      "attribute/name": id, "attribute/value": id === "editor" ? state.value : null,
    };
  }
  const body = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "";
      const input = await body(request);
      calls.push({ method: request.method ?? "", path, body: input });
      const reply = (value: unknown, status = 200) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ sessionId: state.sessionId, value }));
      };
      if (path === "/status") {
        reply({ ready: true, os: { name: "iOS", version: state.iosVersion },
          ios: {}, build: { time: state.build, productBundleIdentifier: "example.runner" } });
        return;
      }
      if (path === "/wda/device/info") {
        reply({ uuid: state.uuid, model: "iPhone", isSimulator: state.simulator });
        return;
      }
      if (path === "/session" && request.method === "POST") {
        state.sessionId = `fixture-${++state.sequence}`;
        reply({ sessionId: state.sessionId });
        return;
      }
      if (path === `/session/${state.sessionId}` && request.method === "DELETE") {
        state.sessionId = null;
        reply(null);
        return;
      }
      if (!state.sessionId || !path.startsWith(`/session/${state.sessionId}/`)) {
        reply({ error: "invalid session id", message: "private-error" }, 404);
        return;
      }
      const command = path.slice(`/session/${state.sessionId}`.length);
      if (command === "/wda/locked") reply(state.locked);
      else if (command === "/wda/activeAppInfo") reply({ bundleId: state.app, pid: state.pid, name: "private-device-name" });
      else if (command === "/wda/screen") reply({ screenSize: { width: 40, height: 80 }, scale: state.scale });
      else if (command === "/orientation") reply(state.rotation);
      else if (command === "/source?format=xml") {
        const xml = state.corruptSource ? "<broken" : source();
        state.sourceHook?.();
        reply(xml);
      } else if (command === "/screenshot") reply(png(Math.round(40 * state.scale), Math.round(80 * state.scale), state.shade).toString("base64"));
      else if (command === "/element/active") reply(element("editor"));
      else if (command === "/elements") {
        const predicate = typeof input === "object" && input !== null && "value" in input ? String(input.value) : "";
        const id = predicate.includes("'button'") ? "button" : predicate.includes("'table'") ? "table" : "editor";
        reply([element(id)]);
      } else if (command.endsWith("/attribute/hittable")) reply(true);
      else if (command === "/actions" || command.endsWith("/value") || command === "/wda/homescreen") {
        await state.actionHook?.();
        if (command.endsWith("/value") && typeof input === "object" && input !== null && "text" in input) state.value += String(input.text);
        if (command === "/wda/homescreen") { state.app = "com.apple.springboard"; state.pid++; }
        if (state.failAfterAction) state.corruptSource = true;
        if (state.failAction) response.destroy(); else reply(null);
      } else if (command === "/wda/apps/launch") {
        if (typeof input === "object" && input !== null && "bundleId" in input) state.app = String(input.bundleId);
        state.pid++;
        if (state.failAction) response.destroy(); else reply(null);
      } else reply({ error: "unknown command", message: "private-error" }, 404);
    })().catch(() => {
      response.statusCode = 500;
      response.end(JSON.stringify({ sessionId: state.sessionId, value: { error: "unknown error", message: "fixture error" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return {
    state, calls, url: `http://127.0.0.1:${address.port}`, source,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
