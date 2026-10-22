import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { createConnection, createServer, Socket } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";
import { LocalAdbServer } from "../src/adb-server.js";
import { MobileUseError } from "../src/errors.js";
import { hasCode, USB_LINE } from "./helpers.js";

function frame(text: string): string {
  return `OKAY${Buffer.byteLength(text).toString(16).padStart(4, "0")}${text}`;
}

function refused(): Socket {
  const socket = new Socket();
  queueMicrotask(() => socket.emit("error", Object.assign(new Error("fixture-only refusal"), { code: "ECONNREFUSED" })));
  return socket;
}

async function listener(t: TestContext, reply: (request: string) => string | Buffer | undefined = (request) =>
  frame(request === "host:version" ? "0029" : `${USB_LINE}\n`)) {
  const peers = new Set<Socket>();
  const requests: string[] = [];
  let available = true;
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    let pending = "";
    socket.on("data", (data: Buffer) => {
      pending += data.toString("utf8");
      if (pending.length < 4) return;
      const size = Number.parseInt(pending.slice(0, 4), 16);
      if (pending.length < size + 4) return;
      assert.equal(pending.length, size + 4);
      const request = pending.slice(4);
      requests.push(request);
      const response = reply(request);
      if (response !== undefined) {
        const bytes = typeof response === "string" ? Buffer.from(response) : response;
        socket.write(bytes.subarray(0, 1));
        setImmediate(() => socket.end(bytes.subarray(1)));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of peers) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    requests,
    get available() { return available; },
    set available(value: boolean) { available = value; },
    connect: () => available ? createConnection({ host: "127.0.0.1", port: address.port }) : refused(),
  };
}

function childFixture() {
  const child = new ChildProcess();
  let unrefs = 0;
  child.unref = () => { unrefs++; };
  child.kill = () => assert.fail("the shared server must never be killed");
  return {
    child,
    exit: () => Object.defineProperty(child, "exitCode", { value: 1, configurable: true }),
    get unrefs() { return unrefs; },
  };
}

test("a compatible existing ADB server is reused without a process launch", async (t) => {
  const fixture = await listener(t);
  const server = new LocalAdbServer(fixture.connect, () => assert.fail("must reuse the existing server"));
  const result = await server.ensureRunning("C:\\fixture\\adb.exe", {}, 41);
  assert.equal(result.startupAttempted, false);
  assert.equal(result.inventory.toString(), `${USB_LINE}\n`);
  assert.deepEqual(fixture.requests, ["host:version", "host:devices-l"]);
});

test("a valid empty inventory is returned without implying any phone is ready", async (t) => {
  const fixture = await listener(t, (request) => frame(request === "host:version" ? "0029" : ""));
  const server = new LocalAdbServer(fixture.connect, () => assert.fail("existing server is reused"));
  const result = await server.ensureRunning("C:\\fixture\\adb.exe", {}, 41);
  assert.equal(result.startupAttempted, false);
  assert.equal(result.inventory.length, 0);
});

test("a missing server gets one start-only loopback launch followed by readiness and inventory", async (t) => {
  const fixture = await listener(t);
  fixture.available = false;
  const process = childFixture();
  let launches = 0;
  const server = new LocalAdbServer(fixture.connect, (executable, args, options) => {
    launches++;
    assert.equal(executable, "C:\\fixture\\adb.exe");
    assert.deepEqual(args, ["-L", "tcp:127.0.0.1:5037", "server", "nodaemon"]);
    assert.equal(options.detached, true);
    assert.equal(options.stdio, "ignore");
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.env, { USERPROFILE: "C:\\fixture-user" });
    fixture.available = true;
    queueMicrotask(() => process.child.emit("spawn"));
    return process.child;
  });
  const result = await server.ensureRunning("C:\\fixture\\adb.exe", { USERPROFILE: "C:\\fixture-user" }, 41);
  assert.equal(result.startupAttempted, true);
  assert.equal(launches, 1);
  assert.equal(process.unrefs, 1);
  assert.deepEqual(fixture.requests, ["host:version", "host:devices-l"]);
});

