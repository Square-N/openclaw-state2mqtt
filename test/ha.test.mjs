import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_STATES,
  STATE_KEYS,
  buildEntities,
  discoveryTopic,
  sanitizeDeviceName,
  sanitizeId,
} from "../lib/ha.js";

const BASE = "openclaw/gw/home";
const AVAILABILITY = `${BASE}/availability`;

const DEVICE = {
  identifiers: ["oc_gw_home"],
  name: "OpenClaw Gateway (home)",
  manufacturer: "OpenClaw",
  model: "Gateway",
  sw_version: "9.9.9",
};

function entities(extra = {}) {
  return buildEntities({
    baseTopic: BASE,
    availabilityTopic: AVAILABILITY,
    deviceId: "oc_gw_home",
    device: DEVICE,
    expireAfterSec: 120,
    pluginVersion: "9.9.9",
    ...extra,
  });
}

test("sanitizeId produces a bounded MQTT/HA-safe segment", () => {
  assert.equal(sanitizeId("Ubuntu MCS #1"), "ubuntu_mcs_1");
  assert.equal(sanitizeId("José's Pi"), "jose_s_pi");
  assert.equal(sanitizeId("___"), "gateway");
  assert.equal(sanitizeId(""), "gateway");
  assert.equal(sanitizeId("x".repeat(80)).length, 40);
});

test("sanitizeDeviceName keeps a printable single-line label", () => {
  assert.equal(sanitizeDeviceName("  lab\n  gateway  "), "lab gateway");
  assert.equal(sanitizeDeviceName("\u0000\u0007"), "");
  assert.equal(sanitizeDeviceName("x".repeat(100)).length, 64);
});

test("discovery topics and unique ids are deterministic", () => {
  assert.equal(
    discoveryTopic("homeassistant", "sensor", "oc_gw_home", "agent_state"),
    "homeassistant/sensor/oc_gw_home/agent_state/config",
  );

  const list = entities();
  assert.equal(list.length, 6);
  const state = list.find((entity) => entity.objectId === "agent_state");
  assert.equal(state.config.state_topic, `${BASE}/${STATE_KEYS.state}`);
  assert.deepEqual(state.config.options, AGENT_STATES);
  assert.equal(state.config.unique_id, "oc_gw_home_agent_state");
  assert.equal(state.config.availability_topic, AVAILABILITY);
  assert.equal(state.config.expire_after, 120);
  assert.equal(state.config.json_attributes_topic, undefined);
  assert.equal(state.config.origin.name, "state2mqtt");
  assert.equal(state.config.origin.sw, "9.9.9");

  const busy = list.find((entity) => entity.objectId === "busy");
  assert.equal(busy.component, "binary_sensor");
  assert.equal(busy.config.payload_on, "ON");
});

test("extended expire_after and the attributes topic are opt-in", () => {
  const withAttributes = entities({
    expireAfterSec: 900,
    includeAttributes: true,
  }).find((entity) => entity.objectId === "agent_state");
  assert.equal(withAttributes.config.expire_after, 900);
  assert.equal(
    withAttributes.config.json_attributes_topic,
    `${BASE}/${STATE_KEYS.attributes}`,
  );

  const tooLow = entities({ expireAfterSec: 5 }).find(
    (entity) => entity.objectId === "agent_state",
  );
  assert.equal(tooLow.config.expire_after, 30);
});
