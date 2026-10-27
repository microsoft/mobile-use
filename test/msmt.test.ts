import assert from "node:assert/strict";
import test from "node:test";
import { createMsmtService, MsmtError } from "../src/msmt/service.js";
import type { MobileAdapter, MsmtErrorCode, TaskScope } from "../src/msmt/service.js";

const scope: TaskScope = {
  apps: ["demo.notes"], operations: ["launch_app"], observationChannels: ["ui_tree"],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function fixture(platform: "android" | "ios" = "android") {
  const calls: string[] = [];
  const adapter: MobileAdapter = {
    device: { id: `fake-${platform}`, platform, enforcement: "host" },
    async launchApp(app) { calls.push(`launch:${app}`); },
    async observe() {
      calls.push("observe");
      return { appId: "demo.notes", text: "Synthetic notes" };
    },
  };
  return { adapter, calls };
}

function code(expected: MsmtErrorCode) {
  return (error: unknown) => error instanceof MsmtError && error.code === expected;
}

test("both platform adapters use one task API without automatic approval or observation", async () => {
  const android = fixture("android");
  const ios = fixture("ios");
  const { agent, control } = createMsmtService([android.adapter, ios.adapter]);
  assert.equal("approve" in agent, false);
  assert.equal("resume" in agent, false);
  assert.equal("revoke" in agent, false);
  assert.deepEqual(agent.listDevices().map((device) => device.platform), ["android", "ios"]);
  for (const device of agent.listDevices()) {
    const task = agent.requestTask(device.id, scope);
    assert.equal(task.state, "WAITING_APPROVAL");
    await assert.rejects(async () => agent.launchApp(task.taskId, "demo.notes"), code("TASK_INACTIVE"));
    await assert.rejects(async () => agent.observe(task.taskId, "ui_tree"), code("TASK_INACTIVE"));
    assert.deepEqual(android.calls, []);
    assert.deepEqual(ios.calls, []);
    control.approve(task.taskId);
    const calls = device.platform === "android" ? android.calls : ios.calls;
    assert.deepEqual(await agent.launchApp(task.taskId, "demo.notes"), {
      commitState: "committed", verificationStatus: "not_observed",
    });
    assert.deepEqual(calls, ["launch:demo.notes"]);
    assert.equal((await agent.observe(task.taskId, "ui_tree")).text, "Synthetic notes");
    control.revoke(task.taskId);
    calls.length = 0;
  }
});

test("action-only and observation-only grants cannot acquire the other permission", async () => {
  const { adapter, calls } = fixture();
  const { agent, control } = createMsmtService([adapter]);
  const action = agent.requestTask(adapter.device.id, { ...scope, observationChannels: [] });
  control.approve(action.taskId);
  await agent.launchApp(action.taskId, "demo.notes");
  await assert.rejects(agent.observe(action.taskId, "ui_tree"), code("PERMISSION_DENIED"));
  assert.deepEqual(calls, ["launch:demo.notes"]);
  control.revoke(action.taskId);

  const read = agent.requestTask(adapter.device.id, { ...scope, operations: [] });
  control.approve(read.taskId);
  await assert.rejects(agent.launchApp(read.taskId, "demo.notes"), code("PERMISSION_DENIED"));
  await agent.observe(read.taskId, "ui_tree");
  assert.deepEqual(calls, ["launch:demo.notes", "observe"]);
});

test("scope is copied and unauthorized app actions never reach the adapter", async () => {
  const { adapter, calls } = fixture();
  const { agent, control } = createMsmtService([adapter]);
  const apps = ["demo.notes"];
  const task = agent.requestTask(adapter.device.id, { ...scope, apps });
  apps.push("demo.bank");
  control.approve(task.taskId);
  await assert.rejects(agent.launchApp(task.taskId, "demo.bank"), code("PERMISSION_DENIED"));
  assert.deepEqual(calls, []);
  adapter.observe = async () => ({ appId: "demo.bank", text: "Not for the agent" });
  await assert.rejects(agent.observe(task.taskId, "ui_tree"), code("PERMISSION_DENIED"));
});

test("handoff blocks actions and collection until a trusted resume", async () => {
  const { adapter, calls } = fixture();
  const { agent, control } = createMsmtService([adapter]);
  const task = agent.requestTask(adapter.device.id, scope);
  control.approve(task.taskId);
  assert.equal((await agent.requestHandoff(task.taskId)).state, "PRIVATE_HANDOFF");
  await assert.rejects(async () => agent.observe(task.taskId, "ui_tree"), code("TASK_INACTIVE"));
  await assert.rejects(async () => agent.launchApp(task.taskId, "demo.notes"), code("TASK_INACTIVE"));
  assert.deepEqual(calls, []);
  agent.requestResume(task.taskId);
  await assert.rejects(async () => agent.observe(task.taskId, "ui_tree"), code("TASK_INACTIVE"));
  await control.resume(task.taskId);
  assert.equal((await agent.observe(task.taskId, "ui_tree")).grantEpoch, 3);
  assert.deepEqual(calls, ["observe"]);
});

test("handoff waits for in-flight collection and drops its result before allowing resume", async () => {
  const { adapter } = fixture();
  const started = deferred<void>();
  const finish = deferred<{ appId: string; text: string }>();
  adapter.observe = async () => { started.resolve(); return finish.promise; };
  const { agent, control } = createMsmtService([adapter]);
  const task = agent.requestTask(adapter.device.id, scope);
  control.approve(task.taskId);
  const observation = agent.observe(task.taskId, "ui_tree");
  const rejected = assert.rejects(observation, code("TASK_INACTIVE"));
  await started.promise;
  let completed = false;
  const barrier = control.handoff(task.taskId).then((status) => { completed = true; return status; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.throws(() => agent.requestResume(task.taskId), code("INVALID_STATE"));
  finish.resolve({ appId: "demo.notes", text: "Must not be delivered" });
  await rejected;
  assert.equal((await barrier).state, "PRIVATE_HANDOFF");
  agent.requestResume(task.taskId);
  await control.resume(task.taskId);
});

test("revocation blocks queued input and cannot undo already dispatched input", async () => {
  const { adapter, calls } = fixture();
  const started = deferred<void>();
  const finish = deferred<void>();
  adapter.launchApp = async (app) => {
    calls.push(`launch:${app}`);
    started.resolve();
    await finish.promise;
  };
  const { agent, control } = createMsmtService([adapter]);
  const task = agent.requestTask(adapter.device.id, scope);
  control.approve(task.taskId);
  const dispatched = agent.launchApp(task.taskId, "demo.notes");
  await started.promise;
  const queued = agent.launchApp(task.taskId, "demo.notes");
  const rejected = assert.rejects(queued, code("TASK_INACTIVE"));
  control.revoke(task.taskId);
  finish.resolve();
  assert.equal((await dispatched).commitState, "committed");
  await rejected;
  assert.deepEqual(calls, ["launch:demo.notes"]);
  await assert.rejects(async () => agent.observe(task.taskId, "ui_tree"), code("TASK_INACTIVE"));
});

test("revocation drops in-flight content and resume cannot reactivate the task", async () => {
  const { adapter } = fixture();
  const started = deferred<void>();
  const finish = deferred<{ appId: string; text: string }>();
  adapter.observe = async () => { started.resolve(); return finish.promise; };
  const { agent, control } = createMsmtService([adapter]);
  const task = agent.requestTask(adapter.device.id, scope);
  control.approve(task.taskId);
  const observation = agent.observe(task.taskId, "ui_tree");
  const rejected = assert.rejects(observation, code("TASK_INACTIVE"));
  await started.promise;
  control.revoke(task.taskId);
  finish.resolve({ appId: "demo.notes", text: "Must not be delivered" });
  await rejected;
  await assert.rejects(control.resume(task.taskId), code("INVALID_STATE"));
});

test("leases expire at the exact boundary and cannot be renewed by approval or resume", async () => {
  const { adapter, calls } = fixture();
  let now = 100;
  const { agent, control } = createMsmtService([adapter], { now: () => now, leaseMs: 10 });
  const task = agent.requestTask(adapter.device.id, scope);
  control.approve(task.taskId);
  now = 110;
  assert.equal(agent.getTaskStatus(task.taskId).state, "EXPIRED");
  await assert.rejects(async () => agent.observe(task.taskId, "ui_tree"), code("TASK_INACTIVE"));
  assert.throws(() => control.approve(task.taskId), code("INVALID_STATE"));
  await assert.rejects(control.resume(task.taskId), code("INVALID_STATE"));
  assert.deepEqual(calls, []);
  assert.equal(agent.requestTask(adapter.device.id, scope).state, "WAITING_APPROVAL");
});

test("a replacement lease cannot overlap an old in-flight action on the same device", async () => {
  const { adapter, calls } = fixture();
  const started = deferred<void>();
  const finish = deferred<void>();
  adapter.launchApp = async (app) => {
    calls.push(`launch:${app}`);
    if (calls.length === 1) {
      started.resolve();
      await finish.promise;
    }
  };
  const { agent, control } = createMsmtService([adapter]);
  const first = agent.requestTask(adapter.device.id, scope);
  control.approve(first.taskId);
  const oldAction = agent.launchApp(first.taskId, "demo.notes");
  await started.promise;
  control.revoke(first.taskId);
  const replacement = agent.requestTask(adapter.device.id, scope);
  control.approve(replacement.taskId);
  const newAction = agent.launchApp(replacement.taskId, "demo.notes");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  finish.resolve();
  await Promise.all([oldAction, newAction]);
  assert.equal(calls.length, 2);
});

test("invalid identifiers, unknown tasks, and duplicate leases do not reach adapters", () => {
  const { adapter, calls } = fixture();
  const { agent } = createMsmtService([adapter]);
  assert.throws(() => agent.requestTask("unknown", scope), code("DEVICE_NOT_FOUND"));
  assert.throws(() => agent.requestTask(adapter.device.id, { ...scope, apps: ["bad app"] }), code("INVALID_SCOPE"));
  assert.throws(() => agent.getTaskStatus("unknown"), code("TASK_NOT_FOUND"));
  agent.requestTask(adapter.device.id, scope);
  assert.throws(() => agent.requestTask(adapter.device.id, scope), code("DEVICE_BUSY"));
  assert.deepEqual(calls, []);
});

test("adapter errors are sanitized and uncertain mutations are not retried", async () => {
  const { adapter } = fixture();
  let attempts = 0;
  adapter.launchApp = async () => { attempts++; throw new Error("private device content"); };
  adapter.observe = async () => { throw new Error("private device content"); };
  const { agent, control } = createMsmtService([adapter]);
  const task = agent.requestTask(adapter.device.id, scope);
  control.approve(task.taskId);
  await assert.rejects(agent.launchApp(task.taskId, "demo.notes"), (error: unknown) => {
    assert.ok(error instanceof MsmtError);
    assert.equal(error.code, "ACTION_OUTCOME_UNKNOWN");
    assert.equal(error.message.includes("private"), false);
    return true;
  });
  assert.equal(attempts, 1);
  await assert.rejects(agent.observe(task.taskId, "ui_tree"), code("ADAPTER_FAILED"));
});
