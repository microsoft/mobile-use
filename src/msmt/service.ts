import { randomUUID } from "node:crypto";

export type TaskState = "WAITING_APPROVAL" | "ACTIVE" | "PRIVATE_HANDOFF" | "WAITING_RESUME" | "EXPIRED" | "REVOKED";
export type MsmtErrorCode = "INVALID_SCOPE" | "TASK_NOT_FOUND" | "DEVICE_NOT_FOUND" | "DEVICE_BUSY"
  | "TASK_INACTIVE" | "INVALID_STATE" | "PERMISSION_DENIED" | "STALE_GRANT"
  | "ADAPTER_FAILED" | "ACTION_OUTCOME_UNKNOWN";

export class MsmtError extends Error {
  constructor(readonly code: MsmtErrorCode) {
    super(code);
    this.name = "MsmtError";
  }
}

export interface MobileAdapter {
  readonly device: {
    readonly id: string;
    readonly platform: "android" | "ios";
    readonly enforcement: "host";
  };
  launchApp(appId: string): Promise<void>;
  observe(): Promise<{ appId: string; text: string }>;
}

export interface TaskScope {
  readonly apps: readonly string[];
  readonly operations: readonly "launch_app"[];
  readonly observationChannels: readonly "ui_tree"[];
}

interface Task {
  id: string;
  adapter: MobileAdapter;
  scope: TaskScope;
  state: TaskState;
  epoch: number;
  expiresAt: number;
  queue: Promise<void>;
  handoffComplete: boolean;
}

const terminal = (state: TaskState): boolean => state === "EXPIRED" || state === "REVOKED";

