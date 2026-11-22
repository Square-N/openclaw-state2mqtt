import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { MqttPublisher, readVarLen, pingIntervalMs } from "../lib/mqtt.js";

test("readVarLen distinguishes incomplete, valid and malformed", () => {
  assert.deepEqual(readVarLen(Buffer.alloc(0), 0), { status: "incomplete" });
  assert.deepEqual(readVarLen(Buffer.from([0x80]), 0), { status: "incomplete" });
  assert.deepEqual(readVarLen(Buffer.from([0x02, 0x00]), 0), {
    status: "ok",
    value: 2,
    next: 1,
  });
  // Four continuation bytes is an illegal varint, not "wait for more data".
  assert.deepEqual(
    readVarLen(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x01]), 0),
    { status: "malformed" },
  );
  // 262145 exceeds the 256 KiB packet cap.
  assert.deepEqual(readVarLen(Buffer.from([0x81, 0x80, 0x10]), 0), {
    status: "malformed",
  });
});

test("ping cadence stays under the broker timeout window", () => {
  assert.equal(pingIntervalMs(10), 5000);
  assert.equal(pingIntervalMs(60), 30000);
  assert.equal(pingIntervalMs(2), 2000);
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = net.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("CONNACK split across three TCP writes still connects", async () => {
  const server = await startServer((socket) => {
    socket.on("data", () => {
      const ack = Buffer.from([0x20, 0x02, 0x00, 0x00]);
      socket.write(ack.subarray(0, 1));
      setTimeout(() => socket.write(ack.subarray(1, 3)), 10);
      setTimeout(() => socket.write(ack.subarray(3, 4)), 20);
    });
  });
  const port = server.address().port;
  const logs = [];
  let connected = false;
  const pub = new MqttPublisher({
    host: "127.0.0.1",
    port,
    username: "u",
    password: "p",
    log: (level, msg) => {
      logs.push(msg);
      if (msg === "mqtt connected") connected = true;
    },
  });
  pub.connect();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(connected, true, `logs: ${logs.join(" | ")}`);
  pub.end();
  server.close();
});

test("CONNACK batched with another packet is still parsed", async () => {
  const server = await startServer((socket) => {
    socket.on("data", () => {
      // CONNACK + PINGRESP in a single chunk.
      socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00, 0xd0, 0x00]));
    });
  });
  const port = server.address().port;
  let connected = false;
  const pub = new MqttPublisher({
    host: "127.0.0.1",
    port,
    log: (_l, msg) => {
      if (msg === "mqtt connected") connected = true;
    },
  });
  pub.connect();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(connected, true);
  pub.end();
  server.close();
});

test("broker that never sends CONNACK is dropped on timeout", async () => {
  const server = await startServer((socket) => {
    socket.on("data", () => {
      /* swallow CONNECT, never answer */
    });
  });
  const port = server.address().port;
  const logs = [];
  const pub = new MqttPublisher({
    host: "127.0.0.1",
    port,
    connackTimeoutMs: 400,
    log: (_l, msg) => logs.push(msg),
  });
  pub.connect();
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(
    logs.includes("mqtt CONNACK timeout"),
    `expected timeout, got: ${logs.join(" | ")}`,
  );
  pub.end();
  server.close();
});

test("malformed packet after connect drops the connection", async () => {
  const server = await startServer((socket) => {
    let acked = false;
    socket.on("data", () => {
      if (!acked) {
        acked = true;
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        setTimeout(
          () => socket.write(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x80])),
          50,
        );
      }
    });
  });
  const port = server.address().port;
  const logs = [];
  const pub = new MqttPublisher({
    host: "127.0.0.1",
    port,
    log: (_l, msg) => logs.push(msg),
  });
  pub.connect();
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(
    logs.includes("mqtt sent a malformed packet header"),
    `expected malformed drop, got: ${logs.join(" | ")}`,
  );
  pub.end();
  server.close();
});

test("password without username warns instead of silently dropping it", async () => {
  const logs = [];
  const pub = new MqttPublisher({
    host: "127.0.0.1",
    port: 9,
    password: "secret",
    log: (_l, msg) => logs.push(msg),
  });
  pub.connect();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(logs.some((m) => m.includes("password is set without a username")));
  pub.end();
});

test("empty host never opens a socket", async () => {
  const logs = [];
  const pub = new MqttPublisher({ host: "", log: (_l, msg) => logs.push(msg) });
  pub.connect();
  assert.equal(pub.socket, null);
  assert.ok(logs.some((m) => m.includes("host is empty")));
});

test("oversized topic/payload is skipped instead of throwing", async () => {
  const server = await startServer((socket) => {
    let acked = false;
    socket.on("data", () => {
      if (acked) return;
      acked = true;
      socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
    });
  });
  const port = server.address().port;
  const logs = [];
  let connected = false;
  const pub = new MqttPublisher({
    host: "127.0.0.1",
    port,
    log: (_l, msg) => {
      logs.push(msg);
      if (msg === "mqtt connected") connected = true;
    },
  });
  pub.connect();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(connected, true);
  assert.doesNotThrow(() => pub.publish("state", "x".repeat(70000)));
  assert.doesNotThrow(() => pub.publish(`${"t".repeat(70000)}`, "x"));
  assert.ok(logs.some((m) => m.includes("exceeds the packet limit")));
  pub.end();
  server.close();
});
