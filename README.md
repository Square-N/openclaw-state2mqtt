# OpenClaw Agent State → MQTT

Publish [OpenClaw](https://github.com/openclaw/openclaw) agent state to MQTT, with Home Assistant MQTT Discovery built in. Any MQTT consumer can subscribe; HA creates the entities automatically, with no custom integration, no `configuration.yaml` edit and no restart.

| Entity | Values |
|---|---|
| `sensor.openclaw_gateway_agent_state` | `idle` / `working` / `waiting_approval` / `error` (enum) |
| `binary_sensor.openclaw_gateway_agent_busy` | `on` when working or waiting for approval |
| `sensor.openclaw_gateway_active_sessions` | running sessions |
| `sensor.openclaw_gateway_pending_approvals` | pending approval requests |
| `sensor.openclaw_gateway_last_tool` | most recent tool name (`hidden` when disabled) |
| `sensor.openclaw_gateway_last_turn_duration` | previous turn duration (s) |

Priority: `waiting_approval` > `working` > `error` > `idle`.

## Requirements

- OpenClaw Gateway **2026.11.3 or newer** (the only version this release is tested against; plugin APIs are experimental)
- Home Assistant with the **MQTT** integration and a reachable broker
- Node 24.16+ (already provided by the Gateway; external plugins run inside it)

## Install

```bash
# from ClawHub
openclaw plugins install clawhub:square-n/openclaw-state2mqtt

# or from a local checkout
openclaw plugins install -l /path/to/state2mqtt --force
```

Then point it at your broker and allow conversation hooks:

```bash
openclaw config set plugins.entries.state2mqtt.config.host 192.168.1.10
openclaw config set plugins.entries.state2mqtt.config.username mqtt-user
openclaw config set plugins.entries.state2mqtt.config.password '<broker password>'
openclaw config set plugins.entries.state2mqtt.hooks.allowConversationAccess true
```

`allowConversationAccess` is required: without it the host blocks `agent_end` and the other conversation hooks for non-bundled plugins.

With no `host` configured the bridge stays completely idle: no socket, no timers, no session table. It logs one warning and does nothing else.

### Certificate and secret handling

`password` is a declared secret input, so Settings and `openclaw secrets` can redact or replace it with a SecretRef. A password embedded in a `mqtt://user:pass@host` URL is **ignored with a warning** — it would otherwise sit in a non-secret config field.

For a self-signed LAN broker, set `rejectUnauthorized: false` only when you control the network path:

```bash
openclaw config set plugins.entries.state2mqtt.config.tls true
openclaw config set plugins.entries.state2mqtt.config.rejectUnauthorized false
```

## Configuration

| Key | Default | Notes |
|---|---|---|
| `host` | `""` | Hostname, IP, `host:port`, or an `mqtt://` / `mqtts://` URL. Empty = idle. |
| `port` | `1883` (`8883` with TLS) | Explicit value wins; a port in `host` is used otherwise. |
| `tls` / `rejectUnauthorized` | `false` / `true` | MQTT over TLS; certificate verification stays on by default. |
| `username` / `password` | `""` | Password is a declared secret input; URL credentials are rejected. |
| `discoveryPrefix` | `homeassistant` | HA MQTT discovery prefix. |
| `baseTopic` | `openclaw/gw/<instance>` | State topic root. |
| `instance` | hostname | Display name and topic identity. Set it for multiple Gateways, or to keep the hostname off MQTT topics. |
| `publishIntervalMs` | `15000` | Heartbeat; `expire_after` is raised automatically to stay above it. |
| `approvalPollMs` | `15000` | Pending-approval probe interval; `0` disables it. |
| `openclawBin` | auto-detect | CLI path for the approval probe. `OPENCLAW_BIN` and PATH are also checked. |
| `publishSessionDetails` | `false` | Adds hashed session ids (8 hex chars) and tool names as state attributes. |
| `publishLastTool` | `true` | Set `false` to publish `hidden` instead of tool names. |
| `keepaliveSec` | `60` | MQTT keepalive. |
| `connackTimeoutMs` | `8000` | Drop a half-open TCP connection that never sends CONNACK. |
| `maxTurnAgeMs` | `600000` | A `working` session silent this long is treated as crashed. |
| `idleSessionTtlMs` | `3600000` | Idle session records dropped after this. |
| `sweepIntervalMs` | `30000` | Session sweep cadence. |
| `expireAfterSec` | `120` | HA marks entities unavailable when nothing arrives; auto-raised to cover the heartbeat. |
| `errorHoldMs` | `120000` | How long a failed turn keeps `error`. |

Config values are normalized at startup: numeric strings, `"true"`/`"false"`, `/slashes/` in topics and invalid ports are handled without a crash. Invalid topics or an unusable host disable the bridge instead of publishing somewhere unexpected.

## Privacy and what leaves the machine

The bridge publishes **only aggregate agent metadata**. It never publishes prompts, model output, message bodies, tool arguments, tool results, file paths or transcripts.

Published by default:

- the four state values, busy flag, active session count, pending approval count;
- the most recent **tool name** (`publishLastTool: false` removes it);
- the last turn duration;
- availability (`online` / `offline`) and HA discovery configs.

Optional (`publishSessionDetails: true`):

- an 8-character **hash** of each session key (not the key itself) and the last tool name per session.

Approvals: the probe reads `openclaw approvals pending --json` and reduces each item to a type plus, for exec approvals, the **program basename** (for example `rm …`). Plugin and system-agent approvals collapse to `plugin approval` / `system approval`. Arguments and operator-authored descriptions are never published.

Identity: when `instance` is unset, the Gateway **hostname** becomes the MQTT topic suffix (`openclaw/gw/<hostname>`) and part of every `unique_id`. On a shared or cloud broker, set a neutral `instance` first:

```bash
openclaw config set plugins.entries.state2mqtt.config.instance home
```

Transport: plain MQTT is unencrypted. Use `tls: true` plus broker authentication, and restrict broker ACLs so only the Gateway can write `openclaw/gw/#` and only HA can read it. State and discovery payloads are **retained**, so they survive a broker restart and are visible to anyone allowed to subscribe.

## Multiple Gateways

`instance` is the identity of one Gateway. It drives three things at once:

- the base topic suffix: `openclaw/gw/<instance>`
- the discovery node id and every `unique_id`: `oc_gw_<instance>`
- the Home Assistant device name: `OpenClaw Gateway (<instance>)`

| Situation | What happens | What to do |
|---|---|---|
| Several Gateways on **different hosts**, `instance` unset | Topics and node ids differ by hostname, so nothing collides. Every device is named "OpenClaw Gateway", so HA appends `_2`, `_3` to later entity ids. | Set a distinct `instance` per Gateway so entity ids stay predictable. |
| Several Gateways on **one host** (different profiles, ports or `OPENCLAW_STATE_DIR`), `instance` unset | The hostname is identical, so `baseTopic`, `deviceId` and `unique_id` all collide. Two publishers fight over the same retained topics. | **Required:** set a distinct `instance` for each Gateway. |
| Custom `baseTopic` with the same `instance` | Topic paths differ, but `unique_id` still collides; HA silently ignores the second entity. | Change `instance` too, not just `baseTopic`. |

Example — two Gateways on one machine:

```bash
# Gateway A
openclaw config set plugins.entries.state2mqtt.config.instance home
# Gateway B (its own state dir / port)
openclaw config set plugins.entries.state2mqtt.config.instance lab
```

This yields `openclaw/gw/home` + `openclaw/gw/lab`, two devices, and no `_2` suffixes.

Changing `instance` later creates a **new** device. The old retained discovery configs remain on the broker until their topics are cleared, so HA may keep the old entities around. See Troubleshooting.

## How it works

- **Hooks**: `before_agent_run` opens a session (the turn-admission gate, so auxiliary model calls such as title generation cannot create phantom sessions), `after_tool_call` refreshes activity and the tool name, `agent_end` finishes the turn (duration, error window), `session_start` / `session_end` maintain the session table. The gate handler never throws and never returns a decision, so a broken bridge cannot block a turn; every other handler swallows and logs its own errors.
- **Discovery**: retained configs under `<prefix>/<component>/<device>/<entity>/config`, an availability topic with an MQTT LWT, and `expire_after` as the graceful-stop fallback.
- **Approvals**: the in-process RPC surface is admin-scoped and rejects external plugins, so the bridge runs a bounded `openclaw approvals pending --json` probe — only while a turn is running or a request is known to be pending. The child is killed on reload and capped at 3 s.
- **MQTT client**: dependency-free MQTT 3.1.1 QoS 0. Handles split/batched packets, malformed varints, CONNACK and TCP connect timeouts, half-open sockets, stale socket callbacks, reconnects with backoff, and payload size limits.
- **Single instance**: `register()` is inert for discovery/metadata registrations, and a process-wide symbol disposes a previous instance before a new one starts. This prevents the classic double-publisher flapping.
- **Idle safety**: an unconfigured bridge registers hooks for inspection but creates no socket, timer or session record.

## Troubleshooting

| Symptom | Check |
|---|---|
| Entities never appear | `openclaw config get plugins.entries.state2mqtt.config.host`; broker reachable; discovery prefix matches HA. |
| Entities flap `unavailable` | `publishIntervalMs` must stay below `expireAfterSec`; the plugin raises `expire_after` automatically, but check the retained discovery payload. |
| `hookCount: 0` in `plugins inspect --runtime` | Hooks register in discovery mode too; if zero, the plugin failed to load. |
| No `waiting_approval` | Approvals need `tools.exec` ask mode; with full access there is nothing to wait for. |
| Approval count never updates | Set `openclawBin` explicitly. On Windows the probe needs a shell wrapper for `.cmd` shims; auto-detection checks `%APPDATA%\npm` and PATH. |
| Hostname visible in topics | Set a neutral `instance`, then clear the old retained discovery/state topics. |
| Old entities after changing `instance` | Publish an empty retained payload to the old `homeassistant/<component>/oc_gw_<old>/<entity>/config` topics, or remove the device in HA. |
| Logs | `journalctl --user -u openclaw-gateway.service -n 50 --no-pager \| grep state2mqtt` |

Clearing one old entity with `mosquitto_pub` (repeat per entity/component):

```bash
mosquitto_pub -h <broker> -r -n \
  -t 'homeassistant/sensor/oc_gw_old_instance/agent_state/config'
```

## Automation examples

```yaml
- alias: "Agent still working late"
  trigger:
    - platform: state
      entity_id: binary_sensor.openclaw_gateway_agent_busy
      to: "on"
      for: "00:30:00"
  condition:
    - condition: time
      after: "23:00:00"
  action:
    - service: notify.mobile_app_phone
      data:
        message: "The agent is still running a task"
```

```yaml
- alias: "Approval waiting too long"
  trigger:
    - platform: numeric_state
      entity_id: sensor.openclaw_gateway_pending_approvals
      above: 0
      for: "00:05:00"
  action:
    - service: notify.mobile_app_phone
      data:
        message: "An OpenClaw tool call is waiting for approval"
```

## Tests

```bash
npm test   # node --test, no external dependencies
```

37 tests cover the state machine (priority, stale sweep, error window, pending clamp), MQTT framing (split/batched CONNACK, malformed varint, CONNACK timeout, oversized payloads), config coercion (URL credentials, string booleans, topic safety, binary discovery), HA discovery payloads, approval redaction, and a live registration against a local mock broker.

## 中文说明

把 OpenClaw 的 agent 状态通过 **MQTT Discovery** 发布成 Home Assistant 实体，HA 侧不需要装自定义集成、不需要改 `configuration.yaml`、不需要重启。

- 状态来源：插件 hook（`before_agent_run` / `after_tool_call` / `agent_end` / `session_start` / `session_end`）。用 turn 准入钩子而不是通用 model-call 钩子，避免标题生成、记忆写入这类辅助模型调用在没有 `agent_end` 的情况下把会话标成 working。除准入钩子外全部 observe-only；准入钩子不抛错、不返回值，不会阻断对话。
- 待审批：仅在有会话运行或已知有挂起请求时，用 `openclaw approvals pending --json` 探测；exec 审批只发程序名，plugin/system-agent 审批只发固定标签，参数和描述不外传。
- 可靠性：单实例保护（discovery 模式注册完全惰性）、无 host 时零 socket/零定时器/零会话表、会话活性超时、MQTT CONNECT/CONNACK 超时、分片/畸形包处理、陈旧 socket 回调隔离、LWT + `expire_after` 兜底。
- 隐私：默认只发状态、忙碌标志、会话数、审批数、最近工具名、上轮耗时。`publishLastTool: false` 可关闭工具名；`publishSessionDetails` 默认关闭，开启后只发 8 位会话哈希。**不发送**提示词、回复、消息正文、工具参数/结果、文件路径或转录。
- 身份：不设 `instance` 时，主机名会进入 MQTT topic 和 `unique_id`；共享 broker 上建议先设一个中性名字。

**多网关**：`instance` 同时决定 topic 后缀（`openclaw/gw/<instance>`）、discovery node id 和 `unique_id`（`oc_gw_<instance>`）、以及 HA 设备名。所以每台网关都设一个不同的 `instance` 就够了。不设的话：跨主机会因为 hostname 不同而不撞 topic，但设备名全叫 "OpenClaw Gateway"，第二个的实体 ID 会被加 `_2`；同一台主机跑多个网关则会**完全撞车**（两个 publisher 抢同一批 retained topic）。只改 `baseTopic` 不改 `instance` 也不行——`unique_id` 仍然冲突，HA 会静默忽略第二个实体。

安装后必须设置 `plugins.entries.state2mqtt.hooks.allowConversationAccess: true`，否则宿主会拦掉 `agent_end` 等会话 hook。`password` 在 `host` URL 里会被忽略并给出警告，请用 `username` / `password` 字段（支持 SecretRef）。

## Maintainer notes

ClawHub publication expects package metadata, this manifest, setup docs, an active owner, and a public source repository. The package has no `author` / `repository` fields on purpose; add them only after the public repo exists. Bump `version` in `package.json` and `PLUGIN_VERSION` in `lib/config.js` together — the test suite fails if they drift.

## License

MIT. Not affiliated with OpenClaw or Home Assistant.
