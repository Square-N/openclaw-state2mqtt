import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readVarLen } from "../lib/mqtt.js";
import plugin from "../index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out: ${message}`);
}

function startBroker() {
  return new Promise((resolve) => {
    const topics = new Map();
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        let offset = 0;
        while (offset < buffer.length) {
          if (buffer.length - offset < 2) break;
          const length = readVarLen(buffer, offset + 1);
          if (length.status !== "ok") break;
          const headerLength = 1 + (length.next - (offset + 1));
          const total = headerLength + length.value;
          if (buffer.length - offset < total) break;
          const type = buffer[offset] & 0xf0;
          const body = buffer.subarray(offset + headerLength, offset + total);
          if (type === 0x10) {
            socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
          } else if (type === 0x30) {
            const topicLength = body.readUInt16BE(0);
            const topic = body.subarray(2, 2 + topicLength).toString("utf8");
            const payload = body.subarray(2 + topicLength).toString("utf8");
            topics.set(topic, payload);
          }
          offset += total;
        }
        buffer = offset >= buffer.length ? Buffer.alloc(0) : buffer.subarray(offset);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        topics,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function makeApi(pluginConfig, hooks, logs, lifecycle) {
  return {
    id: "state2mqtt",
    registrationMode: "full",
    pluginConfig,
    logger: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
      error: (message) => logs.push(["error", message]),
    },
    on: (name, handler) => hooks.set(name, handler),
    lifecycle: {
      onDispose: (handler) => {
        lifecycle.dispose = handler;
        return () => {};
      },
    },
  };
}

test("a live bridge publishes discovery, state and turn events", async () => {
  const broker = await startBroker();
  const hooks = new Map();
  const logs = [];
  const lifecycle = {};
  const api = makeApi(
    {
      host: "127.0.0.1",
      port: broker.port,
      instance: "test",
      discoveryPrefix: "ha",
      publishIntervalMs: 2000,
      approvalPollMs: 0,
    },
    hooks,
    logs,
    lifecycle,
  );

  plugin.register(api);
  assert.equal(hooks.size, 5);
  assert.deepEqual(
    [...hooks.keys()].sort(),
    ["after_tool_call", "agent_end", "before_agent_run", "session_end", "session_start"],
  );

  try {
    await waitFor(
      () => broker.topics.get("openclaw/gw/test/availability") === "online",
      "availability online",
    );

    const discovery = broker.topics.get("ha/sensor/oc_gw_test/agent_state/config");
    assert.ok(discovery, "agent_state discovery config");
    const discoveryPayload = JSON.parse(discovery);
    assert.equal(discoveryPayload.state_topic, "openclaw/gw/test/state");
    assert.equal(discoveryPayload.unique_id, "oc_gw_test_agent_state");

    await waitFor(
      () => broker.topics.get("openclaw/gw/test/state") === "idle",
      "initial idle state",
    );
    assert.equal(broker.topics.get("openclaw/gw/test/state_attributes"), "");

    hooks.get("before_agent_run")({}, { sessionKey: "s1" });
    await waitFor(
      () => broker.topics.get("openclaw/gw/test/state") === "working",
      "working state",
    );
    assert.equal(broker.topics.get("openclaw/gw/test/sessions"), "1");

    hooks.get("after_tool_call")({ toolName: "exec\nrm -rf /tmp/x" }, { sessionKey: "s1" });
    await waitFor(
      () => broker.topics.get("openclaw/gw/test/last_tool") === "exec rm -rf /tmp/x",
      "sanitized last tool",
    );

    hooks.get("agent_end")({ success: true, durationMs: 1200 }, { sessionKey: "s1" });
    await waitFor(
      () =>
        broker.topics.get("openclaw/gw/test/state") === "idle" &&
        broker.topics.get("openclaw/gw/test/turn_s") === "1.2" &&
        broker.topics.get("openclaw/gw/test/sessions") === "0",
      "idle after the turn",
    );

    assert.equal(logs.filter(([level]) => level === "warn" || level === "error").length, 0);
  } finally {
    lifecycle.dispose?.();
    await sleep(30);
    await broker.close();
  }
});

test("publishLastTool=false keeps tool names off the broker", async () => {
  const broker = await startBroker();
  const hooks = new Map();
  const logs = [];
  const lifecycle = {};
  plugin.register(
    makeApi(
      {
        host: "127.0.0.1",
        port: broker.port,
        instance: "quiet",
        publishIntervalMs: 2000,
        approvalPollMs: 0,
        publishLastTool: "false",
      },
      hooks,
      logs,
      lifecycle,
    ),
  );

  try {
    await waitFor(
      () => broker.topics.get("openclaw/gw/quiet/availability") === "online",
      "availability online",
    );
    hooks.get("before_agent_run")({}, { sessionKey: "s1" });
    hooks.get("after_tool_call")({ toolName: "private_tool" }, { sessionKey: "s1" });
    await waitFor(
      () => broker.topics.get("openclaw/gw/quiet/last_tool") === "hidden",
      "last tool hidden",
    );
    assert.ok(![...broker.topics.values()].includes("private_tool"));
  } finally {
    lifecycle.dispose?.();
    await sleep(30);
    await broker.close();
  }
});

test("an untracked tool call cannot mint a phantom working session", async () => {
  const broker = await startBroker();
  const hooks = new Map();
  const logs = [];
  const lifecycle = {};
  plugin.register(
    makeApi(
      {
        host: "127.0.0.1",
        port: broker.port,
        instance: "ghost",
        publishIntervalMs: 2000,
        approvalPollMs: 0,
      },
      hooks,
      logs,
      lifecycle,
    ),
  );

  try {
    await waitFor(
      () => broker.topics.get("openclaw/gw/ghost/availability") === "online",
      "availability online",
    );
    hooks.get("after_tool_call")({ toolName: "exec" }, { sessionKey: "not-a-real-turn" });
    await sleep(150);
    assert.equal(broker.topics.get("openclaw/gw/ghost/state"), "idle");
    assert.equal(broker.topics.get("openclaw/gw/ghost/sessions"), "0");
  } finally {
    lifecycle.dispose?.();
    await sleep(30);
    await broker.close();
  }
});

test("sessionId is the stable key across before/tool/end hooks", async () => {
  const broker = await startBroker();
  const hooks = new Map();
  const logs = [];
  const lifecycle = {};
  plugin.register(
    makeApi(
      {
        host: "127.0.0.1",
        port: broker.port,
        instance: "stable",
        publishIntervalMs: 2000,
        approvalPollMs: 0,
      },
      hooks,
      logs,
      lifecycle,
    ),
  );

  try {
    await waitFor(
      () => broker.topics.get("openclaw/gw/stable/availability") === "online",
      "availability online",
    );
    hooks.get("before_agent_run")({}, { sessionId: "sid-1", sessionKey: "agent:main:x" });
    await waitFor(
      () => broker.topics.get("openclaw/gw/stable/state") === "working",
      "working state",
    );
    hooks.get("after_tool_call")({ toolName: "exec" }, { sessionId: "sid-1" });
    await waitFor(
      () => broker.topics.get("openclaw/gw/stable/last_tool") === "exec",
      "tool tracked under sessionId",
    );
    assert.equal(broker.topics.get("openclaw/gw/stable/sessions"), "1");
    hooks.get("agent_end")({ success: true, durationMs: 900 }, { sessionId: "sid-1" });
    await waitFor(
      () =>
        broker.topics.get("openclaw/gw/stable/state") === "idle" &&
        broker.topics.get("openclaw/gw/stable/sessions") === "0",
      "idle after canonical-key turn",
    );
  } finally {
    lifecycle.dispose?.();
    await sleep(30);
    await broker.close();
  }
});

test("an unconfigured or non-live registration stays inert", () => {
  const hooks = new Map();
  const logs = [];
  const lifecycle = {};
  plugin.register(makeApi({}, hooks, logs, lifecycle));
  assert.equal(hooks.size, 5);
  assert.ok(logs.some(([, message]) => message.includes("no MQTT host configured")));

  const discoveryHooks = new Map();
  const discoveryLogs = [];
  plugin.register({
    ...makeApi({ host: "192.168.1.10" }, discoveryHooks, discoveryLogs, {}),
    registrationMode: "discovery",
  });
  assert.equal(discoveryHooks.size, 5);
  assert.ok(!discoveryLogs.some(([, message]) => message.includes("bridge ready")));
});
