// Minimal MQTT 3.1.1 publisher: no dependencies, QoS 0 only, retain supported.
// Enough for HA discovery + state publishing from inside the Gateway process.
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";

const MAX_PACKET_BYTES = 256 * 1024;
const MAX_TOPIC_BYTES = 65535;
const CONNECT_TIMEOUT_MS = 15000;

function encStr(value) {
  const buf = Buffer.from(String(value), "utf8");
  const out = Buffer.alloc(buf.length + 2);
  out.writeUInt16BE(buf.length, 0);
  buf.copy(out, 2);
  return out;
}

function encVarLen(n) {
  const parts = [];
  let v = n;
  do {
    let digit = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) digit |= 0x80;
    parts.push(digit);
  } while (v > 0);
  return Buffer.from(parts);
}

/**
 * Read an MQTT remaining-length varint.
 * Returns { status: "ok", value, next } | { status: "incomplete" } | { status: "malformed" }.
 * Incomplete means "wait for more bytes"; malformed means "drop the connection"
 * (a 4-byte varint with the continuation bit still set, or an oversized packet).
 */
export function readVarLen(buf, offset) {
  let multiplier = 1;
  let value = 0;
  let index = offset;
  for (let i = 0; i < 4; i += 1) {
    if (index >= buf.length) return { status: "incomplete" };
    const byte = buf[index];
    value += (byte & 0x7f) * multiplier;
    index += 1;
    if ((byte & 0x80) === 0) {
      if (value > MAX_PACKET_BYTES) return { status: "malformed" };
      return { status: "ok", value, next: index };
    }
    multiplier *= 128;
  }
  return { status: "malformed" };
}

/** Ping cadence: half the keepalive, never below 2s (broker windows are 1.5x). */
export function pingIntervalMs(keepaliveSec) {
  return Math.max(2000, (Number(keepaliveSec) / 2) * 1000);
}

