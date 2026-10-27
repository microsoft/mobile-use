import { createMsmtService, MsmtError } from "./service.js";
import type { MobileAdapter } from "./service.js";

function simulatedAdapter(platform: "android" | "ios"): MobileAdapter {
  let appId = "demo.notes";
  return {
    device: { id: `simulated-${platform}`, platform, enforcement: "host" },
    async launchApp(target) { appId = target; },
    async observe() { return { appId, text: `Synthetic ${platform} notes: hello MSMT` }; },
  };
}

async function expectDenied(label: string, operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof MsmtError)) throw error;
    console.log(`${label}: ${error.code}`);
    return;
  }
  throw new Error(`Expected denial: ${label}`);
}

const { agent, control } = createMsmtService([simulatedAdapter("android"), simulatedAdapter("ios")]);
console.log("MSMT simulation only: no ADB, WDA, phone, MCP connection, or real approval UI.");

for (const device of agent.listDevices()) {
  const task = agent.requestTask(device.id, {
    apps: ["demo.notes"], operations: ["launch_app"], observationChannels: ["ui_tree"],
  });
  console.log(`\n${device.platform}: ${task.state}, enforcement=${device.enforcement}`);
  await expectDenied("Before approval", () => agent.observe(task.taskId, "ui_tree"));

  // This harness stands in for the trusted UI; an Agent must receive only `agent`.
  control.approve(task.taskId);
  console.log("Launch:", await agent.launchApp(task.taskId, "demo.notes"));
  console.log("Observe:", await agent.observe(task.taskId, "ui_tree"));
  await expectDenied("Unapproved app", () => agent.launchApp(task.taskId, "demo.bank"));

  console.log("Handoff barrier:", await control.handoff(task.taskId));
  await expectDenied("Private capture", () => agent.observe(task.taskId, "ui_tree"));
  await expectDenied("Private action", () => agent.launchApp(task.taskId, "demo.notes"));
  agent.requestResume(task.taskId);
  await expectDenied("Resume request is not approval", () => agent.observe(task.taskId, "ui_tree"));
  await control.resume(task.taskId);
  console.log("After trusted resume:", await agent.observe(task.taskId, "ui_tree"));
  control.revoke(task.taskId);
  await expectDenied("After revocation", () => agent.observe(task.taskId, "ui_tree"));
}

const actionOnly = agent.requestTask("simulated-android", {
  apps: ["demo.notes"], operations: ["launch_app"], observationChannels: [],
});
control.approve(actionOnly.taskId);
console.log("\nAction-only grant:", await agent.launchApp(actionOnly.taskId, "demo.notes"));
await expectDenied("Action does not grant observation", () => agent.observe(actionOnly.taskId, "ui_tree"));
control.revoke(actionOnly.taskId);
