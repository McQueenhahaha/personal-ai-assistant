import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideGameWatcherAction,
  decideWorkerLoopAction,
  ensureGameWatcherRunning,
  ensureWorkerLoopRunning,
  main
} from "../src/telegram/watchdog.mjs";

const NOW_MS = Date.parse("2026-08-06T03:00:00.000Z");

test("process reconcile decisions preserve desired state and ownership", () => {
  assert.deepEqual(decideWorkerLoopAction({
    runningFlagExists: false,
    processAlive: false,
    shouldRunLocally: "yes"
  }), { start: false, reason: "not-desired" });
  assert.deepEqual(decideGameWatcherAction({
    desiredFlagExists: false,
    processAlive: false
  }), { start: false, reason: "not-desired" });

  assert.deepEqual(decideWorkerLoopAction({
    runningFlagExists: true,
    processAlive: true,
    shouldRunLocally: "yes"
  }), { start: false, reason: "healthy" });
  assert.deepEqual(decideGameWatcherAction({
    desiredFlagExists: true,
    processAlive: true
  }), { start: false, reason: "healthy" });

  assert.deepEqual(decideWorkerLoopAction({
    runningFlagExists: true,
    processAlive: false,
    shouldRunLocally: "yes"
  }), { start: true, reason: "process-missing" });
  assert.deepEqual(decideWorkerLoopAction({
    runningFlagExists: true,
    processAlive: false,
    shouldRunLocally: "no"
  }), { start: false, reason: "not-local-brain" });
  assert.deepEqual(decideGameWatcherAction({
    desiredFlagExists: true,
    processAlive: false
  }), { start: true, reason: "process-missing" });

  assert.deepEqual(decideWorkerLoopAction({
    runningFlagExists: true,
    processAlive: null,
    shouldRunLocally: "yes"
  }), { start: false, reason: "unverifiable" });
  assert.deepEqual(decideGameWatcherAction({
    desiredFlagExists: true,
    processAlive: null
  }), { start: false, reason: "unverifiable" });
});

test("missing desired flags never start worker or game watcher", async () => {
  let startCalls = 0;
  const unexpectedCall = () => assert.fail("no log or alert expected when running is not desired");

  const workerResult = await ensureWorkerLoopRunning({ shouldRunLocally: "yes" }, {
    existsSync: () => false,
    getWorkerLoopPids: unexpectedCall,
    startWorkerLoop: () => { startCalls += 1; },
    appendLog: unexpectedCall,
    sendWorkerLoopAlert: unexpectedCall
  });
  const watcherResult = await ensureGameWatcherRunning({}, {
    existsSync: () => false,
    getGameWatcherPids: unexpectedCall,
    startGameWatcher: () => { startCalls += 1; },
    appendLog: unexpectedCall,
    sendGameWatcherAlert: unexpectedCall
  });

  assert.equal(startCalls, 0);
  assert.equal(workerResult.reason, "not-desired");
  assert.equal(watcherResult.reason, "not-desired");
});

test("healthy worker and game watcher are left alone without logging", async () => {
  let startCalls = 0;
  const unexpectedCall = () => assert.fail("no log or alert expected for healthy processes");

  const workerResult = await ensureWorkerLoopRunning({ shouldRunLocally: "yes" }, {
    existsSync: () => true,
    getWorkerLoopPids: () => [101],
    startWorkerLoop: () => { startCalls += 1; },
    appendLog: unexpectedCall,
    sendWorkerLoopAlert: unexpectedCall
  });
  const watcherResult = await ensureGameWatcherRunning({}, {
    existsSync: () => true,
    getGameWatcherPids: () => [202],
    startGameWatcher: () => { startCalls += 1; },
    appendLog: unexpectedCall,
    sendGameWatcherAlert: unexpectedCall
  });

  assert.equal(startCalls, 0);
  assert.equal(workerResult.reason, "healthy");
  assert.equal(watcherResult.reason, "healthy");
});

