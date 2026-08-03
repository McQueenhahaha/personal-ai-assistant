import { test } from "node:test";
import assert from "node:assert/strict";
import { decideScheduledWork, RUN, SKIP } from "../src/state/brain-guard.mjs";

// 2026-08-03 真实故障：大脑在 Mac，但 Windows 的计划任务仍在跑学校检查。
// school-check-state.json 在灵魂包里，Windows 每约 35 秒 pullSoul 一次、
// 用 Mac 的旧副本覆盖本地 —— 刚存下的去重状态被冲掉，于是每次都判"首次发送"，
// 同一批游戏资讯每 5 分钟刷屏一次。

const FRESH = { holder: "mac", heartbeatAt: "2026-08-03T10:00:00.000Z", ttlSeconds: 90 };
const NOW = Date.parse("2026-08-03T10:00:30.000Z");

test("skips only when a fresh lease is held by the other node", () => {
  const decision = decideScheduledWork({ lease: FRESH, selfId: "windows", nowMs: NOW });
  assert.deepEqual(decision, { action: SKIP, reason: "peer-holds-lease" });
});

test("runs when this node holds the lease", () => {
  const decision = decideScheduledWork({ lease: { ...FRESH, holder: "windows" }, selfId: "windows", nowMs: NOW });
  assert.equal(decision.action, RUN);
});

test("the rule is symmetric — it is not Windows-specific", () => {
  // 用户明确要求："如果主脑在 windows，mac 那也应该一样"
  const macSkips = decideScheduledWork({
    lease: { ...FRESH, holder: "windows" },
    selfId: "mac",
    nowMs: NOW
  });
  assert.deepEqual(macSkips, { action: SKIP, reason: "peer-holds-lease" });
});

test("runs when the peer lease has expired — this node is likely taking over", () => {
  const late = Date.parse("2026-08-03T10:02:00.000Z");
  const decision = decideScheduledWork({ lease: FRESH, selfId: "windows", nowMs: late });
  assert.deepEqual(decision, { action: RUN, reason: "peer-lease-expired" });
});

test("missing or unreadable leases fail open, never into a silent halt", () => {
  // 静默停摆用户无从察觉，是本仓反复消灭的那类故障；宁可多跑一次。
  for (const lease of [null, undefined, {}, { holder: "" }, { holder: "mac" }, { holder: "mac", heartbeatAt: "garbage", ttlSeconds: 90 }, { holder: "mac", heartbeatAt: FRESH.heartbeatAt, ttlSeconds: 0 }]) {
    const decision = decideScheduledWork({ lease, selfId: "windows", nowMs: NOW });
    assert.equal(decision.action, RUN, JSON.stringify(lease));
  }
});