for (const reply of ["FAIL0004test", "OKAY00040028", "OKAYzzzz0029", "OKAY000500029", "OKAY00040029extra", "OKAY0004"]) {
  test(`an incompatible or malformed listener is left alone (${reply})`, async (t) => {
    const fixture = await listener(t, () => reply);
    const server = new LocalAdbServer(fixture.connect, () => assert.fail("a conflict must not launch a server"));
    await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41), (error: unknown) => {
      hasCode("ADB_SERVER_CONFLICT")(error);
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.actionMayHaveRun, false);
      assert.doesNotMatch(JSON.stringify(error), /FAIL0004test|OKAY/);
      return true;
    });
    assert.deepEqual(fixture.requests, ["host:version"]);
  });
}

test("a silent occupied port is bounded and never mistaken for an absent server", { timeout: 4000 }, async (t) => {
  const fixture = await listener(t, () => undefined);
  const server = new LocalAdbServer(fixture.connect, () => assert.fail("an unresponsive listener is not absent"));
  await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41), hasCode("ADB_SERVER_CONFLICT"));
});

test("only connection refusal permits startup; other socket errors fail closed", async () => {
  const server = new LocalAdbServer(() => {
    const socket = new Socket();
    queueMicrotask(() => socket.emit("error", Object.assign(new Error("private fixture policy"), { code: "EACCES" })));
    return socket;
  }, () => assert.fail("ambiguous connection failures must not launch a server"));
  await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41), hasCode("ADB_SERVER_CONFLICT"));
});

test("a concurrent server winning the bind race is verified without replacement or another launch", async (t) => {
  const fixture = await listener(t);
  fixture.available = false;
  const process = childFixture();
  let launches = 0;
  const server = new LocalAdbServer(fixture.connect, () => {
    launches++;
    fixture.available = true;
    process.exit();
    queueMicrotask(() => process.child.emit("spawn"));
    return process.child;
  });
  assert.equal((await server.ensureRunning("C:\\fixture\\adb.exe", {}, 41)).startupAttempted, true);
  assert.equal(launches, 1);
});

test("process launch failure is explicit and does not claim that startup ran", async () => {
  const process = childFixture();
  const server = new LocalAdbServer(refused, () => {
    queueMicrotask(() => process.child.emit("error", Object.assign(new Error("private launch details"), { code: "ENOENT" })));
    return process.child;
  });
  await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41), (error: unknown) => {
    hasCode("ADB_NOT_FOUND")(error);
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.actionMayHaveRun, false);
    assert.doesNotMatch(JSON.stringify(error), /private launch details/);
    return true;
  });
});

test("an exited daemon fails startup without replaying the launch", async () => {
  const process = childFixture();
  let launches = 0;
  const server = new LocalAdbServer(refused, () => {
    launches++;
    process.exit();
    queueMicrotask(() => process.child.emit("spawn"));
    return process.child;
  });
  await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41), hasCode("ADB_SERVER_START_FAILED"));
  assert.equal(launches, 1);
});

test("startup has a five-second deadline and preserves uncertainty without killing or retrying", { timeout: 8000 }, async () => {
  const process = childFixture();
  let launches = 0;
  const server = new LocalAdbServer(refused, () => {
    launches++;
    queueMicrotask(() => process.child.emit("spawn"));
    return process.child;
  });
  await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41), (error: unknown) => {
    hasCode("ADB_SERVER_START_FAILED")(error);
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.actionMayHaveRun, true);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(launches, 1);
});

test("cancellation before startup has no effect, and cancellation after launch is uncertain", async () => {
  const controller = new AbortController();
  controller.abort();
  const inert = new LocalAdbServer(() => assert.fail("cancelled before probing"), () => assert.fail("cancelled before launching"));
  await assert.rejects(inert.ensureRunning("C:\\fixture\\adb.exe", {}, 41, controller.signal), hasCode("CANCELLED"));
  const pending = new AbortController();
  const process = childFixture();
  const server = new LocalAdbServer(refused, () => {
    queueMicrotask(() => {
      process.child.emit("spawn");
      pending.abort();
    });
    return process.child;
  });
  await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41, pending.signal), (error: unknown) => {
    hasCode("CANCELLED")(error);
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.actionMayHaveRun, true);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("readiness alone is not success when the subsequent discovery fails", async (t) => {
  const fixture = await listener(t, (request) => request === "host:version" ? frame("0029") : "FAIL0004test");
  const server = new LocalAdbServer(fixture.connect, () => assert.fail("existing server is reused"));
  await assert.rejects(server.ensureRunning("C:\\fixture\\adb.exe", {}, 41), hasCode("ADB_SERVER_CONFLICT"));
  assert.deepEqual(fixture.requests, ["host:version", "host:devices-l"]);
});
