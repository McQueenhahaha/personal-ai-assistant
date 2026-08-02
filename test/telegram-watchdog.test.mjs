import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_STALE_MS,
  buildStopBridgeCommand,
  buildSupervisorProcessCheckCommand,
  decideBridgeAction,
  decideBridgeOwnership,
  ensureSupervisorRunning,
  readHeartbeat,
  reconcileBridgeOwnership,
  verifyRestart
} from "../src/telegram/watchdog.mjs";

const NOW_MS = Date.parse("2026-08-02T13:00:00.000Z");
const STALE_MS = 900_000;

function makeLease(holder, heartbeatAtMs = NOW_MS, ttlSeconds = 90) {
  return {
    holder,
    heartbeatAt: new Date(heartbeatAtMs).toISOString(),
    ttlSeconds,
    reason: "renew"
  };
}

test("decideBridgeOwnership runs locally in single-node mode", () => {
  assert.deepEqual(decideBridgeOwnership({
    selfId: "windows",
    lease: null,
    nowMs: NOW_MS,
    peerConfigured: false
  }), { shouldRunLocally: "yes", reason: "single-node" });
});

test("decideBridgeOwnership runs locally for a fresh self-held lease", () => {
  assert.deepEqual(decideBridgeOwnership({
    selfId: "windows",
    lease: makeLease("windows", NOW_MS - 89_000),
    nowMs: NOW_MS,
    peerConfigured: true
  }), { shouldRunLocally: "yes", reason: "self-holds-lease" });
});

test("decideBridgeOwnership refuses local bridge for a fresh peer-held lease", () => {
  assert.deepEqual(decideBridgeOwnership({
    selfId: "windows",
    lease: makeLease("mac", NOW_MS - 89_000),
    nowMs: NOW_MS,
    peerConfigured: true
  }), { shouldRunLocally: "no", reason: "peer-holds-lease" });
});

test("decideBridgeOwnership defers an expired self-held lease", () => {
  // Windows 深冻结醒来时本地仍可能写着自己持有；判成 yes 会重新制造双桥。
  assert.deepEqual(decideBridgeOwnership({
    selfId: "windows",
    lease: makeLease("windows", NOW_MS - 90_001),
    nowMs: NOW_MS,
    peerConfigured: true
  }), { shouldRunLocally: "defer", reason: "lease-stale" });
});

test("decideBridgeOwnership defers missing and structurally invalid leases", () => {
  const input = {
    selfId: "windows",
    nowMs: NOW_MS,
    peerConfigured: true
  };
  assert.deepEqual(decideBridgeOwnership({ ...input, lease: null }), {
    shouldRunLocally: "defer",
    reason: "lease-missing"
  });
  assert.deepEqual(decideBridgeOwnership({ ...input, lease: { holder: "windows" } }), {
    shouldRunLocally: "defer",
    reason: "lease-missing"
  });
});

test("peer ownership stops a running local bridge without starting one", async () => {
  const stopped = [];
  let startCalls = 0;
  let alertCalls = 0;

  const result = await reconcileBridgeOwnership({
    ownership: { shouldRunLocally: "no", reason: "peer-holds-lease" },
    beforePids: [801],
    heartbeatAtMs: NOW_MS,
    nowMs: NOW_MS
  }, {
    appendLog: () => {},
    stopBridge: (pids) => stopped.push(pids),
    startBridge: () => { startCalls += 1; },
    sendOwnershipAlert: async () => { alertCalls += 1; }
  });

  assert.deepEqual(stopped, [[801]]);
  assert.equal(startCalls, 0);
  assert.equal(alertCalls, 1);
  assert.equal(result.stopped, true);
});

test("deferred ownership neither starts nor stops the local bridge", async () => {
  let startCalls = 0;
  let stopCalls = 0;

  const result = await reconcileBridgeOwnership({
    ownership: { shouldRunLocally: "defer", reason: "lease-stale" },
    beforePids: [802],
    heartbeatAtMs: NOW_MS,
    nowMs: NOW_MS
  }, {
    logStateChange: () => {},
    stopBridge: () => { stopCalls += 1; },
    startBridge: () => { startCalls += 1; }
  });

  assert.equal(startCalls, 0);
  assert.equal(stopCalls, 0);
  assert.equal(result.reason, "lease-stale");
});

test("supervisor process probe matches node.exe with either path separator", () => {
  const command = buildSupervisorProcessCheckCommand();

  assert.ok(command.includes("Name = 'node.exe'"));
  assert.ok(command.includes("*brain/supervisor*"));
  assert.ok(command.includes("*brain\\supervisor*"));
});

test("missing supervisor is started and alerted when a peer is configured", async () => {
  let startCalls = 0;
  let alertCalls = 0;
  const logs = [];

  const result = await ensureSupervisorRunning({ peerConfigured: true }, {
    getSupervisorPids: () => [],
    startSupervisor: () => { startCalls += 1; },
    appendLog: (entry) => logs.push(entry),
    sendSupervisorAlert: async () => { alertCalls += 1; }
  });

  assert.equal(startCalls, 1);
  assert.equal(alertCalls, 1);
  assert.equal(result.started, true);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "supervisor-start-requested",
    "supervisor-start-dispatched"
  ]);
});

test("single-node mode skips the supervisor process check", async () => {
  let processChecks = 0;
  let startCalls = 0;

  const result = await ensureSupervisorRunning({ peerConfigured: false }, {
    getSupervisorPids: () => { processChecks += 1; },
    startSupervisor: () => { startCalls += 1; }
  });

  assert.equal(processChecks, 0);
  assert.equal(startCalls, 0);
  assert.deepEqual(result, { checked: false, started: false, reason: "single-node" });
});

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

test("stop command stops the PowerShell keepalive before finding bridge nodes", () => {
  const command = buildStopBridgeCommand([101]);

  assert.match(command, /Name = 'powershell\.exe'/);
  assert.match(command, /run-openclaw-telegram-bridge\.ps1/);
  assert.match(command, /\$_\.ProcessId -ne \$PID/);
  assert.ok(
    command.indexOf("Stop-Process -Id $keepalivePid") <
      command.indexOf("$runningBridgePids = @(")
  );
  assert.match(command, /\$knownBridgePids \+ \$runningBridgePids/);
});

test("stop command still targets the keepalive when no bridge node was found", () => {
  const command = buildStopBridgeCommand([]);

  assert.match(command, /\$knownBridgePids = @\(\)/);
  assert.match(command, /Stop-Process -Id \$keepalivePid/);
});
