import os from "node:os";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { MqttPublisher } from "./lib/mqtt.js";
import { AgentState, normalizeApprovalKind, redactApprovalSummary, sanitizeToolName } from "./lib/state.js";
import {
  STATE_KEYS,
  buildEntities,
  discoveryTopic,
  sanitizeDeviceName,
  sanitizeId,
} from "./lib/ha.js";
import {
  PLUGIN_VERSION,
  configSchema,
  needsShellForBin,
  normalizeConfig,
  resolveOpenclawBin,
} from "./lib/config.js";

const PLUGIN_ID = "state2mqtt";
const ACTIVE_INSTANCE = Symbol.for("state2mqtt.active");
const APPROVAL_PROBE_TIMEOUT_MS = 3000;
const APPROVAL_FAILURES_BEFORE_CLEAR = 3;

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function parseApprovalList(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  // Older/host CLI builds may prepend a warning line; accept the last JSON
  // line as a fallback instead of discarding every pending approval.
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value.startsWith("{") && !value.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(value);
      const list = Array.isArray(parsed) ? parsed : parsed?.approvals || [];
      return Array.isArray(list) ? list : [];
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export default {
  id: PLUGIN_ID,
  name: "OpenClaw Agent State → MQTT",
  description:
    "Publishes OpenClaw agent state to Home Assistant over MQTT discovery (no custom integration).",
  version: PLUGIN_VERSION,
  configSchema,
  register(api) {
    // Registration also happens for discovery/metadata modes. Hooks are
    // registered everywhere so `plugins inspect --runtime` can see them, but
    // only a live, configured instance may touch sockets, timers or state.
    const mode = api.registrationMode || "full";
    let enabled = mode === "full";

    const log = (level, message) => {
      try {
        const fn =
          api.logger?.[level] || (level === "debug" ? null : api.logger?.info);
        fn?.call(api.logger, message);
      } catch {
        /* logging must never break a turn */
      }
    };

    const state = new AgentState({ log });
    let publisherRef = null;

    // Timers and MQTT callbacks must never turn a transient failure into an
    // uncaught exception in the Gateway process.
    const safeRun = (fn) => {
      if (!enabled) return;
      try {
        fn();
      } catch (err) {
        log("warn", `${PLUGIN_ID}: background task failed: ${err?.message ?? err}`);
      }
    };

    const publishState = (force = false) => {
      if (!enabled) return;
      publisherRef?.(force);
    };

    // Session identity must be identical across before_agent_run,
    // after_tool_call and agent_end. `sessionId` is the stable per-session
    // incarnation; `runId` changes per turn and must never become a key.
    const sessionKeyOf = (event, ctx) =>
      ctx.sessionId ||
      event.sessionId ||
      ctx.sessionKey ||
      event.sessionKey ||
      "default";

    const guard = (fn) => (event, ctx) => {
      if (!enabled) return;
      try {
        fn(event || {}, ctx || {});
      } catch (err) {
        log("warn", `${PLUGIN_ID}: hook handler failed: ${err?.message ?? err}`);
      }
    };

    const registerHook = (name, handler) => {
      if (typeof api.on === "function") api.on(name, handler);
    };

    let scheduleErrorClear = null;
    let emitProbeRequest = null;

    // Only real agent turns may create a session record. Generic model-call
    // hooks (llm_input / model_call_started) also fire for auxiliary calls such
    // as title generation and memory flush, which never emit agent_end —
    // that is what left a phantom "working" session behind after a turn.
    registerHook("before_agent_run", guard((event, ctx) => {
      state.markWorking(sessionKeyOf(event, ctx));
      publishState();
    }));

    registerHook("after_tool_call", guard((event, ctx) => {
      const key = sessionKeyOf(event, ctx);
      const toolName = sanitizeToolName(event.toolName);
      // Only update a session this bridge already opened from a real agent
      // turn. Creating one here let auxiliary/async tool callbacks mint
      // phantom "working" records that never receive agent_end (HA then stays
      // on "working" until the stale sweep).
      if (state.sessions.has(key) && state.isWorking(key)) {
        state.markWorking(key, toolName);
      } else if (state.sessions.has(key)) {
        state.markTool(key, toolName);
      } else {
        log("debug", `${PLUGIN_ID}: untracked tool call ignored (${shortHash(key)})`);
      }
      publishState();
      if (state.pendingApprovals > 0) emitProbeRequest?.();
    }));

    registerHook("agent_end", guard((event, ctx) => {
      const key = sessionKeyOf(event, ctx);
      if (!state.sessions.has(key)) {
        log("debug", `${PLUGIN_ID}: agent_end for untracked session ${shortHash(key)}`);
      }
      state.finishTurn(key, {
        durationMs: event.durationMs,
        success: event.success,
      });
      publishState();
      if (state.errorExpiresAt) scheduleErrorClear?.();
      emitProbeRequest?.();
    }));

    registerHook("session_start", guard(() => publishState(true)));

    registerHook("session_end", guard((event, ctx) => {
      state.endSession(sessionKeyOf(event, ctx));
      publishState();
    }));

    if (mode !== "full") return;

    const { config: cfg, warnings } = normalizeConfig(api.pluginConfig);
    for (const warning of warnings) log("warn", `${PLUGIN_ID}: ${warning}`);

    // One live bridge per process, even if the host registers the plugin twice
    // without running the previous instance's dispose.
    const previousDispose = globalThis[ACTIVE_INSTANCE];
    if (typeof previousDispose === "function") {
      try {
        previousDispose();
      } catch {
        /* best effort */
      }
    }

    if (!cfg.host) {
      // Stay completely idle: no sockets, no timers, and no session table.
      enabled = false;
      log("warn", `${PLUGIN_ID}: no MQTT host configured; bridge is idle until config.host is set`);
      return;
    }

    const instanceLabel = sanitizeDeviceName(cfg.instance, 64);
    const instanceName = instanceLabel || os.hostname() || "gateway";
    const instanceId = sanitizeId(instanceName);
    const baseTopic = cfg.baseTopic || `openclaw/gw/${instanceId}`;
    const availabilityTopic = `${baseTopic}/availability`;
    const attributesTopic = `${baseTopic}/${STATE_KEYS.attributes}`;
    const deviceId = `oc_gw_${instanceId}`;
    // A slow heartbeat must never outlive the availability window, otherwise
    // HA flaps every entity to unavailable between publishes.
    const effectiveExpireAfterSec = Math.max(
      cfg.expireAfterSec,
      Math.ceil((cfg.publishIntervalMs * 2.5) / 1000),
    );

    const device = {
      identifiers: [deviceId],
      name: instanceLabel ? `OpenClaw Gateway (${instanceLabel})` : "OpenClaw Gateway",
      manufacturer: "OpenClaw",
      model: "Gateway",
      sw_version: PLUGIN_VERSION,
    };

    let stopped = false;
    let lastPublished = "";
    let approvalTimer = null;
    let heartbeatTimer = null;
    let sweepTimer = null;
    let errorTimer = null;
    let pollInFlight = false;
    let probeFailures = 0;
    let probeChild = null;
    const approvalItems = [];

    const publisher = new MqttPublisher({
      host: cfg.host,
      port: cfg.port,
      tls: cfg.tls,
      rejectUnauthorized: cfg.rejectUnauthorized,
      username: cfg.username,
      password: cfg.password,
      // A short, bounded client id works with brokers that still enforce the
      // legacy 23-character MQTT 3.1 limit.
      clientId: `s2m-${shortHash(`${instanceId}:${process.pid}:${Date.now()}`)}`,
      willTopic: availabilityTopic,
      willPayload: "offline",
      willRetain: true,
      keepaliveSec: cfg.keepaliveSec,
      connackTimeoutMs: cfg.connackTimeoutMs,
      log,
      onConnect: () => {
        publisher.publish(availabilityTopic, "online", true);
        publishDiscovery();
        // An empty retained payload deletes a leftover attribute topic from an
        // earlier publishSessionDetails=true run.
        if (!cfg.publishSessionDetails) publisher.publish(attributesTopic, "", true);
        lastPublished = "";
        publishState(true);
      },
    });

    function publishDiscovery() {
      const entities = buildEntities({
        baseTopic,
        availabilityTopic,
        deviceId,
        device,
        expireAfterSec: effectiveExpireAfterSec,
        pluginVersion: PLUGIN_VERSION,
        includeAttributes: Boolean(cfg.publishSessionDetails),
      });
      for (const entity of entities) {
        const topic = discoveryTopic(
          cfg.discoveryPrefix,
          entity.component,
          deviceId,
          entity.objectId,
        );
        try {
          publisher.publish(topic, JSON.stringify(entity.config), true);
        } catch (err) {
          log("warn", `${PLUGIN_ID}: discovery publish failed for ${entity.objectId}: ${err?.message ?? err}`);
        }
      }
    }

    function publishStateNow(force = false) {
      if (stopped || !enabled) return;
      try {
        const snapshot = state.snapshot();
        const lastTool = cfg.publishLastTool ? snapshot.lastTool : "hidden";
        const payload = {
          [STATE_KEYS.state]: snapshot.state,
          [STATE_KEYS.busy]: snapshot.busy ? "ON" : "OFF",
          [STATE_KEYS.activeSessions]: String(snapshot.workingCount),
          [STATE_KEYS.pendingApprovals]: String(snapshot.pendingApprovals),
          [STATE_KEYS.lastTool]: lastTool,
          [STATE_KEYS.lastTurnSeconds]: (snapshot.lastTurnMs / 1000).toFixed(1),
        };
        // Build the optional attribute body before the fingerprint so a
        // detail-only change (same counts, different session list) is not lost.
        const detail = cfg.publishSessionDetails
          ? {
              state: snapshot.state,
              pending_approvals: approvalItems,
              sessions: state.sessionList(12).map(([key, value]) => ({
                id: shortHash(key),
                working: Boolean(value.working),
                last_tool: cfg.publishLastTool
                  ? sanitizeToolName(value.lastTool) || null
                  : null,
              })),
            }
          : null;
        const fingerprint = JSON.stringify(payload) + (detail ? JSON.stringify(detail) : "");
        if (!force && fingerprint === lastPublished) return;
        lastPublished = fingerprint;

        // State topics first: the attributes payload is optional and must not
        // starve the entities if it ever grows past a broker limit.
        for (const [key, value] of Object.entries(payload)) {
          publisher.publish(`${baseTopic}/${key}`, value, true);
        }

        if (detail) {
          const body = {
            ...detail,
            updated_at: new Date().toISOString(),
          };
          publisher.publish(attributesTopic, JSON.stringify(body), true);
        }
      } catch (err) {
        log("warn", `${PLUGIN_ID}: state publish failed: ${err?.message ?? err}`);
      }
    }

    publisherRef = publishStateNow;

    scheduleErrorClear = () => {
      safeRun(() => {
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = setTimeout(() => {
          errorTimer = null;
          safeRun(() => publishStateNow(true));
        }, cfg.errorHoldMs);
        if (errorTimer.unref) errorTimer.unref();
      });
    };

    // Pending approvals are live Gateway state; the in-process RPC path is
    // admin-scoped (external plugins are rejected), so a bounded CLI probe is
    // used. It keeps running while a request is known to be pending, even if
    // the owning turn already ended.
    function probeApprovals() {
      if (pollInFlight || stopped || cfg.approvalPollMs <= 0) return;
      const snapshot = state.snapshot();
      if (!snapshot.anyWorking && snapshot.pendingApprovals === 0) return;
      pollInFlight = true;

      const bin = resolveOpenclawBin(cfg);
      const useShell = needsShellForBin(bin);
      // cmd.exe needs the executable quoted when its path contains spaces; the
      // fixed argument list carries no metacharacters of its own.
      const spawnBin = useShell ? `"${bin.replace(/"/g, '""')}"` : bin;
      let child;
      try {
        child = execFile(
          spawnBin,
          ["approvals", "pending", "--json"],
          {
            timeout: APPROVAL_PROBE_TIMEOUT_MS,
            // SIGKILL: a probe job that ignores SIGTERM would otherwise hold
            // plugin work open and block `plugins reload` drain forever.
            killSignal: "SIGKILL",
            maxBuffer: 1 << 20,
            shell: useShell,
            windowsHide: true,
          },
          (err, stdout) => {
            pollInFlight = false;
            if (stopped || !enabled) return;
            if (err) {
              probeFailures += 1;
              log("debug", `${PLUGIN_ID}: approval probe failed (${probeFailures}): ${err?.message ?? err}`);
              if (probeFailures >= APPROVAL_FAILURES_BEFORE_CLEAR && state.pendingApprovals !== 0) {
                log("warn", `${PLUGIN_ID}: approval probe kept failing; clearing pending count`);
                state.setPending(0);
                approvalItems.length = 0;
                publishStateNow(true);
              }
              return;
            }
            const list = parseApprovalList(stdout);
            if (list === null) {
              probeFailures += 1;
              log("debug", `${PLUGIN_ID}: approval output was not JSON: ${String(stdout).slice(0, 120)}`);
              return;
            }
            probeFailures = 0;
            const count = list.length;
            const items = [];
            for (const item of list.slice(0, 5)) {
              items.push({
                kind: normalizeApprovalKind(item?.kind),
                summary: redactApprovalSummary(item),
                created_at: item?.createdAtMs
                  ? new Date(item.createdAtMs).toISOString()
                  : null,
                expires_at: item?.expiresAtMs
                  ? new Date(item.expiresAtMs).toISOString()
                  : null,
              });
            }
            const changed =
              count !== state.pendingApprovals ||
              JSON.stringify(items) !== JSON.stringify(approvalItems);
            state.setPending(count);
            approvalItems.length = 0;
            approvalItems.push(...items);
            // Force: a changed summary/timestamp must not be hidden by an
            // unchanged aggregate fingerprint.
            if (changed) publishStateNow(true);
          },
        );
      } catch (err) {
        pollInFlight = false;
        log("warn", `${PLUGIN_ID}: approval probe could not start: ${err?.message ?? err}`);
        return;
      }
      probeChild = child;
      child.once("exit", () => {
        if (probeChild === child) probeChild = null;
      });
    }

    emitProbeRequest = () => probeApprovals();

    function dispose() {
      if (stopped) return;
      stopped = true;
      enabled = false;
      // A probe child that talks to this same Gateway must die first, otherwise
      // its admission work blocks the replacement drain.
      if (probeChild) {
        try {
          probeChild.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        probeChild = null;
      }
      for (const timer of [approvalTimer, heartbeatTimer, sweepTimer]) {
        if (timer) clearInterval(timer);
      }
      if (errorTimer) clearTimeout(errorTimer);
      approvalTimer = null;
      heartbeatTimer = null;
      sweepTimer = null;
      errorTimer = null;
      // No "offline" publish here: a plugin reload must not blank the entities.
      // Crash detection is the MQTT LWT; graceful stops are covered by the
      // discovery `expire_after` window.
      publisher.end();
      if (globalThis[ACTIVE_INSTANCE] === dispose) {
        delete globalThis[ACTIVE_INSTANCE];
      }
    }

    globalThis[ACTIVE_INSTANCE] = dispose;

    publisher.connect();

    heartbeatTimer = setInterval(
      () => safeRun(() => publishStateNow(true)),
      Math.max(2000, cfg.publishIntervalMs),
    );
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    sweepTimer = setInterval(
      () => safeRun(() => {
        if (state.sweep()) publishStateNow();
      }),
      Math.max(5000, cfg.sweepIntervalMs),
    );
    if (sweepTimer.unref) sweepTimer.unref();

    if (cfg.approvalPollMs > 0) {
      approvalTimer = setInterval(
        () => safeRun(() => probeApprovals()),
        Math.max(5000, cfg.approvalPollMs),
      );
      if (approvalTimer.unref) approvalTimer.unref();
    }

    if (api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(dispose);
    }

    log(
      "info",
      `${PLUGIN_ID}: bridge ready -> mqtt${cfg.tls ? "s" : ""}://${cfg.host}:${cfg.port} base=${baseTopic}`,
    );
  },
};
