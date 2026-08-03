import { test } from "node:test";
import assert from "node:assert/strict";
import { makeReleasedLease, runHandover, shouldHandOver } from "../src/brain/handover.mjs";
import { decideRole } from "../src/brain/lease.mjs";

// 凤凰计划（二）。现有模型是"幸存者去尸体上取数据"：对端接管前先 pullSoul。
// 但机器冻住/关机就拉不到。这里反过来 —— 将死者在还能动时主动推。

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const LEASE = {
  holder: "windows",
  heartbeatAt: "2026-08-03T11:59:50.000Z",
  ttlSeconds: 90,
  reason: "renew"
};

test("only the current brain hands over", () => {
  assert.equal(shouldHandOver({ lease: LEASE, selfId: "windows" }).act, true);
  assert.equal(shouldHandOver({ lease: LEASE, selfId: "mac" }).act, false);
  assert.equal(shouldHandOver({ lease: null, selfId: "windows" }).act, false);
});

test("handing over twice is a no-op", () => {
  const released = makeReleasedLease(LEASE, NOW);
  assert.equal(shouldHandOver({ lease: released, selfId: "windows" }).act, false);
});

test("the released lease is genuinely expired, so the peer takes over via the existing path", () => {
  // 刻意不改 decideRole（防脑裂的核心路径）。把租约写成"已过期"是事实陈述 ——
  // 马上就要睡了。对端用现成的过期判定即可接管，不需要新分支。
  const released = makeReleasedLease(LEASE, NOW);
  const ageMs = NOW - Date.parse(released.heartbeatAt);
  assert.ok(ageMs > released.ttlSeconds * 1000, "回拨后必须严格超过 TTL");
  assert.equal(released.reason, "handover");
  assert.ok(released.releasedAt);
});

test("the peer's existing decideRole accepts the released lease as takeable", () => {
  const released = makeReleasedLease(LEASE, NOW);
  const decision = decideRole({
    lease: released,
    selfId: "mac",
    nowMs: NOW,
    peerReachable: true,
    unreachableStreak: 0
  });
  assert.equal(decision.role, "brain", "对端应当据此接管");
});

test("local release happens even when the push cannot go out", async () => {
  // 对端不可达/来不及推时也必须先让出本地租约，否则醒来后会以为自己还是大脑。
  const writes = [];
  const result = await runHandover({
    root: "/tmp/whatever",
    selfId: "windows",
    nowMs: NOW,
    env: { MAC_SATELLITE_HOST: "ou@example", MAC_SATELLITE_KEY: "/tmp/key" },
    fs: {
      readFileSync: () => JSON.stringify(LEASE),
      writeFileSync: (file, body) => writes.push({ file, body })
    },
    pushSoul: async () => { throw new Error("peer asleep"); }
  });

  assert.equal(result.handedOver, true);
  assert.equal(result.pushed, false);
  assert.match(result.reason, /push-failed/);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].body).reason, "handover");
});

test("a node that is not the brain writes nothing at all", async () => {
  let wrote = false;
  const result = await runHandover({
    root: "/tmp/whatever",
    selfId: "mac",
    nowMs: NOW,
    env: {},
    fs: {
      readFileSync: () => JSON.stringify(LEASE),
      writeFileSync: () => { wrote = true; }
    },
    pushSoul: async () => { throw new Error("must not push"); }
  });

  assert.deepEqual(result, { handedOver: false, reason: "not-brain" });
  assert.equal(wrote, false);
});
