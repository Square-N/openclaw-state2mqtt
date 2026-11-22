// Pure agent-state machine: no host APIs, no network, injectable clock.
// Kept separate from index.js so it can be unit-tested with node:test.

export const AGENT_STATES = ["idle", "working", "waiting_approval", "error"];

export class AgentState {
  constructor({
    maxTurnAgeMs = 1800000,
    idleSessionTtlMs = 3600000,
    errorHoldMs = 120000,
    now = () => Date.now(),
    log = () => {},
  } = {}) {
    this.maxTurnAgeMs = maxTurnAgeMs;
    this.idleSessionTtlMs = idleSessionTtlMs;
    this.errorHoldMs = errorHoldMs;
    this.now = now;
    this.log = log;
    this.sessions = new Map();
    this.pendingApprovals = 0;
    this.lastTool = "none";
    this.lastTurnMs = 0;
    this.errorUntil = 0;
  }

  /** Mark a session as running. `toolName` also updates the global "last tool". */
  markWorking(key, toolName) {
    const id = key || "default";
    const now = this.now();
    const existing = this.sessions.get(id) || {
      working: false,
      startedAt: 0,
      lastActivityAt: 0,
      lastTool: "",
    };
    if (!existing.working) existing.startedAt = now;
    existing.working = true;
    existing.lastActivityAt = now;
    if (toolName) existing.lastTool = toolName;
    this.sessions.set(id, existing);
    if (toolName) this.lastTool = toolName;
    return existing;
  }

  /** True when the session saw activity inside the revive window (late callbacks). */
  isRecent(key, windowMs = 300000) {
    const existing = this.sessions.get(key || "default");
    if (!existing) return false;
    return this.now() - existing.lastActivityAt < windowMs;
  }

  /** True when the session is currently marked working. */
  isWorking(key) {
    const existing = this.sessions.get(key || "default");
    return Boolean(existing?.working);
  }

  /** Update the last-tool fields without changing working state. */
  markTool(key, toolName) {
    if (!toolName) return;
    this.lastTool = toolName;
    const existing = this.sessions.get(key || "default");
    if (existing) existing.lastTool = toolName;
  }

  /** Finish a turn. A failed turn holds `error` for errorHoldMs. */
  finishTurn(key, { durationMs, success } = {}) {
    const id = key || "default";
    const now = this.now();
    const existing = this.sessions.get(id);
    if (existing) {
      existing.working = false;
      existing.lastActivityAt = now;
      if (typeof durationMs === "number" && durationMs > 0) {
        this.lastTurnMs = durationMs;
      } else if (existing.startedAt) {
        this.lastTurnMs = now - existing.startedAt;
      }
    } else if (typeof durationMs === "number" && durationMs > 0) {
      this.lastTurnMs = durationMs;
    }
    if (success === false) {
      this.errorUntil = now + this.errorHoldMs;
    } else if (success === true && this.errorUntil) {
      this.errorUntil = 0;
    }
  }

  endSession(key) {
    if (key) this.sessions.delete(key);
  }

  setPending(count) {
    const number = Number(count);
    this.pendingApprovals = Number.isFinite(number)
      ? Math.max(0, Math.trunc(number))
      : 0;
  }

  get errorExpiresAt() {
    return this.errorUntil || 0;
  }

  /**
   * Drop crashed working sessions (no activity for maxTurnAgeMs) and idle
   * sessions nobody will reference again. Returns true when state changed.
   */
  sweep() {
    const now = this.now();
    let changed = false;
    for (const [key, session] of this.sessions) {
      if (session.working && now - session.lastActivityAt > this.maxTurnAgeMs) {
        session.working = false;
        changed = true;
        this.log(
          "warn",
          `session ${shortKey(key)}: no activity for ${Math.round(
            this.maxTurnAgeMs / 60000,
          )} min; treating the turn as crashed`,
        );
      }
      if (!session.working && now - session.lastActivityAt > this.idleSessionTtlMs) {
        this.sessions.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Resolve the aggregate state. Sweeps stale sessions first. */
  snapshot() {
    this.sweep();
    let workingCount = 0;
    for (const session of this.sessions.values()) {
      if (session.working) workingCount += 1;
    }
    const anyWorking = workingCount > 0;
    let state = "idle";
    if (this.pendingApprovals > 0) state = "waiting_approval";
    else if (anyWorking) state = "working";
    else if (this.errorUntil > this.now()) state = "error";
    return {
      state,
      anyWorking,
      workingCount,
      busy: anyWorking || this.pendingApprovals > 0,
      pendingApprovals: this.pendingApprovals,
      lastTool: this.lastTool || "none",
      lastTurnMs: this.lastTurnMs,
      errorActive: this.errorUntil > this.now(),
    };
  }

  /** Sessions for the optional attribute payload, most relevant first. */
  sessionList(limit = 12) {
    return [...this.sessions.entries()]
      .sort((a, b) => {
        if (a[1].working !== b[1].working) return a[1].working ? -1 : 1;
        return b[1].lastActivityAt - a[1].lastActivityAt;
      })
      .slice(0, limit)
      .map((entry) => entry);
  }
}

function shortKey(key) {
  const text = String(key || "");
  return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}

/** Tool names are host-controlled, but still keep payloads printable and bounded. */
export function sanitizeToolName(value, maxLength = 60) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength);
}

const APPROVAL_KINDS = new Set(["exec", "plugin", "system-agent"]);

export function normalizeApprovalKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  return APPROVAL_KINDS.has(kind) ? kind : "approval";
}

/**
 * Redact a pending approval down to what HA actually needs.
 *
 * Exec approvals carry the raw command (possibly with paths, hostnames or
 * inline credentials), so only the first executable token's basename is kept.
 * Plugin/system-agent approvals carry free-form prose, so those collapse to a
 * fixed label instead of leaking an operator-authored title.
 */
export function redactApprovalSummary(item, maxLength = 40) {
  const kind = item?.kind == null ? "exec" : normalizeApprovalKind(item.kind);
  if (kind !== "exec") {
    if (kind === "plugin") return "plugin approval";
    if (kind === "system-agent") return "system approval";
    return "approval";
  }

  const raw = String(item?.summary ?? item?.command ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  if (!raw || raw.startsWith("(")) return "approval";

  const head =
    raw
      .split(/\s+/)
      .find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) || "";
  const base = head.split("/").pop() || "";
  const safe = base.replace(/[^A-Za-z0-9._+-]/g, "");
  if (!safe) return "approval";
  return `${safe.slice(0, maxLength)} …`;
}
