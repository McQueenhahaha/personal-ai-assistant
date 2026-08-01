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
  runSupervisorRound,
  windowsPeerReachable
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

test("ensureBrainServices starts and stops the Mac bridge idempotently from its pid file", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brain-services-mac-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const spawnCalls = [];
  const killCalls = [];
  let alive = false;
  let unrefCalls = 0;
  const dependencies = {
    platform: "darwin",
    repoRoot,
    nodePath: "/usr/local/bin/node",
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      alive = true;
      return { pid: 4321, unref: () => { unrefCalls += 1; } };
    },
    kill(pid, signal) {
      killCalls.push({ pid, signal });
      if (pid !== 4321 || !alive) {
        const error = new Error("not running");
        error.code = "ESRCH";
        throw error;
      }
      if (signal !== 0) alive = false;
    }
  };

  await ensureBrainServices(true, dependencies);
  await ensureBrainServices(true, dependencies);
  await ensureBrainServices(false, dependencies);
  await ensureBrainServices(false, dependencies);

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/usr/local/bin/node");
  assert.deepEqual(spawnCalls[0].args, [path.join(repoRoot, "src", "openclaw-telegram-bridge.mjs")]);
  assert.equal(spawnCalls[0].options.cwd, repoRoot);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.stdio[0], "ignore");
  assert.equal(spawnCalls[0].options.stdio[1], spawnCalls[0].options.stdio[2]);
  assert.equal(unrefCalls, 1);
  assert.deepEqual(killCalls.map(({ signal }) => signal), [0, 0, undefined]);
  assert.equal(await fs.readFile(path.join(repoRoot, "data", "logs", "bridge.log"), "utf8"), "");
  await assert.rejects(fs.access(path.join(repoRoot, "data", "state", "bridge.pid")));
});

test("windowsPeerReachable treats tailscale exit 0 as reachable and every failure as unreachable", () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: calls.length === 1 ? 0 : 1, stdout: "", stderr: "" };
  };
  const dependencies = {
    env: { PEER_TAILSCALE_IP: "100.64.0.20" },
    spawnSync
  };

  assert.equal(windowsPeerReachable(dependencies), true);
  assert.equal(windowsPeerReachable(dependencies), false);
  assert.equal(windowsPeerReachable({
    ...dependencies,
    spawnSync: () => { throw new Error("tailscale missing"); }
  }), false);
  assert.equal(calls[0].command, "/usr/local/bin/tailscale");
  assert.deepEqual(calls[0].args, ["ping", "--c=1", "--timeout=5s", "100.64.0.20"]);
  assert.equal(calls[0].options.shell, false);
});

test("windowsPeerReachable skips tailscale when PEER_TAILSCALE_IP is missing", () => {
  let spawnCalls = 0;
  let warnings = 0;
  const reachable = windowsPeerReachable({
    env: {},
    spawnSync: () => { spawnCalls += 1; },
    onMissingPeerIp: () => { warnings += 1; }
  });

  assert.equal(reachable, false);
  assert.equal(spawnCalls, 0);
  assert.equal(warnings, 1);
});

test("supervisor syncs only in the Windows role direction and ignores sync failures", async () => {
  const peerConnection = { host: "tester@mac", key: "C:\\keys\\pai_mac" };
  const brainLease = lease({ holder: "windows" });
  const macLease = lease({ holder: "mac" });
  const calls = [];
  const logs = [];
  const common = {
    selfId: "windows",
    peerConnection,
    now: () => NOW,
    macSatelliteHealth: async () => ({ online: true }),
    ensureBrainServices: async (shouldRun) => { calls.push(`service:${shouldRun}`); },
    saveLease: async () => {},
    log: (line) => { logs.push(line); }
  };

  const brain = await runSupervisorRound({}, {
    ...common,
    loadLease: async () => brainLease,
    readSoulLease: async () => brainLease,
    pullSoul: async () => { calls.push("pull"); return {}; },
    pushSoul: async () => { calls.push("push"); throw new Error("push failed"); }
  });
  assert.equal(brain.role, "brain");
  assert.deepEqual(calls, ["service:true", "push"]);
  assert.match(logs.join("\n"), /推送灵魂包失败/);

  calls.length = 0;
  logs.length = 0;
  const satellite = await runSupervisorRound({}, {
    ...common,
    loadLease: async () => macLease,
    readSoulLease: async () => macLease,
    pullSoul: async () => { calls.push("pull"); throw new Error("pull failed"); },
    pushSoul: async () => { calls.push("push"); }
  });
  assert.equal(satellite.role, "satellite");
  assert.deepEqual(calls, ["pull", "service:false"]);
  assert.match(logs.join("\n"), /拉取 Mac 灵魂包失败/);
});

test("Mac supervisor never initiates soul sync and warns once when peer IP is missing", async () => {
  const calls = [];
  const logs = [];
  const macLease = lease({ holder: "mac" });
  const dependencies = {
    selfId: "mac",
    peerConnection: null,
    env: {},
    now: () => NOW,
    loadLease: async () => macLease,
    saveLease: async () => {},
    ensureBrainServices: async (shouldRun) => { calls.push(`service:${shouldRun}`); },
    pullSoul: async () => { calls.push("pull"); },
    pushSoul: async () => { calls.push("push"); },
    readSoulLease: async () => { calls.push("read-lease"); },
    log: (line) => { logs.push(line); }
  };

  const first = await runSupervisorRound({}, dependencies);
  await runSupervisorRound(first, dependencies);

  assert.deepEqual(calls, ["service:true", "service:true"]);
  assert.equal(logs.filter((line) => line.includes("PEER_TAILSCALE_IP 未配置")).length, 1);
});
