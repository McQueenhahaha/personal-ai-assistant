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

test("windowsPeerReachable accepts a DERP pong even when tailscale exits 1", () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    // 真机抓到的回归样本：对端经 DERP 回了 pong，但因未建立直连，tailscale 退出码为 1。
    return {
      status: 1,
      stdout: "pong from windows-node (100.64.0.20) via DERP(syd) in 32ms\n",
      stderr: "2026/08/02 14:38:18 direct connection not established\n"
    };
  };
  const dependencies = {
    env: { PEER_TAILSCALE_IP: "100.64.0.20" },
    fs: { existsSync: (file) => file === "/usr/local/bin/tailscale" },
    spawnSync
  };

  const result = windowsPeerReachable(dependencies);
  assert.deepEqual(
    { reachable: result.reachable, determined: result.determined },
    { reachable: true, determined: true }
  );
  assert.match(result.detail, /pong from windows-node/i);
  assert.equal(calls[0].command, "/usr/local/bin/tailscale");
  assert.deepEqual(calls[0].args, ["ping", "--c=1", "--timeout=5s", "100.64.0.20"]);
  assert.equal(calls[0].options.shell, false);
});

test("windowsPeerReachable distinguishes no pong from a spawn failure", () => {
  const dependencies = {
    env: { PEER_TAILSCALE_IP: "100.64.0.20" },
    fs: { existsSync: () => true }
  };

  const noPong = windowsPeerReachable({
    ...dependencies,
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" })
  });
  assert.deepEqual(
    { reachable: noPong.reachable, determined: noPong.determined },
    { reachable: false, determined: true }
  );

  const spawnError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  const failed = windowsPeerReachable({
    ...dependencies,
    spawnSync: () => ({ status: null, stdout: "", stderr: "", error: spawnError })
  });
  assert.deepEqual(
    { reachable: failed.reachable, determined: failed.determined },
    { reachable: false, determined: false }
  );
  assert.match(failed.detail, /ENOENT/);
});

test("windowsPeerReachable skips probing when peer IP or tailscale is unavailable", () => {
  let spawnCalls = 0;
  let warnings = 0;
  const missingPeer = windowsPeerReachable({
    env: {},
    spawnSync: () => { spawnCalls += 1; },
    onMissingPeerIp: () => { warnings += 1; }
  });

  assert.deepEqual(
    { reachable: missingPeer.reachable, determined: missingPeer.determined },
    { reachable: false, determined: false }
  );
  assert.match(missingPeer.detail, /PEER_TAILSCALE_IP/);
  assert.equal(spawnCalls, 0);
  assert.equal(warnings, 1);

  const missingBin = windowsPeerReachable({
    env: { PEER_TAILSCALE_IP: "100.64.0.20" },
    fs: { existsSync: () => false },
    spawnSync: () => { spawnCalls += 1; }
  });
  assert.deepEqual(
    { reachable: missingBin.reachable, determined: missingBin.determined },
    { reachable: false, determined: false }
  );
  assert.match(missingBin.detail, /tailscale/i);
  assert.equal(spawnCalls, 0);
});

test("windowsPeerReachable resolves tailscale paths in priority order", () => {
  const checked = [];
  const calls = [];
  const appBin = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const result = windowsPeerReachable({
    env: {
      PEER_TAILSCALE_IP: "100.64.0.20",
      TAILSCALE_BIN: "/custom/missing-tailscale"
    },
    fs: {
      existsSync(file) {
        checked.push(file);
        return file === appBin;
      }
    },
    spawnSync(command) {
      calls.push(command);
      return { status: 0, stdout: "pong FROM windows (100.64.0.20) in 10ms\n", stderr: "" };
    }
  });

  assert.deepEqual(checked, [
    "/custom/missing-tailscale",
    "/usr/local/bin/tailscale",
    appBin
  ]);
  assert.deepEqual(calls, [appBin]);
  assert.equal(result.reachable, true);
  assert.equal(result.determined, true);
});