export class MqttPublisher {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string} [opts.clientId]
   * @param {boolean} [opts.tls]
   * @param {boolean} [opts.rejectUnauthorized]
   * @param {string} [opts.willTopic]
   * @param {string} [opts.willPayload]
   * @param {boolean} [opts.willRetain]
   * @param {number} [opts.connackTimeoutMs]
   * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
   */
  constructor(opts) {
    this.host = opts.host;
    this.tls = Boolean(opts.tls);
    const configuredPort = Number(opts.port);
    this.port =
      Number.isFinite(configuredPort) && configuredPort > 0
        ? configuredPort
        : this.tls
          ? 8883
          : 1883;
    this.rejectUnauthorized = opts.rejectUnauthorized !== false;
    this.username = typeof opts.username === "string" ? opts.username : "";
    this.password = typeof opts.password === "string" ? opts.password : "";
    this.clientId =
      String(
        opts.clientId || `state2mqtt-${randomBytes(4).toString("hex")}`,
      ).slice(0, 64);
    this.willTopic = opts.willTopic || "";
    this.willPayload = opts.willPayload ?? "";
    this.willRetain = opts.willRetain !== false;
    const keepalive = Number(opts.keepaliveSec);
    this.keepaliveSec =
      Number.isFinite(keepalive) && keepalive >= 1
        ? Math.min(65535, Math.trunc(keepalive))
        : 60;
    const connackTimeout = Number(opts.connackTimeoutMs);
    this.connackTimeoutMs =
      Number.isFinite(connackTimeout) && connackTimeout >= 100
        ? Math.trunc(connackTimeout)
        : 8000;
    this.connectTimeoutMs = CONNECT_TIMEOUT_MS;
    this.log = opts.log || (() => {});
    this.socket = null;
    this.connected = false;
    this.closing = false;
    this.reconnectMs = 2000;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.connackTimer = null;
    this.connectTimer = null;
    this.rx = Buffer.alloc(0);
    this.onConnect = opts.onConnect || null;
    this.lastInboundAt = 0;
  }

  connect() {
    if (this.socket || this.closing) return;
    if (!this.host) {
      this.log("warn", "mqtt host is empty; not connecting");
      return;
    }
    if (this.password && !this.username) {
      this.log("warn", "mqtt password is set without a username; ignoring it");
    }
    const socket = this.tls
      ? tls.connect({
          host: this.host,
          port: this.port,
          rejectUnauthorized: this.rejectUnauthorized,
          servername: this.host,
        })
      : net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    // A TCP handshake to a dead-but-routable host can hang for minutes; bound
    // it so reconnect attempts stay bounded too.
    this.#clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket === socket && !this.connected) {
        this.log("warn", "mqtt connect timeout");
        this.#drop("connect timeout");
      }
    }, this.connectTimeoutMs);
    if (this.connectTimer.unref) this.connectTimer.unref();

    socket.on(this.tls ? "secureConnect" : "connect", () => {
      if (this.socket !== socket) return;
      this.log("debug", `mqtt tcp connected ${this.host}:${this.port}`);
      this.#clearConnectTimer();
      this.rx = Buffer.alloc(0);
      this.lastInboundAt = Date.now();
      try {
        socket.write(this.#buildConnect());
      } catch (err) {
        this.log("warn", `mqtt CONNECT packet could not be encoded: ${err?.message ?? err}`);
        this.#drop("connect encode failed");
        return;
      }
      // A broker that accepts TCP but never answers CONNECT must not hang us
      // forever: drop and retry instead of waiting on a half-open socket.
      this.#clearConnackTimer();
      this.connackTimer = setTimeout(() => {
        this.connackTimer = null;
        if (!this.connected) {
          this.log("warn", "mqtt CONNACK timeout");
          this.#drop("connack timeout");
        }
      }, this.connackTimeoutMs);
      if (this.connackTimer.unref) this.connackTimer.unref();
    });

    socket.on("data", (chunk) => {
      if (this.socket !== socket) return;
      this.lastInboundAt = Date.now();
      // Packets may arrive split across chunks or batched into one chunk,
      // so accumulate and cut complete packets out of a rolling buffer.
      this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
      this.#drainRx();
    });

    socket.on("error", (err) => {
      if (this.socket !== socket) return;
      // Initial connection failures are expected while retrying; do not flood.
      this.log(
        this.connected ? "warn" : "debug",
        `mqtt socket error: ${err?.message ?? err}`,
      );
    });
    // Guard by socket identity: a late close/end from an already-replaced
    // socket must not tear down the new connection.
    socket.on("close", () => {
      if (this.socket === socket) this.#drop("socket closed");
    });
    socket.on("end", () => {
      if (this.socket === socket) this.#drop("socket ended");
    });
  }

  publish(topic, payload, retain = true) {
    this.#write(topic, String(payload), retain);
  }

  /** Graceful shutdown: DISCONNECT so the broker does not fire the LWT. */
  end() {
    this.closing = true;
    this.#clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      // Graceful DISCONNECT keeps the broker from firing the LWT.
      try {
        if (this.connected) this.socket.write(Buffer.from([0xe0, 0x00]));
      } catch {
        /* ignore */
      }
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.connected = false;
  }

  #clearTimers() {
    for (const key of ["keepaliveTimer", "connackTimer", "connectTimer"]) {
      if (!this[key]) continue;
      if (key === "keepaliveTimer") clearInterval(this[key]);
      else clearTimeout(this[key]);
      this[key] = null;
    }
  }

  #clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  #clearConnackTimer() {
    if (this.connackTimer) {
      clearTimeout(this.connackTimer);
      this.connackTimer = null;
    }
  }

  #drainRx() {
    let offset = 0;
    let malformed = false;
    while (offset < this.rx.length) {
      if (this.rx.length - offset < 2) break;
      const lenInfo = readVarLen(this.rx, offset + 1);
      if (lenInfo.status === "incomplete") break;
      if (lenInfo.status === "malformed") {
        malformed = true;
        break;
      }
      const headerLen = 1 + (lenInfo.next - (offset + 1));
      const total = headerLen + lenInfo.value;
      if (this.rx.length - offset < total) break; // payload not fully arrived yet
      const packet = this.rx.subarray(offset, offset + total);
      this.#handlePacket(this.rx[offset] & 0xf0, packet);
      offset += total;
    }
    if (malformed) {
      this.rx = Buffer.alloc(0);
      this.log("warn", "mqtt sent a malformed packet header");
      this.#drop("malformed packet");
      return;
    }
    this.rx = offset >= this.rx.length ? Buffer.alloc(0) : this.rx.subarray(offset);
  }

  #handlePacket(type, packet) {
    if (type === 0x20) {
      // CONNACK: 0x20, len(2), session-flags, return-code
      const rc = packet.length >= 4 ? packet[3] : 1;
      if (!this.connected) {
        this.#clearConnackTimer();
        if (rc === 0) {
          this.connected = true;
          this.reconnectMs = 2000;
          this.log("info", "mqtt connected");
          this.#startKeepalive();
          if (this.onConnect) {
            // onConnect republishes authoritative discovery + state; there is
            // deliberately no replay of pre-disconnect payloads.
            try {
              this.onConnect();
            } catch (err) {
              this.log("warn", `mqtt onConnect failed: ${err?.message ?? err}`);
            }
          }
        } else {
          this.log("warn", `mqtt CONNACK refused rc=${rc}`);
          this.#drop("connack refused");
        }
      }
      return;
    }
    // PINGRESP (0xd0) and anything else: inbound activity alone satisfies the
    // half-open guard in #startKeepalive().
  }

  #buildConnect() {
    const flags =
      0x02 | // clean session
      (this.willTopic ? 0x04 | (this.willRetain ? 0x20 : 0x00) : 0x00) |
      (this.username ? 0x80 : 0x00) |
      (this.username && this.password ? 0x40 : 0x00);

    const keepalive = Buffer.alloc(2);
    keepalive.writeUInt16BE(this.keepaliveSec, 0);

    const parts = [
      encStr("MQTT"),
      Buffer.from([0x04]),
      Buffer.from([flags]),
      keepalive,
    ];
    parts.push(encStr(this.clientId));
    if (this.willTopic) {
      parts.push(encStr(this.willTopic), encStr(this.willPayload));
    }
    if (this.username) {
      parts.push(encStr(this.username));
      if (this.password) parts.push(encStr(this.password));
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([0x10]), encVarLen(body.length), body]);
  }

  #write(topic, payload, retain) {
    if (!this.socket || !this.connected || this.closing) return;
    if (
      !topic ||
      Buffer.byteLength(topic, "utf8") > MAX_TOPIC_BYTES ||
      Buffer.byteLength(payload, "utf8") > MAX_TOPIC_BYTES
    ) {
      this.log("warn", "mqtt publish skipped: topic or payload exceeds the packet limit");
      return;
    }
    let body;
    let header;
    try {
      body = Buffer.concat([encStr(topic), Buffer.from(payload, "utf8")]);
      header = Buffer.concat([
        Buffer.from([retain ? 0x31 : 0x30]),
        encVarLen(body.length),
      ]);
    } catch (err) {
      this.log("warn", `mqtt publish failed to encode: ${err?.message ?? err}`);
      return;
    }
    try {
      this.socket.write(Buffer.concat([header, body]));
    } catch (err) {
      this.log("warn", `mqtt publish failed: ${err?.message ?? err}`);
      this.#drop("write failed");
    }
  }

  #startKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    // Ping often enough that a broker timeout window (1.5 x keepalive) always
    // has a fresh request in flight, even at the schema minimum of 10s.
    const ms = pingIntervalMs(this.keepaliveSec);
    this.keepaliveTimer = setInterval(() => {
      if (!this.socket || !this.connected) return;
      // Half-open detection: no inbound bytes for 2 keepalive windows means the
      // connection is dead even if the kernel has not reported it yet.
      if (Date.now() - this.lastInboundAt > this.keepaliveSec * 2000) {
        this.log("warn", "mqtt ping timeout");
        this.#drop("ping timeout");
        return;
      }
      try {
        this.socket.write(Buffer.from([0xc0, 0x00]));
      } catch {
        this.#drop("ping write failed");
      }
    }, ms);
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  #drop(reason) {
    const wasConnected = this.connected;
    this.connected = false;
    this.#clearTimers();
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    if (this.closing) return;
    if (wasConnected) this.log("warn", `mqtt disconnected: ${reason}`);
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.reconnectTimer || this.closing) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) this.connect();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }
}
