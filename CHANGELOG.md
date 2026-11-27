# Changelog

All notable changes to this plugin are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions use `MAJOR.MINOR.PATCH`.

## 0.5.1 - 2026-11-22

### Fixed

- Prevent phantom `working` sessions from leaving Home Assistant stuck on
  "running": use `sessionId` as the stable key across `before_agent_run`,
  `after_tool_call` and `agent_end`, and stop creating session records from
  untracked tool callbacks.
- Add regression tests for untracked tool calls and canonical session keys
  (39 tests total).

### Documentation

- Install command now uses the published ClawHub owner
  (`clawhub:square-n/openclaw-state2mqtt`).

## 0.5.0 - 2026-11-22

### Changed

- Renamed the plugin id from `oc-ha-bridge` to `state2mqtt`.
- Package name is now `openclaw-state2mqtt`; display name is
  "OpenClaw Agent State → MQTT".
- Discovery `origin` and MQTT client-id prefix use the new identity.

### Added

- First public release on ClawHub (`square-n/openclaw-state2mqtt`).
- Source-linked GitHub repository `Square-N/openclaw-state2mqtt`.

## 0.4.1 - 2026-11-22

Pre-public hardening release.

### Security

- Reject credentials embedded in a broker URL; use `username` / `password`
  (SecretRef supported) so Settings can redact them.
- Reduce exec approval summaries to the program basename; collapse plugin and
  system-agent approvals to fixed labels. Tool arguments and operator prose
  are never published.
- Add `publishLastTool` to keep tool names off the broker; sanitize tool names
  and approval kinds.

### Fixed

- Derive port 8883 when TLS is enabled and no port is configured.
- Publish attributes when only approval details change.
- Keep an unconfigured bridge fully inert (no socket, timer or session table).
- Harden the dependency-free MQTT client: stale socket guards, TCP connect
  timeout, oversized payload protection, reconnect cleanup.
- Normalize string-valued config (`"false"`, numeric strings), broker URLs,
  topics and IPv6 host forms.
- Detect the `openclaw` CLI across npm-global/Homebrew/PATH and launch Windows
  `.cmd` shims correctly.
- Parse approval CLI output with a last-JSON-line fallback.
