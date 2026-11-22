import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS,
  PLUGIN_VERSION,
  configSchema,
  needsShellForBin,
  normalizeConfig,
  resolveOpenclawBin,
} from "../lib/config.js";
import plugin from "../index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(`${root}/package.json`, "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(`${root}/openclaw.plugin.json`, "utf8"),
);

test("manifest, runtime schema and package version stay in sync", () => {
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.name, plugin.name);
  assert.deepEqual(manifest.configSchema, configSchema);
  assert.deepEqual(manifest.configSchema, plugin.configSchema);
  assert.equal(pkg.version, PLUGIN_VERSION);
  assert.equal(plugin.version, PLUGIN_VERSION);
  assert.equal(pkg.main, "./index.js");
  assert.deepEqual(pkg.openclaw.extensions, ["./index.js"]);
  for (const key of Object.keys(manifest.uiHints)) {
    assert.ok(manifest.configSchema.properties[key], `uiHint ${key} has no schema field`);
  }
});

test("defaults keep the bridge idle and derive the TLS port", () => {
  const { config, warnings } = normalizeConfig();
  assert.equal(config.host, "");
  assert.equal(config.port, 1883);
  assert.equal(config.tls, false);
  assert.equal(config.publishLastTool, true);
  assert.equal(config.rejectUnauthorized, true);
  assert.deepEqual(warnings, []);

  const secure = normalizeConfig({ host: "broker.local", tls: true }).config;
  assert.equal(secure.port, 8883);
});

test("string values from config set are coerced instead of trusted", () => {
  const { config } = normalizeConfig({
    host: "broker.local",
    tls: "false",
    rejectUnauthorized: "0",
    publishLastTool: "off",
    publishSessionDetails: "true",
    publishIntervalMs: "5000",
    approvalPollMs: "-5",
    port: "1884",
    keepaliveSec: "9999",
  });
  assert.equal(config.tls, false);
  assert.equal(config.rejectUnauthorized, false);
  assert.equal(config.publishLastTool, false);
  assert.equal(config.publishSessionDetails, true);
  assert.equal(config.publishIntervalMs, 5000);
  assert.equal(config.approvalPollMs, 0);
  assert.equal(config.port, 1884);
  assert.equal(config.keepaliveSec, 300);
});

test("broker URLs supply host/TLS/port but never credentials", () => {
  const { config, warnings } = normalizeConfig({
    host: "mqtts://user:secret@broker.example:8883/",
  });
  assert.equal(config.host, "broker.example");
  assert.equal(config.tls, true);
  assert.equal(config.port, 8883);
  assert.equal(config.username, "");
  assert.equal(config.password, "");
  assert.match(warnings.join("\n"), /credentials.*ignored/);

  const short = normalizeConfig({ host: "broker.local:1884" });
  assert.equal(short.config.host, "broker.local");
  assert.equal(short.config.port, 1884);

  assert.equal(normalizeConfig({ host: "broker.local", port: 0 }).config.port, 1883);
  const ipv6 = normalizeConfig({ host: "[::1]:1884" }).config;
  assert.equal(ipv6.host, "::1");
  assert.equal(ipv6.port, 1884);
});

test("unsafe topics and impossible hosts fall back instead of publishing", () => {
  const { config, warnings } = normalizeConfig({
    host: "broker.local/private",
    baseTopic: "openclaw/#",
    discoveryPrefix: "/ha/",
  });
  assert.equal(config.host, "");
  assert.equal(config.baseTopic, "");
  assert.equal(config.discoveryPrefix, "ha");
  assert.ok(warnings.length >= 2);

  const cleaned = normalizeConfig({ baseTopic: "/openclaw//gw/x/" }).config;
  assert.equal(cleaned.baseTopic, "openclaw/gw/x");
});

test("non-string secrets are refused rather than stringified", () => {
  const { config, warnings } = normalizeConfig({
    host: "broker.local",
    username: "u",
    password: { source: "env", id: "MQTT_PASS" },
  });
  assert.equal(config.password, "");
  assert.match(warnings.join("\n"), /not a plain string/);

  const orphan = normalizeConfig({ host: "broker.local", password: "x" });
  assert.match(orphan.warnings.join("\n"), /without a username/);
});

test("CLI discovery prefers explicit paths, then well-known dirs, then PATH", () => {
  const explicit = resolveOpenclawBin(
    { openclawBin: "/custom/openclaw" },
    { platform: "linux", env: {}, isFile: () => true },
  );
  assert.equal(explicit, "/custom/openclaw");

  const envBin = resolveOpenclawBin(
    {},
    { platform: "linux", env: { OPENCLAW_BIN: "/env/openclaw" }, isFile: () => true },
  );
  assert.equal(envBin, "/env/openclaw");

  const fromHome = resolveOpenclawBin(
    {},
    {
      platform: "linux",
      env: { HOME: "/home/u", PATH: "/nowhere" },
      isFile: (candidate) => candidate === "/home/u/.npm-global/bin/openclaw",
    },
  );
  assert.equal(fromHome, "/home/u/.npm-global/bin/openclaw");

  const fromPath = resolveOpenclawBin(
    {},
    {
      platform: "linux",
      env: { HOME: "", PATH: "/opt/tools:/usr/bin" },
      isFile: (candidate) => candidate === "/opt/tools/openclaw",
    },
  );
  assert.equal(fromPath, "/opt/tools/openclaw");

  const windows = resolveOpenclawBin(
    {},
    {
      platform: "win32",
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", PATH: "C:\\bin" },
      isFile: (candidate) => candidate.endsWith("\\openclaw.cmd"),
    },
  );
  assert.equal(windows, "C:\\Users\\u\\AppData\\Roaming\\npm\\openclaw.cmd");

  assert.equal(resolveOpenclawBin({}, { platform: "linux", env: {}, isFile: () => false }), "openclaw");
});

test("Windows shims are launched through a shell", () => {
  assert.equal(needsShellForBin("openclaw", "win32"), true);
  assert.equal(needsShellForBin("C:\\npm\\openclaw.cmd", "win32"), true);
  assert.equal(needsShellForBin("C:\\npm\\openclaw.exe", "win32"), false);
  assert.equal(needsShellForBin("openclaw", "linux"), false);
});

test("schema bounds match the documented defaults", () => {
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(configSchema.properties[key], `default ${key} missing from schema`);
  }
});