// Object separation is for the trusted caller, not an in-process security sandbox.
export function createMsmtService(
  adapters: readonly MobileAdapter[],
  options: { now?: () => number; leaseMs?: number } = {},
) {
  const now = options.now ?? (() => performance.now());
  const leaseMs = options.leaseMs ?? 60_000;
  if (!Number.isFinite(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new MsmtError("INVALID_SCOPE");
  const devices = new Map(adapters.map((adapter) => [adapter.device.id, adapter]));
  if (devices.size !== adapters.length) throw new MsmtError("INVALID_SCOPE");
  const tasks = new Map<string, Task>();
  const deviceQueues = new Map<MobileAdapter, Promise<void>>();

  function refresh(task: Task): Task {
    if (!terminal(task.state) && now() >= task.expiresAt) {
      task.state = "EXPIRED";
      task.epoch++;
    }
    return task;
  }

  function get(id: string): Task {
    const task = tasks.get(id);
    if (!task) throw new MsmtError("TASK_NOT_FOUND");
    return refresh(task);
  }

  function status(task: Task) {
    refresh(task);
    return {
      taskId: task.id, deviceId: task.adapter.device.id, state: task.state, grantEpoch: task.epoch,
      handoffReady: task.state === "PRIVATE_HANDOFF" && task.handoffComplete,
    };
  }

  function requireActive(task: Task): void {
    if (refresh(task).state !== "ACTIVE") throw new MsmtError("TASK_INACTIVE");
  }

  function queue<T>(task: Task, operation: () => Promise<T>): Promise<T> {
    requireActive(task);
    const epoch = task.epoch;
    const result = (deviceQueues.get(task.adapter) ?? Promise.resolve()).then(async () => {
      requireActive(task);
      if (task.epoch !== epoch) throw new MsmtError("STALE_GRANT");
      return operation();
    });
    task.queue = result.then(() => undefined, () => undefined);
    deviceQueues.set(task.adapter, task.queue);
    return result;
  }

  async function handoff(taskId: string) {
    const task = get(taskId);
    requireActive(task);
    task.state = "PRIVATE_HANDOFF";
    task.epoch++;
    task.handoffComplete = false;
    await (deviceQueues.get(task.adapter) ?? Promise.resolve());
    task.handoffComplete = true;
    return status(task);
  }

  const agent = Object.freeze({
    listDevices: () => adapters.map((adapter) => ({ ...adapter.device })),

    requestTask(deviceId: string, scope: TaskScope) {
      const adapter = devices.get(deviceId);
      if (!adapter) throw new MsmtError("DEVICE_NOT_FOUND");
      if (!scope.apps.length || scope.apps.some((app) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(app)) ||
        scope.operations.some((operation) => operation !== "launch_app") ||
        scope.observationChannels.some((channel) => channel !== "ui_tree")) {
        throw new MsmtError("INVALID_SCOPE");
      }
      for (const task of tasks.values()) {
        if (task.adapter.device.id === deviceId && !terminal(refresh(task).state)) throw new MsmtError("DEVICE_BUSY");
      }
      const task: Task = {
        id: randomUUID(), adapter,
        scope: {
          apps: [...scope.apps],
          operations: [...scope.operations],
          observationChannels: [...scope.observationChannels],
        },
        state: "WAITING_APPROVAL", epoch: 0, expiresAt: now() + leaseMs, queue: Promise.resolve(),
        handoffComplete: false,
      };
      tasks.set(task.id, task);
      return status(task);
    },

    getTaskStatus: (taskId: string) => status(get(taskId)),
    requestHandoff: handoff,

    requestResume(taskId: string) {
      const task = get(taskId);
      if (task.state !== "PRIVATE_HANDOFF" || !task.handoffComplete) throw new MsmtError("INVALID_STATE");
      task.state = "WAITING_RESUME";
      return status(task);
    },

    launchApp(taskId: string, appId: string) {
      const task = get(taskId);
      return queue(task, async () => {
        if (!task.scope.operations.includes("launch_app") || !task.scope.apps.includes(appId)) {
          throw new MsmtError("PERMISSION_DENIED");
        }
        try {
          await task.adapter.launchApp(appId);
        } catch {
          // Adapter exceptions may contain device content; dispatch may already have happened.
          throw new MsmtError("ACTION_OUTCOME_UNKNOWN");
        }
        return { commitState: "committed" as const, verificationStatus: "not_observed" as const };
      });
    },

    observe(taskId: string, channel: "ui_tree") {
      const task = get(taskId);
      return queue(task, async () => {
        if (channel !== "ui_tree" || !task.scope.observationChannels.includes(channel)) {
          throw new MsmtError("PERMISSION_DENIED");
        }
        const epoch = task.epoch;
        let observation: Awaited<ReturnType<MobileAdapter["observe"]>>;
        try {
          observation = await task.adapter.observe();
        } catch {
          throw new MsmtError("ADAPTER_FAILED");
        }
        requireActive(task);
        if (task.epoch !== epoch) throw new MsmtError("STALE_GRANT");
        if (!task.scope.apps.includes(observation.appId)) throw new MsmtError("PERMISSION_DENIED");
        return { taskId, grantEpoch: epoch, channel, appId: observation.appId, text: observation.text };
      });
    },
  });

  const control = Object.freeze({
    approve(taskId: string) {
      const task = get(taskId);
      if (task.state !== "WAITING_APPROVAL") throw new MsmtError("INVALID_STATE");
      task.epoch++;
      task.state = "ACTIVE";
      return status(task);
    },
    handoff,
    async resume(taskId: string) {
      const task = get(taskId);
      if (task.state !== "WAITING_RESUME") throw new MsmtError("INVALID_STATE");
      await task.queue;
      if (refresh(task).state !== "WAITING_RESUME") throw new MsmtError("INVALID_STATE");
      task.epoch++;
      task.state = "ACTIVE";
      return status(task);
    },
    revoke(taskId: string) {
      const task = get(taskId);
      if (!terminal(task.state)) {
        task.epoch++;
        task.state = "REVOKED";
      }
      return status(task);
    },
  });
  return { agent, control };
}
