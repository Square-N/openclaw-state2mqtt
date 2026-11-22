// Configuration contract for the bridge: defaults, schema and coercion.
//
// The gateway stores JSON, and `openclaw config set` can persist a value as a
// string (for example `tls=false`). Every consumer therefore reads the
// normalized result below instead of trusting `api.pluginConfig` shapes.
import fs from "node:fs";
import path from "node:path";

export const PLUGIN_VERSION = "0.5.1";

export const DEFAULTS = {
  host: "",
  // 0 means "derive from tls": 8883 for mqtts, 1883 for plain MQTT.
  port: 0,
  tls: false,
  rejectUnauthorized: true,
  username: "",
  password: "",
  discoveryPrefix: "homeassistant",
  baseTopic: "",
  instance: "",
  publishIntervalMs: 15000,
  approvalPollMs: 15000,
  openclawBin: "",
  publishSessionDetails: false,
  publishLastTool: true,
  keepaliveSec: 60,
  connackTimeoutMs: 8000,
  maxTurnAgeMs: 600000,
  idleSessionTtlMs: 3600000,
  sweepIntervalMs: 30000,
  expireAfterSec: 120,
  errorHoldMs: 120000,
};

const INT_LIMITS = {
  port: [1, 65535],
  publishIntervalMs: [2000, 300000],
  approvalPollMs: [0, 300000],
  keepaliveSec: [10, 300],
  connackTimeoutMs: [2000, 60000],
  maxTurnAgeMs: [60000, 21600000],
  idleSessionTtlMs: [60000, 86400000],
  sweepIntervalMs: [5000, 300000],
  expireAfterSec: [30, 3600],
  errorHoldMs: [10000, 3600000],
};

export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    host: {
      type: "string",
      description:
        "MQTT broker host or URL (mqtt:// / mqtts://). Empty keeps the bridge idle.",
    },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    tls: { type: "boolean", description: "Use MQTT over TLS (mqtts)" },
    rejectUnauthorized: {
      type: "boolean",
      description: "Verify the broker certificate when tls is on",
    },
    username: { type: "string" },
    password: {
      type: "string",
      description: "MQTT broker password (prefer a SecretRef; never commit it)",
    },
    discoveryPrefix: {
      type: "string",
      description: "HA MQTT discovery prefix (default homeassistant)",
    },
    baseTopic: {
      type: "string",
      description: "State topic root; empty = openclaw/gw/<instance>",
    },
    instance: {
      type: "string",
      description:
        "Display/instance name; set it when running more than one Gateway or when the hostname should not appear in MQTT topics",
    },
    publishIntervalMs: {
      type: "integer",
      minimum: 2000,
      maximum: 300000,
      description: "Heartbeat interval; also raises expire_after automatically",
    },
    approvalPollMs: {
      type: "integer",
      minimum: 0,
      maximum: 300000,
      description: "0 disables the pending-approval probe",
    },
    openclawBin: {
      type: "string",
      description:
        "Path to the openclaw CLI used for the approval probe; empty = auto-detect",
    },
    publishSessionDetails: {
      type: "boolean",
      description:
        "Publish hashed session ids and redacted tool names as state attributes",
    },
    publishLastTool: {
      type: "boolean",
      description:
        "Publish the most recent tool name. Turn off to keep tool usage off the broker",
    },
    keepaliveSec: { type: "integer", minimum: 10, maximum: 300 },
    connackTimeoutMs: { type: "integer", minimum: 2000, maximum: 60000 },
    maxTurnAgeMs: {
      type: "integer",
      minimum: 60000,
      maximum: 21600000,
      description:
        "A 'working' session with no activity for this long is treated as crashed",
    },
    idleSessionTtlMs: {
      type: "integer",
      minimum: 60000,
      maximum: 86400000,
      description: "Idle session records older than this are dropped from memory",
    },
    sweepIntervalMs: { type: "integer", minimum: 5000, maximum: 300000 },
    expireAfterSec: {
      type: "integer",
      minimum: 30,
      maximum: 3600,
      description:
        "HA marks entities unavailable if nothing arrives for this long",
    },
    errorHoldMs: { type: "integer", minimum: 10000, maximum: 3600000 },
  },
};

