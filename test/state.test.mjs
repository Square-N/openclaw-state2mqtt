import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentState,
  normalizeApprovalKind,
  redactApprovalSummary,
  sanitizeToolName,
} from "../lib/state.js";

function clock(start = 1000000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

test("priority: pending > working > error > idle", () => {
  const time = clock();
  const state = new AgentState({ now: time.now });

  assert.equal(state.snapshot().state, "idle");

  state.markWorking("s1");
  assert.equal(state.snapshot().state, "working");

  state.setPending(1);
  assert.equal(state.snapshot().state, "waiting_approval");

  state.setPending(0);
  state.finishTurn("s1", { success: true });
  assert.equal(state.snapshot().state, "idle");

  state.finishTurn("s1", { success: false });
  assert.equal(state.snapshot().state, "error");

  time.advance(120000);
  assert.equal(state.snapshot().state, "idle");
});

test("failed turn holds error for the configured window", () => {
  const time = clock();
  const state = new AgentState({ now: time.now, errorHoldMs: 5000 });
  state.finishTurn("s1", { success: false });
  assert.equal(state.snapshot().state, "error");
  assert.equal(state.errorExpiresAt, 1005000);

  time.advance(4999);
  assert.equal(state.snapshot().state, "error");
  time.advance(2);
  assert.equal(state.snapshot().state, "idle");
});

test("later successful turn clears a stale error", () => {
  const time = clock();
  const state = new AgentState({ now: time.now });
  state.finishTurn("s1", { success: false });
  assert.equal(state.snapshot().state, "error");
  state.finishTurn("s1", { success: true });
  assert.equal(state.snapshot().state, "idle");
  assert.equal(state.errorExpiresAt, 0);
});

test("crashed working session is swept after maxTurnAge", () => {
  const time = clock();
  const state = new AgentState({ now: time.now, maxTurnAgeMs: 60000 });
  state.markWorking("s1");
  assert.equal(state.snapshot().workingCount, 1);

  time.advance(59000);
  assert.equal(state.snapshot().state, "working");

  time.advance(2000);
  const snapshot = state.snapshot();
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.workingCount, 0);
});

test("late tool callback does not revive an old finished session", () => {
  const time = clock();
  const state = new AgentState({ now: time.now });
  state.markWorking("s1");
  state.finishTurn("s1", { success: true });

  assert.equal(state.isRecent("s1", 300000), true);
  time.advance(400000);
  assert.equal(state.isRecent("s1", 300000), false);

  state.markTool("s1", "exec");
  assert.equal(state.snapshot().state, "idle");
  assert.equal(state.lastTool, "exec");
});

test("idle session records are dropped after the TTL", () => {
  const time = clock();
  const state = new AgentState({ now: time.now, idleSessionTtlMs: 30000 });
  state.markWorking("s1", "exec");
  state.finishTurn("s1", { success: true });
  state.markWorking("s2");
  state.finishTurn("s2", { success: true });

  assert.equal(state.sessions.size, 2);
  time.advance(31000);
  state.sweep();
  assert.equal(state.sessions.size, 0);
});

test("duration falls back to the measured turn time", () => {
  const time = clock();
  const state = new AgentState({ now: time.now });
  state.markWorking("s1");
  time.advance(4500);
  state.finishTurn("s1", {});
  assert.equal(state.snapshot().lastTurnMs, 4500);

  state.markWorking("s1");
  time.advance(10);
  state.finishTurn("s1", { durationMs: 2500 });
  assert.equal(state.snapshot().lastTurnMs, 2500);
});

test("session list prefers working and recent entries", () => {
  const time = clock();
  const state = new AgentState({ now: time.now });
  state.markWorking("old");
  state.finishTurn("old", { success: true });
  time.advance(60000);
  state.markWorking("new");

  const list = state.sessionList(2).map(([key]) => key);
  assert.deepEqual(list, ["new", "old"]);
});

test("redactApprovalSummary keeps only the program name", () => {
  assert.equal(redactApprovalSummary({ summary: "rm -rf /tmp/build" }), "rm …");
  assert.equal(
    redactApprovalSummary({ command: "TOKEN=abc123 curl -H 'Authorization: Bearer x' https://x" }),
    "curl …",
  );
  assert.equal(redactApprovalSummary({ summary: "/usr/local/bin/docker compose up" }), "docker …");
  assert.equal(redactApprovalSummary({ summary: "\u0000\u0007" }), "approval");
  assert.equal(
    redactApprovalSummary({ summary: "A".repeat(60) }),
    `${"A".repeat(40)} …`,
  );
});

test("non-exec approvals never leak operator prose", () => {
  assert.equal(
    redactApprovalSummary({
      kind: "plugin",
      summary: "Personal notes: copy /home/alice/private.txt",
    }),
    "plugin approval",
  );
  assert.equal(
    redactApprovalSummary({ kind: "system-agent", summary: "SSH key rotation" }),
    "system approval",
  );
  assert.equal(
    redactApprovalSummary({ kind: "unexpected", summary: "secret value" }),
    "approval",
  );
  assert.equal(normalizeApprovalKind("EXEC"), "exec");
  assert.equal(normalizeApprovalKind("bogus"), "approval");
});

test("tool names are printable and bounded before publishing", () => {
  assert.equal(sanitizeToolName("exec\n\trm -rf /tmp/x"), "exec rm -rf /tmp/x");
  assert.equal(sanitizeToolName("\u0000\u0007"), "");
  assert.equal(sanitizeToolName("x".repeat(100)).length, 60);
});

test("pending counts are clamped to safe integers", () => {
  const state = new AgentState();
  state.setPending(-3);
  assert.equal(state.pendingApprovals, 0);
  state.setPending(Number.NaN);
  assert.equal(state.pendingApprovals, 0);
  state.setPending(2.8);
  assert.equal(state.pendingApprovals, 2);
});