test("supervisor preserves unreachable streak when peer reachability is undetermined", async () => {
  const logs = [];
  const expiredWindowsLease = lease({
    holder: "windows",
    heartbeatAt: new Date(NOW - 90001).toISOString()
  });
  const dependencies = {
    selfId: "mac",
    env: {},
    now: () => NOW,
    loadLease: async () => expiredWindowsLease,
    ensureBrainServices: async () => {},
    log: (line) => { logs.push(line); }
  };

  const fromZero = await runSupervisorRound({ unreachableStreak: 0 }, dependencies);
  const fromTwo = await runSupervisorRound({ unreachableStreak: 2 }, dependencies);

  assert.equal(fromZero.unreachableStreak, 0);
  assert.equal(fromTwo.unreachableStreak, 2);
  assert.equal(fromZero.action, "standby");
  assert.equal(fromTwo.action, "standby");
  assert.equal(logs.filter((line) => /WARN.*PEER_TAILSCALE_IP/.test(line)).length, 2);
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

test("takeover pulls the remote soul before starting services, saving the lease, and pushing", async () => {
  const peerConnection = { host: "tester@mac", key: "C:\\keys\\pai_mac" };
  const expiredMacLease = lease({ heartbeatAt: new Date(NOW - 90001).toISOString() });
  const calls = [];

  const result = await runSupervisorRound({}, {
    selfId: "windows",
    peerConnection,
    now: () => NOW,
    loadLease: async () => expiredMacLease,
    macSatelliteHealth: async () => ({ online: true }),
    readSoulLease: async () => expiredMacLease,
    pullSoul: async () => { calls.push("pull"); return {}; },
    ensureBrainServices: async (shouldRun) => { calls.push(`service:${shouldRun}`); },
    saveLease: async () => { calls.push("save"); },
    pushSoul: async (_connection, options) => {
      calls.push(`push:${options.backupTimestamp}`);
    },
    log: () => {}
  });

  assert.equal(result.role, "brain");
  assert.equal(result.action, "takeover");
  assert.deepEqual(calls, [
    "pull",
    "service:true",
    "save",
    "push:2026-08-01T00-02-00-000Z"
  ]);
});

test("takeover pull failure conservatively stays standby without saving or pushing", async () => {
  const peerConnection = { host: "tester@mac", key: "C:\\keys\\pai_mac" };
  const expiredMacLease = lease({ heartbeatAt: new Date(NOW - 90001).toISOString() });
  const calls = [];
  const logs = [];

  const result = await runSupervisorRound({}, {
    selfId: "windows",
    peerConnection,
    now: () => NOW,
    loadLease: async () => expiredMacLease,
    macSatelliteHealth: async () => ({ online: true }),
    readSoulLease: async () => expiredMacLease,
    pullSoul: async () => { calls.push("pull"); throw new Error("scp unavailable"); },
    ensureBrainServices: async (shouldRun) => { calls.push(`service:${shouldRun}`); },
    saveLease: async () => { calls.push("save"); },
    pushSoul: async () => { calls.push("push"); },
    log: (line) => { logs.push(line); }
  });

  assert.equal(result.role, "satellite");
  assert.equal(result.action, "standby");
  assert.equal(result.reason, "takeover-soul-pull-failed");
  assert.deepEqual(calls, ["pull", "service:false"]);
  assert.match(logs.join("\n"), /放弃本轮接管并转为待机/);
  assert.match(logs.join("\n"), /scp unavailable/);
});

test("claim and renew push normally without pulling the remote soul", async () => {
  const peerConnection = { host: "tester@mac", key: "C:\\keys\\pai_mac" };
  const calls = [];
  const common = {
    selfId: "windows",
    peerConnection,
    now: () => NOW,
    macSatelliteHealth: async () => ({ online: true }),
    pullSoul: async () => { calls.push("pull"); },
    ensureBrainServices: async (shouldRun) => { calls.push(`service:${shouldRun}`); },
    saveLease: async () => { calls.push("save"); },
    pushSoul: async () => { calls.push("push"); },
    log: () => {}
  };

  const claimed = await runSupervisorRound({}, {
    ...common,
    loadLease: async () => null,
    readSoulLease: async () => null
  });
  assert.equal(claimed.action, "claim");
  assert.deepEqual(calls, ["service:true", "save", "push"]);

  calls.length = 0;
  const renewed = await runSupervisorRound({}, {
    ...common,
    loadLease: async () => lease({ holder: "windows" }),
    readSoulLease: async () => null
  });
  assert.equal(renewed.action, "renew");
  assert.deepEqual(calls, ["service:true", "save", "push"]);
});

test("Mac supervisor never initiates soul sync and logs each undetermined peer probe", async () => {
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
  assert.equal(logs.filter((line) => line.includes("PEER_TAILSCALE_IP 未配置")).length, 2);
});

// chooseNewestLease 是防脑裂仲裁的核心，但「采纳对端租约」那条分支从未被任何
// 测试执行到 —— 它决定的是"两台机器各持一份租约时，听谁的"。
test("租约仲裁：本地无效时采纳对端", async () => {
  const { chooseNewestLease } = await import("../src/brain/supervisor.mjs");
  const peer = { holder: "mac", heartbeatAt: "2026-08-01T00:00:10.000Z", ttlSeconds: 90, reason: "renew" };

  assert.deepEqual(chooseNewestLease(null, peer), { lease: peer, source: "peer" });
  assert.deepEqual(chooseNewestLease({ holder: "" }, peer), { lease: peer, source: "peer" });
});

test("租约仲裁：两个都有效时听心跳更新的那份", async () => {
  const { chooseNewestLease } = await import("../src/brain/supervisor.mjs");
  const older = { holder: "windows", heartbeatAt: "2026-08-01T00:00:00.000Z", ttlSeconds: 90, reason: "renew" };
  const newer = { holder: "mac", heartbeatAt: "2026-08-01T00:00:10.000Z", ttlSeconds: 90, reason: "renew" };

  assert.equal(chooseNewestLease(older, newer).source, "peer");
  assert.equal(chooseNewestLease(newer, older).source, "local");
});

test("租约仲裁：心跳相等时偏向本地 —— 这是有意的，不是 bug", async () => {
  // 用严格大于而不是大于等于：相等时不换手，避免两台机器在时钟对齐的
  // 瞬间来回抢租约。改成 >= 会让这条断言立刻报红。
  const { chooseNewestLease } = await import("../src/brain/supervisor.mjs");
  const at = "2026-08-01T00:00:00.000Z";
  const local = { holder: "windows", heartbeatAt: at, ttlSeconds: 90, reason: "renew" };
  const peer = { holder: "mac", heartbeatAt: at, ttlSeconds: 90, reason: "renew" };

  assert.deepEqual(chooseNewestLease(local, peer), { lease: local, source: "local" });
});

test("租约仲裁：两个都无效时不选任何一份", async () => {
  const { chooseNewestLease } = await import("../src/brain/supervisor.mjs");
  assert.deepEqual(chooseNewestLease(null, null), { lease: null, source: "none" });
  assert.deepEqual(chooseNewestLease({}, { holder: 123 }), { lease: null, source: "none" });
});
