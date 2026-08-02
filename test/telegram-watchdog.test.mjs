import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_STALE_MS,
  decideBridgeAction,
  readHeartbeat,
  verifyRestart
} from "../src/telegram/watchdog.mjs";

const NOW_MS = Date.parse("2026-08-02T13:00:00.000Z");
const STALE_MS = 900_000;

test("decideBridgeAction restarts when the bridge process is missing", () => {
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS,
    nowMs: NOW_MS,
    processAlive: false,
    staleMs: STALE_MS
  }), { restart: true, reason: "process-missing" });
});

test("decideBridgeAction waits when a running bridge has no valid heartbeat yet", () => {
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: null,
    nowMs: NOW_MS,
    processAlive: true,
    staleMs: STALE_MS
  }), { restart: false, reason: "no-heartbeat-yet" });
});

test("decideBridgeAction keeps a running bridge with a fresh heartbeat", () => {
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS - STALE_MS + 1,
    nowMs: NOW_MS,
    processAlive: true,
    staleMs: STALE_MS
  }), { restart: false, reason: "healthy" });
});

test("decideBridgeAction restarts a running bridge with a stale heartbeat", () => {
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS - STALE_MS - 1,
    nowMs: NOW_MS,
    processAlive: true,
    staleMs: STALE_MS
  }), { restart: true, reason: "heartbeat-stale" });
});

test("decideBridgeAction includes the stale boundary and restarts one millisecond after it", () => {
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS - STALE_MS,
    nowMs: NOW_MS,
    processAlive: true,
    staleMs: STALE_MS
  }), { restart: false, reason: "healthy" });
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS - STALE_MS - 1,
    nowMs: NOW_MS,
    processAlive: true,
    staleMs: STALE_MS
  }), { restart: true, reason: "heartbeat-stale" });
});

test("decideBridgeAction gives a missing process priority over a fresh heartbeat", () => {
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS,
    nowMs: NOW_MS,
    processAlive: false,
    staleMs: STALE_MS
  }), { restart: true, reason: "process-missing" });
});

test("decideBridgeAction uses only heartbeat health when process state is unavailable", () => {
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS,
    nowMs: NOW_MS,
    processAlive: null,
    staleMs: STALE_MS
  }), { restart: false, reason: "healthy" });
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS - STALE_MS - 1,
    nowMs: NOW_MS,
    processAlive: null,
    staleMs: STALE_MS
  }), { restart: true, reason: "heartbeat-stale" });
});

test("readHeartbeat returns null for missing, malformed, and non-numeric heartbeats", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-bridge-watchdog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const missing = path.join(root, "missing.json");
  const malformed = path.join(root, "malformed.json");
  const nonNumeric = path.join(root, "non-numeric.json");
  fs.writeFileSync(malformed, "{broken", "utf8");
  fs.writeFileSync(nonNumeric, JSON.stringify({ atMs: "123" }), "utf8");

  assert.equal(readHeartbeat(missing), null);
  assert.equal(readHeartbeat(malformed), null);
  assert.equal(readHeartbeat(nonNumeric), null);
});

test("readHeartbeat returns a finite numeric timestamp", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-bridge-watchdog-valid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "heartbeat.json");
  fs.writeFileSync(file, JSON.stringify({ atMs: NOW_MS, ignored: true }), "utf8");

  assert.deepEqual(readHeartbeat(file), { atMs: NOW_MS });
});

test("the default stale threshold cannot regress below 15 minutes", () => {
  assert.ok(DEFAULT_STALE_MS >= 900_000);
  assert.deepEqual(decideBridgeAction({
    heartbeatAtMs: NOW_MS - DEFAULT_STALE_MS,
    nowMs: NOW_MS,
    processAlive: true
  }), { restart: false, reason: "healthy" });
});

test("verifyRestart reports an unverifiable non-Windows process state", () => {
  assert.deepEqual(verifyRestart({
    beforePids: null,
    afterPids: null
  }), { ok: false, reason: "unverifiable" });
});

test("verifyRestart reports a bridge that is not running", () => {
  assert.deepEqual(verifyRestart({
    beforePids: [101],
    afterPids: []
  }), { ok: false, reason: "not-running" });
});

test("verifyRestart rejects an after-set containing only old PIDs", () => {
  assert.deepEqual(verifyRestart({
    beforePids: [101, 202],
    afterPids: [202]
  }), { ok: false, reason: "not-restarted" });
});

test("verifyRestart accepts an after-set containing a new PID", () => {
  assert.deepEqual(verifyRestart({
    beforePids: [101, 202],
    afterPids: [303]
  }), { ok: true, reason: "restarted" });
});

test("verifyRestart does not regress to checking only whether a process exists", () => {
  // Regression guard for this bug: PID 15920 survived, so no restart occurred.
  assert.deepEqual(verifyRestart({
    beforePids: [15920],
    afterPids: [15920]
  }), { ok: false, reason: "not-restarted" });
});
