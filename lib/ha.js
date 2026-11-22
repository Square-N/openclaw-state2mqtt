// Home Assistant MQTT Discovery payloads for the OpenClaw agent bridge.
// No custom integration needed: HA's built-in MQTT integration creates these.
import { AGENT_STATES } from "./state.js";

export { AGENT_STATES };

/** Payload keys that are published under <base>/<key>. */
export const STATE_KEYS = {
  state: "state",
  busy: "busy",
  activeSessions: "sessions",
  pendingApprovals: "approvals",
  lastTool: "last_tool",
  lastTurnSeconds: "turn_s",
  attributes: "state_attributes",
};

/** MQTT-safe identity segment. Unicode is decomposed so "José" becomes "jose". */
export function sanitizeId(value) {
  return (
    String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "gateway"
  );
}

/** Human-facing instance label: printable, single-line and bounded. */
export function sanitizeDeviceName(value, maxLength = 64) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function buildEntities({
  baseTopic,
  availabilityTopic,
  deviceId,
  device,
  expireAfterSec = 120,
  pluginVersion = "",
  includeAttributes = false,
}) {
  const stateTopic = (key) => `${baseTopic}/${key}`;
  const common = {
    availability_topic: availabilityTopic,
    payload_available: "online",
    payload_not_available: "offline",
    // If the Gateway stops without a clean MQTT DISCONNECT (or is replaced),
    // HA flags the entities unavailable on its own instead of freezing state.
    expire_after: Math.max(30, expireAfterSec),
    device,
    origin: { name: "state2mqtt", sw: pluginVersion || "unknown" },
  };

  return [
    {
      component: "sensor",
      objectId: "agent_state",
      config: {
        ...common,
        name: "Agent state",
        unique_id: `${deviceId}_agent_state`,
        state_topic: stateTopic(STATE_KEYS.state),
        device_class: "enum",
        options: AGENT_STATES,
        icon: "mdi:robot",
        // Only advertise an attributes topic when one is actually published;
        // otherwise HA reports an empty/unknown attributes object.
        ...(includeAttributes
          ? { json_attributes_topic: stateTopic(STATE_KEYS.attributes) }
          : {}),
      },
    },
    {
      component: "binary_sensor",
      objectId: "busy",
      config: {
        ...common,
        name: "Agent busy",
        unique_id: `${deviceId}_busy`,
        state_topic: stateTopic(STATE_KEYS.busy),
        payload_on: "ON",
        payload_off: "OFF",
        device_class: "running",
        icon: "mdi:progress-clock",
      },
    },
    {
      component: "sensor",
      objectId: "active_sessions",
      config: {
        ...common,
        name: "Active sessions",
        unique_id: `${deviceId}_active_sessions`,
        state_topic: stateTopic(STATE_KEYS.activeSessions),
        icon: "mdi:account-multiple",
        state_class: "measurement",
      },
    },
    {
      component: "sensor",
      objectId: "pending_approvals",
      config: {
        ...common,
        name: "Pending approvals",
        unique_id: `${deviceId}_pending_approvals`,
        state_topic: stateTopic(STATE_KEYS.pendingApprovals),
        icon: "mdi:shield-alert-outline",
        state_class: "measurement",
      },
    },
    {
      component: "sensor",
      objectId: "last_tool",
      config: {
        ...common,
        name: "Last tool",
        unique_id: `${deviceId}_last_tool`,
        state_topic: stateTopic(STATE_KEYS.lastTool),
        icon: "mdi:tools",
      },
    },
    {
      component: "sensor",
      objectId: "last_turn",
      config: {
        ...common,
        name: "Last turn duration",
        unique_id: `${deviceId}_last_turn`,
        state_topic: stateTopic(STATE_KEYS.lastTurnSeconds),
        icon: "mdi:timer-outline",
        device_class: "duration",
        unit_of_measurement: "s",
        state_class: "measurement",
        suggested_display_precision: 1,
      },
    },
  ];
}

export function discoveryTopic(topicPrefix, component, nodeId, objectId) {
  return `${topicPrefix}/${component}/${nodeId}/${objectId}/config`;
}
