import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decideRole,
  isLeaseFresh,
  loadLease,
  makeLease,
  saveLease
} from "../src/brain/lease.mjs";
import {
  ensureBrainServices,
  runSupervisorRound
} from "../src/brain/supervisor.mjs";

const NOW = Date.parse("2026-08-01T00:02:00.000Z");

function lease(overrides = {}) {
  return {
    holder: "mac",
    heartbeatAt: new Date(NOW - 30000).toISOString(),
    ttlSeconds: 90,
    reason: "renew",
    ...overrides
  };
}

test("decideRole: missing or invalid lease claims brain", () => {
  const input = {
    selfId: "windows",
    nowMs: NOW,
    peerReachable: false,
    unreachableStreak: 0
  };

  assert.deepEqual(decideRole({ ...input, lease: null }), {
    role: "brain",
    action: "claim",
    reason: "missing-or-invalid-lease"
  });
  assert.equal(decideRole({ ...input, lease: { broken: true } }).action, "claim");
});

test("decideRole: self-held lease renews brain even when expired", () => {
  assert.deepEqual(decideRole({
    lease: lease({
      holder: "windows",
      heartbeatAt: new Date(NOW - 120000).toISOString()
    }),
    selfId: "windows",
    nowMs: NOW,
    peerReachable: false,
    unreachableStreak: 10
  }), {
    role: "brain",
    action: "renew",
    reason: "self-holds-lease"
  });
});

test("decideRole: fresh peer lease stands by as satellite", () => {
  assert.deepEqual(decideRole({
    lease: lease(),
    selfId: "windows",
    nowMs: NOW,
    peerReachable: false,
    unreachableStreak: 10
  }), {
    role: "satellite",
    action: "standby",
    reason: "peer-lease-fresh"
  });
});

test("decideRole: expired peer lease takes over when peer is reachable", () => {
  assert.deepEqual(decideRole({
    lease: lease({ heartbeatAt: new Date(NOW - 90001).toISOString() }),
    selfId: "windows",
    nowMs: NOW,
    peerReachable: true,
    unreachableStreak: 0
  }), {
    role: "brain",
    action: "takeover",
    reason: "peer-lease-expired-reachable"
  });
});

test("decideRole: expired unreachable peer waits below debounce threshold", () => {
  assert.deepEqual(decideRole({
    lease: lease({ heartbeatAt: new Date(NOW - 90001).toISOString() }),
    selfId: "windows",
    nowMs: NOW,
    peerReachable: false,
    unreachableStreak: 2
  }), {
    role: "satellite",
    action: "standby",
    reason: "peer-lease-expired-waiting"
  });
});

test("decideRole: expired unreachable peer takes over at debounce threshold", () => {
  assert.deepEqual(decideRole({
    lease: lease({ heartbeatAt: new Date(NOW - 90001).toISOString() }),
    selfId: "windows",
    nowMs: NOW,
    peerReachable: false,
    unreachableStreak: 3
  }), {
    role: "brain",
    action: "takeover",
    reason: "peer-lease-expired-unreachable-threshold"
  });
});

test("isLeaseFresh includes the TTL boundary and expires immediately after it", () => {
  const value = lease({ heartbeatAt: new Date(NOW - 90000).toISOString() });

  assert.equal(isLeaseFresh(value, NOW), true);
  assert.equal(isLeaseFresh(value, NOW + 1), false);
  assert.equal(isLeaseFresh({ broken: true }, NOW), false);
});

test("makeLease and lease IO round-trip while missing, bad JSON, and bad shapes return null", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-lease-"));
  const leaseFile = path.join(tempDir, "brain-lease.json");
  const missingFile = path.join(tempDir, "missing.json");
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const expected = makeLease("windows", NOW, "startup");
  await saveLease(leaseFile, expected);
  assert.deepEqual(await loadLease(leaseFile), expected);
  assert.equal(await loadLease(missingFile), null);

  await fs.writeFile(leaseFile, "{bad json", "utf8");
  assert.equal(await loadLease(leaseFile), null);
  await fs.writeFile(leaseFile, JSON.stringify({ holder: "other" }), "utf8");
  assert.equal(await loadLease(leaseFile), null);
});

test("single-node supervisor claims immediately and then renews without peer configuration", async () => {
  let storedLease = null;
  const serviceStates = [];
  const dependencies = {
    selfId: "windows",
    peerConnection: null,
    now: () => NOW,
    loadLease: async () => storedLease,
    saveLease: async (_file, value) => { storedLease = value; },
    ensureBrainServices: async (shouldRun) => { serviceStates.push(shouldRun); },
    log: () => {}
  };

  const claimed = await runSupervisorRound({ unreachableStreak: 0 }, dependencies);
  assert.equal(claimed.action, "claim");
  assert.equal(claimed.role, "brain");
  assert.equal(claimed.lease.holder, "windows");
  assert.equal(claimed.unreachableStreak, 3);

  const renewed = await runSupervisorRound({ unreachableStreak: 3 }, dependencies);
  assert.equal(renewed.action, "renew");
  assert.equal(renewed.role, "brain");
  assert.deepEqual(serviceStates, [true, true]);
});

test("ensureBrainServices starts and stops only the Telegram bridge on Windows", async () => {
  const calls = [];
  const dependencies = {
    platform: "win32",
    repoRoot: "D:\\repo",
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    }
  };

  await ensureBrainServices(true, dependencies);
  await ensureBrainServices(false, dependencies);

  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ command, options }) => command === "powershell.exe" && options.shell === false), true);
  assert.deepEqual(calls[0].args.slice(-2), [
    "-File",
    path.join("D:\\repo", "scripts", "start-openclaw-telegram-bridge-hidden.ps1")
  ]);
  assert.equal(calls[1].args.includes("-Command"), true);
  assert.match(calls[1].args.at(-1), /openclaw-telegram-bridge/);
  assert.doesNotMatch(calls[1].args.at(-1), /worker|school|canvas|digest/i);
});