test("missing worker starts when the local node holds the brain lease", async () => {
  let startCalls = 0;
  let alertCalls = 0;
  const logs = [];

  const result = await ensureWorkerLoopRunning({ shouldRunLocally: "yes" }, {
    existsSync: () => true,
    getWorkerLoopPids: () => [],
    startWorkerLoop: () => { startCalls += 1; },
    appendLog: (entry) => logs.push(entry),
    sendWorkerLoopAlert: async ({ startError }) => {
      assert.equal(startError, null);
      alertCalls += 1;
    }
  });

  assert.equal(startCalls, 1);
  assert.equal(alertCalls, 1);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "worker-loop-start-requested",
    "worker-loop-start-dispatched"
  ]);
  assert.deepEqual(result, {
    checked: true,
    started: true,
    reason: "worker-loop-start-requested"
  });
});

test("peer-held lease blocks worker start but not game watcher start", async () => {
  let workerStarts = 0;
  let watcherStarts = 0;

  const workerResult = await ensureWorkerLoopRunning({ shouldRunLocally: "no" }, {
    existsSync: () => true,
    getWorkerLoopPids: () => assert.fail("worker process should not be checked for a peer-held lease"),
    startWorkerLoop: () => { workerStarts += 1; },
    appendLog: () => assert.fail("worker should not log when the peer holds the lease"),
    sendWorkerLoopAlert: () => assert.fail("worker should not alert when the peer holds the lease")
  });
  const watcherResult = await ensureGameWatcherRunning({}, {
    existsSync: () => true,
    getGameWatcherPids: () => [],
    startGameWatcher: () => { watcherStarts += 1; },
    appendLog: () => {},
    sendGameWatcherAlert: async () => {}
  });

  assert.equal(workerStarts, 0);
  assert.equal(watcherStarts, 1);
  assert.equal(workerResult.reason, "not-local-brain");
  assert.equal(watcherResult.started, true);
});

test("start script failures are logged and alerted without escaping", async () => {
  const workerLogs = [];
  const watcherLogs = [];
  const alerts = [];

  const workerResult = await ensureWorkerLoopRunning({ shouldRunLocally: "yes" }, {
    existsSync: () => true,
    getWorkerLoopPids: () => [],
    startWorkerLoop: () => { throw new Error("worker boom"); },
    appendLog: (entry) => workerLogs.push(entry),
    sendWatchdogAlert: async (alert) => { alerts.push(alert); }
  });
  const watcherResult = await ensureGameWatcherRunning({}, {
    existsSync: () => true,
    getGameWatcherPids: () => [],
    startGameWatcher: () => { throw new Error("watcher boom"); },
    appendLog: (entry) => watcherLogs.push(entry),
    sendWatchdogAlert: async (alert) => { alerts.push(alert); }
  });

  assert.equal(workerResult.started, false);
  assert.equal(watcherResult.started, false);
  assert.equal(workerLogs.at(-1).event, "worker-loop-start-failed");
  assert.equal(watcherLogs.at(-1).event, "game-watcher-start-failed");
  assert.deepEqual(alerts.map(({ state, dedupe }) => ({ state, dedupe })), [
    { state: "worker-loop-start-failed", dedupe: true },
    { state: "game-watcher-start-failed", dedupe: true }
  ]);
  assert.match(alerts[0].text, /worker boom/);
  assert.match(alerts[1].text, /watcher boom/);
});

test("worker reconcile failure cannot prevent main bridge reconcile", async () => {
  const calls = [];
  const logs = [];
  const bridgeResult = { restart: false, reason: "healthy" };

  const result = await main({
    loadEnv: () => {},
    env: {},
    ensureSupervisorRunning: async () => {},
    now: () => NOW_MS,
    readBrainLease: () => null,
    resolveNodeId: () => "windows",
    readHeartbeat: () => ({ atMs: NOW_MS }),
    getBridgePids: () => [303],
    reconcileBridgeOwnership: async () => {
      calls.push("bridge");
      return bridgeResult;
    },
    ensureWorkerLoopRunning: async () => {
      calls.push("worker");
      throw new Error("worker reconcile boom");
    },
    ensureGameWatcherRunning: async () => { calls.push("watcher"); },
    appendLog: (entry) => logs.push(entry)
  });

  assert.equal(result, bridgeResult);
  assert.deepEqual(calls, ["bridge", "worker", "watcher"]);
  assert.equal(logs.at(-1).event, "worker-loop-reconcile-failed");
});