function toInt(value, fallback, min, max) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function toBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function toText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Strip surrounding slashes and collapse empty topic levels. */
export function cleanTopic(value) {
  const text = toText(value).replace(/\s+/g, "");
  return text.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

/** A publishable topic: non-empty, no wildcards, below the 64 KiB packet limit. */
export function isValidTopic(value) {
  const topic = String(value || "");
  return (
    topic.length > 0 &&
    topic.length <= 256 &&
    !topic.includes("\u0000") &&
    !/[#+]/.test(topic) &&
    !topic.startsWith("$")
  );
}

function parseBrokerUrl(raw, cfg, warnings) {
  const match = raw.match(/^(mqtt|mqtts|tcp|ssl):\/\//i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  let url;
  try {
    url = new URL(raw);
  } catch {
    warnings.push(`invalid broker URL: ${raw}`);
    return { invalid: true };
  }
  if (url.username || url.password) {
    warnings.push(
      "broker URL contains credentials; they are ignored. Use the username/password fields so Settings can redact them.",
    );
  }
  if (url.pathname && url.pathname !== "/") {
    warnings.push(`broker URL path "${url.pathname}" is ignored`);
  }
  if (url.search || url.hash) {
    warnings.push("broker URL query/fragment is ignored");
  }
  const host = url.hostname.replace(/^\[+|\]+$/g, "");
  if (!host) {
    warnings.push(`invalid broker URL host: ${raw}`);
    return { invalid: true };
  }
  const tls = scheme === "mqtts" || scheme === "ssl" ? true : cfg.tls;
  const urlPort = url.port ? Number(url.port) : 0;
  return {
    host,
    tls,
    port: urlPort > 0 ? urlPort : 0,
  };
}

/**
 * Coerce raw plugin config into the exact runtime shape.
 * Returns warnings instead of logging so callers can route them through the
 * plugin logger and tests can assert them.
 */
export function normalizeConfig(rawInput = {}) {
  const raw = rawInput && typeof rawInput === "object" ? rawInput : {};
  const warnings = [];
  const config = { ...DEFAULTS };

  for (const [key, [min, max]] of Object.entries(INT_LIMITS)) {
    config[key] = toInt(raw[key], DEFAULTS[key], min, max);
  }
  // port 0 (or a non-positive string) means "derive from tls", not port 1.
  const rawPort = Number(raw.port);
  if (raw.port != null && (!Number.isFinite(rawPort) || rawPort <= 0)) {
    config.port = 0;
  }
  for (const key of ["tls", "rejectUnauthorized", "publishSessionDetails", "publishLastTool"]) {
    config[key] = toBool(raw[key], DEFAULTS[key]);
  }

  const username = toText(raw.username);
  const password = typeof raw.password === "string" ? raw.password : "";
  if (raw.password != null && typeof raw.password !== "string") {
    warnings.push("password is not a plain string; ignoring it");
  }
  config.username = username;
  config.password = password;
  if (config.password && !config.username) {
    warnings.push("password is set without a username; the broker will not receive it");
  }

  let host = toText(raw.host);
  let portFromUrl = 0;
  if (host) {
    const parsed = parseBrokerUrl(host, config, warnings);
    if (parsed?.invalid) {
      host = "";
    } else if (parsed) {
      host = parsed.host;
      config.tls = parsed.tls;
      portFromUrl = parsed.port;
    }
    const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(host);
    if (bracketed) {
      host = bracketed[1];
      portFromUrl = Number(bracketed[2]);
    } else {
      host = host.replace(/^\[+|\]+$/g, "");
    }
    // Accept the common "broker:1883" form, but never split an IPv6 literal.
    const hostWithPort = !matchScheme(host) && /^([^:/]+):(\d+)$/.exec(host);
    if (hostWithPort) {
      const [, name, port] = hostWithPort;
      host = name;
      portFromUrl = Number(port);
    }
    if (host && (host.includes("/") || /\s/.test(host) || host.includes("://"))) {
      warnings.push(`invalid broker host "${host}"; the bridge will stay idle`);
      host = "";
    }
  }
  config.host = host;
  if (!config.port) {
    config.port = portFromUrl || (config.tls ? 8883 : 1883);
  }

  const prefix = cleanTopic(raw.discoveryPrefix);
  if (raw.discoveryPrefix != null && String(raw.discoveryPrefix).trim() === "") {
    config.discoveryPrefix = "homeassistant";
  } else if (prefix && isValidTopic(prefix)) {
    config.discoveryPrefix = prefix;
  } else {
    if (prefix) warnings.push(`invalid discoveryPrefix "${raw.discoveryPrefix}"; using homeassistant`);
    config.discoveryPrefix = "homeassistant";
  }

  const baseTopic = cleanTopic(raw.baseTopic);
  if (baseTopic && isValidTopic(baseTopic)) {
    config.baseTopic = baseTopic;
  } else {
    if (baseTopic) warnings.push(`invalid baseTopic "${raw.baseTopic}"; using the default`);
    config.baseTopic = "";
  }

  config.instance = typeof raw.instance === "string" ? raw.instance : "";
  config.openclawBin = toText(raw.openclawBin);

  return { config, warnings };
}

const WINDOWS_BIN_EXT = [".cmd", ".exe", ""];

function fileExists(candidate, isFile) {
  try {
    return isFile(candidate);
  } catch {
    return false;
  }
}

/**
 * Locate the openclaw CLI without assuming one install layout.
 * `openclawBin`, then `OPENCLAW_BIN`, then well-known global prefixes, then PATH.
 */
export function resolveOpenclawBin(
  cfg = {},
  {
    platform = process.platform,
    env = process.env,
    isFile = (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  } = {},
) {
  const explicit = toText(cfg.openclawBin) || toText(env.OPENCLAW_BIN);
  if (explicit) return explicit;

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const exts = platform === "win32" ? WINDOWS_BIN_EXT : [""];
  const home = toText(env.HOME) || toText(env.USERPROFILE);
  const knownDirs = [
    home ? pathApi.join(home, ".npm-global", "bin") : "",
    home ? pathApi.join(home, ".local", "bin") : "",
    platform === "win32" && env.APPDATA ? pathApi.join(env.APPDATA, "npm") : "",
    platform === "win32" && env.ProgramFiles ? pathApi.join(env.ProgramFiles, "nodejs") : "",
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
  ].filter(Boolean);

  const pathDirs = String(env.PATH || env.Path || "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);

  for (const dir of [...knownDirs, ...pathDirs]) {
    for (const ext of exts) {
      const candidate = pathApi.join(dir, `openclaw${ext}`);
      if (fileExists(candidate, isFile)) return candidate;
    }
  }
  return "openclaw";
}

/** Windows requires a shell to launch .cmd/.bat shims. */
export function needsShellForBin(bin, platform = process.platform) {
  // CreateProcess does not apply PATHEXT: any non-.exe shim (bare name,
  // .cmd or .bat) needs cmd.exe on Windows.
  return platform === "win32" && !/\.(exe|com)$/i.test(String(bin || ""));
}

function matchScheme(value) {
  return /^(mqtt|mqtts|tcp|ssl):\/\//i.test(value);
}
